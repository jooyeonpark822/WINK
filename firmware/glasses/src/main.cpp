#include <Arduino.h>
#include <ESP_I2S.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "driver/ledc.h"

// 브릿지 보드의 Soft AP에 접속하고, 카메라 이미지(초당 1장)와 마이크 소리를 계속 브릿지로 보낸다.
// 컨트롤러 버튼이 눌리면(HELP 신호) 노트북 서버에 버튼 눌림 프레임을 보낸다. (스트리밍은 멈추지 않는다)
// 접속 전: 내장 LED 계속 깜빡임 / 스트리밍 중: LED 켜짐
constexpr char AP_SSID[] = "Dating";
constexpr char AP_PASSWORD[] = "12345678";

// 브릿지 TCP 서버 (Soft AP의 게이트웨이 주소)
constexpr uint16_t BRIDGE_PORT = 8080;
constexpr uint32_t BRIDGE_RETRY_MS = 1000;
constexpr uint32_t FRAME_INTERVAL_MS = 2000;  // 2초에 1프레임 (사진을 보내는 동안 소리가 밀리지 않게 덜 자주 보낸다)
constexpr uint32_t WIFI_RECONNECT_MS = 5000;  // 이 시간 넘게 Wi-Fi가 안 붙으면 접속을 처음부터 다시 시도한다
constexpr uint32_t CAMERA_RETRY_MS = 5000;

// 전송 형식: 매직 4바이트 + 종류 1바이트 + 길이(uint32, little-endian) + 데이터
// server/frameParser.js와 같은 값을 써야 한다.
constexpr uint8_t FRAME_MAGIC[4] = {0xAA, 0x55, 0xA5, 0x5A};
constexpr uint8_t TYPE_VIDEO = 1;  // JPEG 한 장
constexpr uint8_t TYPE_AUDIO = 2;  // 16비트 PCM 조각 (모노, little-endian)
constexpr uint8_t TYPE_BUTTON = 3; // 컨트롤러 버튼 눌림 (데이터 1바이트)
constexpr uint8_t TYPE_SPEAKER = 4; // 노트북 -> 안경 스피커 소리 (16비트 PCM, 24kHz, 모노). 브릿지가 그대로 전달해 준다.
constexpr size_t HEADER_SIZE = 9;
constexpr uint32_t MAX_RX_PAYLOAD = 8192;  // 노트북이 보내는 프레임은 작다. 이보다 크면 잘못 읽은 것으로 보고 버린다

// 마이크 (XIAO ESP32S3 Sense 내장 PDM 마이크)
constexpr int MIC_CLK_PIN = 42;
constexpr int MIC_DATA_PIN = 41;
constexpr uint32_t MIC_SAMPLE_RATE = 16000;  // server/server.js의 AUDIO_SAMPLE_RATE와 같아야 한다
constexpr int MIC_GAIN = 4;                  // 소리가 작으면 올리고, 깨지면 내린다
constexpr size_t AUDIO_CHUNK_BYTES = 3200;   // 100ms 분량 (16000Hz x 2바이트 x 0.1초)
constexpr size_t AUDIO_BUFFER_BYTES = 49152; // 사진을 보내는 동안 소리가 사라지지 않게 약 1.5초까지 쌓는다 (전송이 풀리면 밀린 소리를 빠르게 보낸다)

// 내장 LED (GPIO21, 반전 로직: LOW = 켜짐)
constexpr uint8_t LED_PIN = 21;
constexpr uint32_t BLINK_HALF_PERIOD_MS = 250;

// 서보모터 2개 (신호선만 보드에 연결. 전원은 5V 핀, GND는 공통)
// 카메라가 PWM 타이머 0 / 채널 0을 쓰므로, 서보는 타이머 2 / 채널 2, 3을 직접 지정해서 서로 부딪히지 않게 한다.
// 명령(한 줄, 줄 끝 \n)은 USB 시리얼이나 브릿지로 받는다: TALK, STOP, TEST, ANGLE n, ANGLE1 n, ANGLE2 n
// 영점(STOP, 부팅, TEST가 끝났을 때): 틸트(D0, ANGLE1) = 0도, 팬(D1, ANGLE2) = 90도
constexpr int SERVO1_PIN = D0;
constexpr int SERVO2_PIN = D1;
constexpr ledc_timer_t SERVO_TIMER = LEDC_TIMER_2;
constexpr ledc_channel_t SERVO1_CHANNEL = LEDC_CHANNEL_2;
constexpr ledc_channel_t SERVO2_CHANNEL = LEDC_CHANNEL_3;
constexpr int SERVO_MIN_US = 500;
constexpr int SERVO_MAX_US = 2400;
constexpr int SERVO_CENTER = 90;                 // 팬(D1)의 영점(쉬는 자리)
constexpr int SERVO1_HOME = 0;                   // 틸트(D0)의 영점. 90도에서 반시계로 90도 돌린 위치이며 서보의 한쪽 끝이라 이 자리에서는 각도가 커지는 쪽으로만 움직인다.
constexpr int SERVO_SWING = 25;                  // 말할 때 영점에서 움직이는 폭 (팬은 좌우로, 틸트는 영점에서 한쪽으로)
constexpr uint32_t SERVO_SWING_PERIOD_MS = 600;  // 한 번 왕복하는 시간
constexpr uint32_t SERVO_UPDATE_MS = 15;
constexpr uint32_t SERVO_TEST_STEP_MS = 700;

// 날개 톱니 모터 (D2, 360도 연속 회전형 서보). 각도가 아니라 속도와 방향으로 제어한다.
// 펄스 폭이 정지 값(WING_NEUTRAL_US)이면 멈추고, 작으면 한 방향, 크면 반대 방향으로 돈다. 정지 값은 모터마다 조금 달라서 WING TRIM으로 맞춘다.
// 명령: WING n (n = -100~100, 0이면 정지), WING STOP, WING TRIM n (정지 값을 n마이크로초 옮김, -200~200)
constexpr int WING_PIN = D2;
constexpr ledc_channel_t WING_CHANNEL = LEDC_CHANNEL_4;
constexpr int WING_NEUTRAL_US = 1500;  // 정지 펄스 폭 (기본값. 서서히 도는 모터는 WING TRIM으로 맞춘다)
constexpr int WING_SPAN_US = 400;      // 속도 100일 때 정지 값에서 벗어나는 펄스 폭 (1100 ~ 1900us)

// 날개 모터를 "각도"로 움직이기: 이 모터에는 각도 센서가 없어서 돌린 시간으로 각도를 추정한다. (오래 돌리면 오차가 쌓이니 WING ZERO로 다시 맞춘다)
// 명령: WING SWING (영점에서 -90 <-> +90도를 계속 오감), WING TURN n (n도 돌고 멈춤), WING SPEED n (각도로 움직일 때 속도 10~100, 90도 시간은 속도에 반비례로 환산),
//       WING CAL ms (지금 속도에서 90도 도는 시간), WING ZERO (지금 위치를 0도로), WING HOME (추정 각도가 0이 되도록 돌아감), WING POS (추정 각도 출력)
// 양수 방향 = WING 양수 속도로 도는 방향이다.
constexpr int WING_ANGLE_SPEED = 50;          // 각도로 움직일 때 쓰는 기본 속도 (WING n의 n과 같은 크기). WING SPEED n으로 바꿀 수 있다
constexpr int WING_SWING_RANGE = 90;          // 영점에서 좌우로 오가는 각도
constexpr uint32_t WING_SWING_PAUSE_MS = 200; // 방향을 바꾸기 전에 잠깐 쉰다 (관성 때문에 더 돌지 않게)
constexpr uint32_t WING_DEFAULT_MS_PER_90 = 480;  // 기본 속도(50)에서 90도 도는 데 걸리는 시간의 처음 추정값. (속도 30에서 800ms로 맞춘 값을 속도 비율로 환산) WING CAL로 맞춘다

// 스피커 앰프 MAX98357A (I2S 출력). 앰프 SD-GAIN 핀은 비워 둔다.
// 마이크 I2S와 별개로 쓰는 출력이라 마이크 초기화 뒤에 만든다. 앰프는 좌우를 섞어 내보내서 양쪽에 같은 소리를 보낸다.
constexpr int SPK_BCLK_PIN = D3;
constexpr int SPK_LRC_PIN = D4;
constexpr int SPK_DIN_PIN = D5;
constexpr uint32_t SPK_SAMPLE_RATE = 24000;  // Gemini 대답 소리가 24kHz 16비트 모노라서 같은 값을 쓴다
constexpr float SPK_VOLUME = 0.25f;          // 0~1. 처음엔 낮게. 크게 하면 전류가 솟아 보드가 끊길 수 있다
constexpr size_t SPK_BUFFER_BYTES = 65536;   // 받은 소리를 쌓아 두는 곳 (약 1.4초). 서버가 재생 속도에 맞춰 보내서 보통 조금만 찬다
constexpr size_t SPK_CHUNK_SAMPLES = 480;    // 한 번에 스피커로 내보내는 양 (20ms)

// XIAO ESP32S3 Sense 카메라 핀
constexpr int CAM_PIN_PWDN = -1;
constexpr int CAM_PIN_RESET = -1;
constexpr int CAM_PIN_XCLK = 10;
constexpr int CAM_PIN_SIOD = 40;
constexpr int CAM_PIN_SIOC = 39;
constexpr int CAM_PIN_Y9 = 48;
constexpr int CAM_PIN_Y8 = 11;
constexpr int CAM_PIN_Y7 = 12;
constexpr int CAM_PIN_Y6 = 14;
constexpr int CAM_PIN_Y5 = 16;
constexpr int CAM_PIN_Y4 = 18;
constexpr int CAM_PIN_Y3 = 17;
constexpr int CAM_PIN_Y2 = 15;
constexpr int CAM_PIN_VSYNC = 38;
constexpr int CAM_PIN_HREF = 47;
constexpr int CAM_PIN_PCLK = 13;

bool ledOn = false;
uint32_t lastBlinkMs = 0;
uint32_t lastFrameMs = 0;
uint32_t lastCameraTryMs = 0;
uint32_t lastBridgeTryMs = 0;
bool cameraReady = false;
bool micReady = false;
bool streaming = false;  // 접속해 있으면 true
char controlLine[16];
size_t controlLen = 0;
WiFiClient bridge;
I2SClass i2s;
I2SClass i2sOut;  // 스피커 출력용
bool speakerReady = false;
StreamBufferHandle_t audioBuffer;
StreamBufferHandle_t spkBuffer;  // 스피커로 낼 소리 (모노 16비트)
volatile uint32_t statSpkBytes = 0;     // 스피커 버퍼에 받은 바이트
volatile uint32_t statSpkDropped = 0;   // 버퍼가 가득 차서 버린 바이트

// 진단용 통계 (10초마다 USB 시리얼에 출력. 브릿지로 가는 데이터에는 섞이지 않는다)
constexpr uint32_t STATS_INTERVAL_MS = 10000;
volatile uint32_t statMicBytes = 0;      // 마이크에서 읽은 바이트 (정상: 10초에 320000)
volatile uint32_t statMicDropped = 0;    // 버퍼가 가득 차서 버린 바이트 (전송이 밀린다는 신호)
uint32_t statAudioSent = 0;              // 브릿지로 보낸 소리 조각 수 (정상: 10초에 100)
uint32_t statFramesSent = 0;
uint32_t statFramesFailed = 0;
uint32_t statMaxFrameMs = 0;             // 사진 한 장을 보내는 데 걸린 가장 긴 시간
uint32_t statBridgeConnects = 0;         // 브릿지 TCP 연결 횟수 (자주 늘면 연결이 끊긴다는 신호)
uint32_t lastStatsMs = 0;

void setLed(bool on) {
  ledOn = on;
  digitalWrite(LED_PIN, on ? LOW : HIGH);
}

void writeHeader(uint8_t* out, uint8_t type, uint32_t len) {
  memcpy(out, FRAME_MAGIC, 4);
  out[4] = type;
  out[5] = len & 0xFF;
  out[6] = (len >> 8) & 0xFF;
  out[7] = (len >> 16) & 0xFF;
  out[8] = (len >> 24) & 0xFF;
}

// ---- 서보 ----
bool servoTalking = false;
int servoTestStep = -1;  // -1이면 TEST 중이 아님
uint32_t servoTestStepMs = 0;

int wingNeutralUs = WING_NEUTRAL_US;  // WING TRIM으로 바뀔 수 있는 현재 정지 값
int wingSpeed = 0;

void servoWritePulse(ledc_channel_t channel, uint32_t pulseUs) {
  uint32_t duty = pulseUs * 16384UL / 20000UL;  // 14비트, 50Hz(20ms)
  ledc_set_duty(LEDC_LOW_SPEED_MODE, channel, duty);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, channel);
}

void servoWrite(ledc_channel_t channel, int angle) {
  angle = constrain(angle, 0, 180);
  servoWritePulse(channel, SERVO_MIN_US + (uint32_t)angle * (SERVO_MAX_US - SERVO_MIN_US) / 180);
}

// 날개 모터: speed -100~100 (0 = 정지)
void wingSet(int speed) {
  wingSpeed = constrain(speed, -100, 100);
  servoWritePulse(WING_CHANNEL, wingNeutralUs + wingSpeed * WING_SPAN_US / 100);
}

// ---- 날개 모터를 각도로 움직이기 (시간으로 추정) ----
uint32_t wingMsPer90 = WING_DEFAULT_MS_PER_90;
int wingAngleSpeed = WING_ANGLE_SPEED;  // 지금 각도로 움직일 때 쓰는 속도
float wingPosDeg = 0;          // 영점에서 얼마나 돌았다고 추정하는 각도 (양수 방향이 +)
bool wingTurning = false;      // 지금 정해진 각도만큼 도는 중
int wingTurnDir = 0;           // +1 / -1
int wingTurnDeg = 0;           // 이번에 돌 각도(양수)
uint32_t wingTurnStartMs = 0;
uint32_t wingTurnEndMs = 0;
bool wingSwinging = false;     // -90 <-> +90 오가기 중
int wingSwingNext = -WING_SWING_RANGE;  // 다음 목표 각도
uint32_t wingPauseUntilMs = 0;

void wingStartTurn(int deg) {
  if (deg == 0) return;
  wingTurnDir = deg > 0 ? 1 : -1;
  wingTurnDeg = abs(deg);
  wingTurnStartMs = millis();
  wingTurnEndMs = wingTurnStartMs + (uint32_t)((float)wingTurnDeg * wingMsPer90 / 90.0f);
  wingTurning = true;
  wingSet(wingTurnDir * wingAngleSpeed);
}

// 도는 중이면 지금까지 돈 만큼을 추정 각도에 반영하고 멈춘다. 오가기도 끈다.
void wingAbort() {
  if (wingTurning) {
    uint32_t total = wingTurnEndMs - wingTurnStartMs;
    float frac = total ? (float)(millis() - wingTurnStartMs) / (float)total : 1.0f;
    wingPosDeg += wingTurnDir * wingTurnDeg * constrain(frac, 0.0f, 1.0f);
    wingTurning = false;
  }
  wingSwinging = false;
  wingSet(0);
}

void updateWing() {
  uint32_t now = millis();
  if (wingTurning && (int32_t)(now - wingTurnEndMs) >= 0) {
    wingPosDeg += wingTurnDir * wingTurnDeg;
    wingTurning = false;
    wingSet(0);
    wingPauseUntilMs = now + WING_SWING_PAUSE_MS;
  }
  if (wingSwinging && !wingTurning && (int32_t)(now - wingPauseUntilMs) >= 0) {
    wingStartTurn(wingSwingNext - (int)lroundf(wingPosDeg));
    wingSwingNext = -wingSwingNext;
  }
}

void servoMoveBoth(int angle) {
  servoWrite(SERVO1_CHANNEL, angle);
  servoWrite(SERVO2_CHANNEL, angle);
}

// 두 서보를 각자의 영점으로 보낸다. 틸트(D0)는 SERVO1_HOME, 팬(D1)은 SERVO_CENTER.
void servoHome() {
  servoWrite(SERVO1_CHANNEL, SERVO1_HOME);
  servoWrite(SERVO2_CHANNEL, SERVO_CENTER);
}

void initServos() {
  ledc_timer_config_t timer = {};
  timer.speed_mode = LEDC_LOW_SPEED_MODE;
  timer.duty_resolution = LEDC_TIMER_14_BIT;
  timer.timer_num = SERVO_TIMER;
  timer.freq_hz = 50;
  timer.clk_cfg = LEDC_AUTO_CLK;
  ledc_timer_config(&timer);

  const int pins[2] = {SERVO1_PIN, SERVO2_PIN};
  const ledc_channel_t channels[2] = {SERVO1_CHANNEL, SERVO2_CHANNEL};
  for (int i = 0; i < 2; i++) {
    ledc_channel_config_t ch = {};
    ch.gpio_num = pins[i];
    ch.speed_mode = LEDC_LOW_SPEED_MODE;
    ch.channel = channels[i];
    ch.timer_sel = SERVO_TIMER;
    ch.duty = 0;
    ch.hpoint = 0;
    ledc_channel_config(&ch);
  }
  servoHome();

  ledc_channel_config_t wing = {};  // 날개 모터(D2)는 같은 타이머 2를 쓰고 채널 4를 쓴다
  wing.gpio_num = WING_PIN;
  wing.speed_mode = LEDC_LOW_SPEED_MODE;
  wing.channel = WING_CHANNEL;
  wing.timer_sel = SERVO_TIMER;
  wing.duty = 0;
  wing.hpoint = 0;
  ledc_channel_config(&wing);
  wingSet(0);
  Serial.println("Servo OK (D0, D1, wing D2)");
}

// ---- 스피커 ----
// 소리를 스피커로 내는 곳은 이 태스크 하나뿐이다. (BEEP도, 노트북이 보낸 소리 프레임도 spkBuffer에 넣으면 여기서 나온다)
// 버퍼가 비면 무음을 계속 내보내서 스피커에서 지지직 소리가 나지 않게 한다.
void speakerTask(void*) {
  static int16_t in[SPK_CHUNK_SAMPLES];
  static int16_t out[SPK_CHUNK_SAMPLES * 2];  // 왼쪽/오른쪽 같은 값
  uint8_t carry = 0;                          // 16비트가 2바이트씩 안 맞게 들어온 경우 남는 1바이트
  bool hasCarry = false;
  for (;;) {
    uint8_t* dst = (uint8_t*)in;
    size_t offset = 0;
    if (hasCarry) { dst[0] = carry; offset = 1; hasCarry = false; }
    size_t n = xStreamBufferReceive(spkBuffer, dst + offset, sizeof(in) - offset, pdMS_TO_TICKS(20)) + offset;
    if (n & 1) { carry = dst[n - 1]; hasCarry = true; n--; }
    size_t samples = n / 2;
    if (samples == 0) {
      memset(out, 0, sizeof(out));
      i2sOut.write((uint8_t*)out, sizeof(out));  // 20ms 무음
      continue;
    }
    for (size_t i = 0; i < samples; i++) {
      int16_t v = (int16_t)(in[i] * SPK_VOLUME);
      out[i * 2] = v;
      out[i * 2 + 1] = v;
    }
    i2sOut.write((uint8_t*)out, samples * 4);
  }
}

bool initSpeaker() {
  spkBuffer = xStreamBufferCreate(SPK_BUFFER_BYTES, 1);
  if (!spkBuffer) {
    Serial.println("Speaker buffer failed");
    return false;
  }
  i2sOut.setPins(SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN);
  if (!i2sOut.begin(I2S_MODE_STD, SPK_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
    Serial.println("Speaker init failed");
    return false;
  }
  xTaskCreatePinnedToCore(speakerTask, "speaker", 4096, nullptr, 2, nullptr, 0);
  Serial.printf("Speaker OK (BCLK=%d LRC=%d DIN=%d, %luHz)\n", SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN, (unsigned long)SPK_SAMPLE_RATE);
  return true;
}

// 시험음: 880Hz를 0.4초. 시작과 끝을 부드럽게 올리고 내려서 "딱" 소리가 나지 않게 한다.
// 음량은 speakerTask가 SPK_VOLUME으로 줄이므로 여기서는 최대 크기로 만든다.
void playBeep() {
  const uint32_t total = SPK_SAMPLE_RATE * 4 / 10;
  const uint32_t ramp = SPK_SAMPLE_RATE / 50;  // 20ms
  static int16_t buf[SPK_SAMPLE_RATE * 4 / 10];
  for (uint32_t k = 0; k < total; k++) {
    float env = 1.0f;
    if (k < ramp) env = (float)k / ramp;
    else if (k > total - ramp) env = (float)(total - k) / ramp;
    buf[k] = (int16_t)(sinf(TWO_PI * 880.0f * k / SPK_SAMPLE_RATE) * 32767.0f * env);
  }
  xStreamBufferSend(spkBuffer, buf, sizeof(buf), pdMS_TO_TICKS(100));
}

// 명령 한 줄을 처리한다. 서보 명령이면 true.
bool handleServoCommand(const char* line) {
  char cmd[24];
  size_t n = 0;
  for (; line[n] && n < sizeof(cmd) - 1; n++) cmd[n] = toupper((unsigned char)line[n]);
  cmd[n] = '\0';

  if (strcmp(cmd, "TALK") == 0) {
    servoTalking = true;
    servoTestStep = -1;
    Serial.println("OK TALK");
  } else if (strcmp(cmd, "STOP") == 0) {
    servoTalking = false;
    servoTestStep = -1;
    servoHome();
    Serial.println("OK STOP");
  } else if (strcmp(cmd, "TEST") == 0) {
    servoTalking = false;
    servoTestStep = 0;
    servoTestStepMs = 0;  // 다음 loop에서 바로 시작
    Serial.println("OK TEST");
  } else if (strncmp(cmd, "ANGLE1 ", 7) == 0 || strncmp(cmd, "ANGLE2 ", 7) == 0) {
    servoTalking = false;
    servoTestStep = -1;
    int angle = constrain(atoi(cmd + 7), 0, 180);
    servoWrite(cmd[5] == '1' ? SERVO1_CHANNEL : SERVO2_CHANNEL, angle);
    Serial.printf("OK ANGLE%c %d\n", cmd[5], angle);
  } else if (strncmp(cmd, "ANGLE ", 6) == 0) {
    servoTalking = false;
    servoTestStep = -1;
    int angle = constrain(atoi(cmd + 6), 0, 180);
    servoMoveBoth(angle);
    Serial.printf("OK ANGLE %d\n", angle);
  } else if (strcmp(cmd, "WING STOP") == 0) {
    wingAbort();
    Serial.println("OK WING STOP");
  } else if (strcmp(cmd, "WING SWING") == 0) {
    wingAbort();
    wingSwinging = true;
    wingSwingNext = -WING_SWING_RANGE;  // 처음에는 -90도 쪽으로
    wingPauseUntilMs = 0;
    Serial.printf("OK WING SWING (-%d <-> +%d도, 90도당 %lums)\n", WING_SWING_RANGE, WING_SWING_RANGE, (unsigned long)wingMsPer90);
  } else if (strncmp(cmd, "WING TURN ", 10) == 0) {
    wingAbort();
    int deg = atoi(cmd + 10);
    wingStartTurn(deg);
    Serial.printf("OK WING TURN %d\n", deg);
  } else if (strncmp(cmd, "WING SPEED ", 11) == 0) {
    wingAbort();
    int sp = constrain(atoi(cmd + 11), 10, 100);
    wingMsPer90 = constrain((uint32_t)((uint64_t)wingMsPer90 * wingAngleSpeed / sp), 50, 5000);  // 속도에 반비례로 환산
    wingAngleSpeed = sp;
    Serial.printf("OK WING SPEED %d (90도당 %lums)\n", wingAngleSpeed, (unsigned long)wingMsPer90);
  } else if (strncmp(cmd, "WING CAL ", 9) == 0) {
    wingMsPer90 = constrain(atoi(cmd + 9), 50, 5000);
    Serial.printf("OK WING CAL %lums/90도\n", (unsigned long)wingMsPer90);
  } else if (strcmp(cmd, "WING HOME") == 0) {
    wingAbort();  // 오가기를 끝내고, 추정 각도가 영점이 되도록 반대로 돌아간다
    int back = -(int)lroundf(wingPosDeg);
    wingStartTurn(back);
    Serial.printf("OK WING HOME (%d도 돌아감)\n", back);
  } else if (strcmp(cmd, "WING ZERO") == 0) {
    wingAbort();
    wingPosDeg = 0;
    Serial.println("OK WING ZERO");
  } else if (strcmp(cmd, "WING POS") == 0) {
    Serial.printf("OK WING POS %d도\n", (int)lroundf(wingPosDeg));
  } else if (strncmp(cmd, "WING TRIM ", 10) == 0) {
    wingNeutralUs = constrain(wingNeutralUs + atoi(cmd + 10), WING_NEUTRAL_US - 200, WING_NEUTRAL_US + 200);
    wingSet(wingSpeed);
    Serial.printf("OK WING TRIM neutral=%dus\n", wingNeutralUs);
  } else if (strncmp(cmd, "WING ", 5) == 0) {
    wingAbort();  // 속도로 직접 돌릴 때는 각도로 움직이는 동작을 끈다
    wingSet(atoi(cmd + 5));
    Serial.printf("OK WING %d\n", wingSpeed);
  } else if (strcmp(cmd, "BEEP") == 0) {
    if (speakerReady) {
      playBeep();
      Serial.println("OK BEEP");
    } else {
      Serial.println("ERR SPEAKER");
    }
  } else {
    return false;
  }
  return true;
}

// USB 시리얼로 들어온 명령을 읽는다. (시험용)
void readServoSerial() {
  static char line[24];
  static size_t len = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line[len] = '\0';
      if (len > 0 && !handleServoCommand(line)) Serial.println("ERR UNKNOWN");
      len = 0;
    } else if (c != '\r' && len < sizeof(line) - 1) {
      line[len++] = c;
    }
  }
}

// 멈추지 않고(delay 없이) 서보를 움직인다. 소리와 사진 전송이 끊기지 않게 loop마다 조금씩만 처리한다.
void updateServos() {
  uint32_t now = millis();
  updateWing();

  if (servoTestStep >= 0) {  // TEST: 0 -> 90 -> 180 -> 90도
    const int steps[] = {0, 90, 180, 90};
    if (servoTestStepMs == 0 || now - servoTestStepMs >= SERVO_TEST_STEP_MS) {
      if (servoTestStep >= 4) {
        servoTestStep = -1;
        servoHome();  // 시험이 끝나면 영점으로
      } else {
        servoMoveBoth(steps[servoTestStep++]);
        servoTestStepMs = now ? now : 1;
      }
    }
    return;
  }

  static uint32_t lastUpdate = 0;
  if (now - lastUpdate < SERVO_UPDATE_MS) return;
  lastUpdate = now;
  if (!servoTalking) return;
  float phase = (now % SERVO_SWING_PERIOD_MS) / (float)SERVO_SWING_PERIOD_MS;
  float wave = sinf(phase * TWO_PI);
  servoWrite(SERVO2_CHANNEL, SERVO_CENTER + (int)(SERVO_SWING * wave));                  // 팬: 가운데에서 좌우로
  servoWrite(SERVO1_CHANNEL, SERVO1_HOME + (int)(SERVO_SWING * (0.5f + 0.5f * wave)));   // 틸트: 영점(0도)에서 0 ~ SERVO_SWING도
}

bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_PIN_Y2;
  config.pin_d1 = CAM_PIN_Y3;
  config.pin_d2 = CAM_PIN_Y4;
  config.pin_d3 = CAM_PIN_Y5;
  config.pin_d4 = CAM_PIN_Y6;
  config.pin_d5 = CAM_PIN_Y7;
  config.pin_d6 = CAM_PIN_Y8;
  config.pin_d7 = CAM_PIN_Y9;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;  // 640x480
  config.jpeg_quality = 16;           // 낮을수록 화질이 좋고 용량이 큼 (용량을 줄여 전송 시간을 짧게)
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  Serial.println("Camera OK (VGA JPEG)");
  return true;
}

// 마이크를 계속 읽어서 스트림 버퍼에 쌓는다. 카메라 전송이 오래 걸려도 소리가 끊기지 않게 별도 태스크로 돈다.
void audioTask(void*) {
  int16_t samples[512];
  for (;;) {
    size_t n = i2s.readBytes((char*)samples, sizeof(samples));
    n &= ~(size_t)1;  // 샘플(2바이트) 단위로만 다룬다
    if (n == 0) continue;

    for (size_t i = 0; i < n / 2; i++) {
      int32_t v = (int32_t)samples[i] * MIC_GAIN;
      samples[i] = (int16_t)constrain(v, -32768, 32767);
    }
    statMicBytes += n;
    if (xStreamBufferSpacesAvailable(audioBuffer) >= n) {  // 가득 차면 이번 조각은 버린다
      xStreamBufferSend(audioBuffer, samples, n, 0);
    } else {
      statMicDropped += n;
    }
  }
}

bool initMic() {
  audioBuffer = xStreamBufferCreate(AUDIO_BUFFER_BYTES, 1);
  if (!audioBuffer) return false;

  i2s.setPinsPdmRx(MIC_CLK_PIN, MIC_DATA_PIN);
  if (!i2s.begin(I2S_MODE_PDM_RX, MIC_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    Serial.println("Mic init failed");
    return false;
  }
  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 2, nullptr, 0);
  Serial.printf("Mic OK (PDM CLK=%d DATA=%d, %luHz mono 16bit)\n", MIC_CLK_PIN, MIC_DATA_PIN, (unsigned long)MIC_SAMPLE_RATE);
  return true;
}

void pumpIncoming();  // 아래에 있다

// 큰 데이터(사진)를 보내는 동안에도 받는 쪽을 틈틈이 읽는다.
// 안 그러면 브릿지가 노트북 소리를 안경에 보내려고 기다리고, 안경은 사진을 브릿지에 보내려고 기다리며 서로 멈춘다.
bool sendAll(const uint8_t* data, size_t len) {
  constexpr size_t PIECE = 1460;  // TCP 한 조각 크기
  size_t sent = 0;
  while (sent < len) {
    size_t n = bridge.write(data + sent, min(len - sent, PIECE));
    if (n == 0) return false;
    sent += n;
    pumpIncoming();  // 소리 프레임은 버퍼에 쌓고, 글자 줄은 큐에 둔다. (여기서는 브릿지로 아무것도 보내지 않는다)
  }
  return true;
}

bool connectBridge() {
  if (bridge.connected()) return true;
  if (millis() - lastBridgeTryMs < BRIDGE_RETRY_MS) return false;  // 너무 자주 시도하지 않는다
  lastBridgeTryMs = millis();

  bridge.stop();
  if (!bridge.connect(WiFi.gatewayIP(), BRIDGE_PORT, 2000)) {
    Serial.printf("Bridge TCP connect failed (%s:%u)\n", WiFi.gatewayIP().toString().c_str(), BRIDGE_PORT);
    return false;
  }
  bridge.setNoDelay(true);
  statBridgeConnects++;
  Serial.printf("Bridge TCP connected (%s:%u)\n", WiFi.gatewayIP().toString().c_str(), BRIDGE_PORT);
  return true;
}

void sendFrame() {
  if (!connectBridge()) return;

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  uint8_t header[HEADER_SIZE];
  writeHeader(header, TYPE_VIDEO, fb->len);

  uint32_t startMs = millis();
  bool ok = sendAll(header, sizeof(header)) && sendAll(fb->buf, fb->len);
  uint32_t tookMs = millis() - startMs;
  esp_camera_fb_return(fb);
  if (tookMs > statMaxFrameMs) statMaxFrameMs = tookMs;

  if (ok) {
    statFramesSent++;
  } else {
    statFramesFailed++;
    Serial.printf("Frame send failed after %lums\n", (unsigned long)tookMs);
    bridge.stop();
  }
}

// 쌓인 마이크 데이터를 100ms 조각으로 보낸다. 브릿지에 못 보내면 조각을 버려서 소리가 밀리지 않게 한다.
void sendAudio() {
  static uint8_t packet[HEADER_SIZE + AUDIO_CHUNK_BYTES];

  while (xStreamBufferBytesAvailable(audioBuffer) >= AUDIO_CHUNK_BYTES) {
    xStreamBufferReceive(audioBuffer, packet + HEADER_SIZE, AUDIO_CHUNK_BYTES, 0);
    if (!connectBridge()) continue;

    writeHeader(packet, TYPE_AUDIO, AUDIO_CHUNK_BYTES);
    if (sendAll(packet, sizeof(packet))) statAudioSent++;
    else bridge.stop();
  }
}

// 컨트롤러 버튼을 눌렀다(1)/뗐다(0)는 걸 노트북 서버에 알린다. 영상/소리와 같은 loop에서 보내서 프레임이 섞이지 않는다.
void sendButton(uint8_t pressed) {
  if (!connectBridge()) return;
  uint8_t packet[HEADER_SIZE + 1];
  writeHeader(packet, TYPE_BUTTON, 1);
  packet[HEADER_SIZE] = pressed;
  if (sendAll(packet, sizeof(packet))) {
    Serial.printf("Button frame sent (%s)\n", pressed ? "down" : "up");
  } else {
    bridge.stop();
  }
}

void setStreaming(bool on) {
  if (on == streaming) return;
  streaming = on;
  setLed(on);  // 스트리밍 중일 때만 LED 켜짐
  if (on) {
    lastFrameMs = 0;  // 첫 프레임을 바로 보낸다
    if (micReady) xStreamBufferReset(audioBuffer);  // 오래된 소리는 버린다
  }
  Serial.println(on ? "Streaming ON" : "Streaming OFF");
}

// 컨트롤러가 브릿지를 거쳐 보낸 줄을 읽는다: "DOWN"(버튼 누름), "UP"(버튼 뗌).
// 컨트롤러 접속이 끊기면 브릿지가 "OFF"를 보낸다. 누른 채로 끊겼을 수 있으니 "뗌"으로 처리해서 서버가 계속 듣지 않게 한다.
// (안경은 계속 스트리밍하므로 OFF로 스트리밍을 끄지는 않는다)
//
// 같은 연결로 노트북이 보낸 소리 프레임도 들어온다: [AA 55 A5 5A] [종류 1바이트] [길이 4바이트, little-endian] [데이터]
// 종류 4(스피커 소리)면 데이터를 spkBuffer에 넣는다. 글자 줄은 0xAA로 시작하지 않아서 줄 맨 앞의 0xAA를 프레임 시작으로 본다.
// 받은 글자 줄은 바로 처리하지 않고 큐에 둔다. 처리하다가 브릿지로 보내는 일(버튼 프레임)이 생기는데,
// 사진을 보내는 도중에 끼어들면 프레임이 섞이기 때문이다. 큐는 runQueuedCommands()가 loop에서 비운다.
constexpr size_t CMD_QUEUE_SIZE = 8;
char cmdQueue[CMD_QUEUE_SIZE][sizeof(controlLine)];
size_t cmdHead = 0;  // 다음에 넣을 자리
size_t cmdTail = 0;  // 다음에 꺼낼 자리

void queueCommand(const char* line) {
  size_t next = (cmdHead + 1) % CMD_QUEUE_SIZE;
  if (next == cmdTail) return;  // 가득 차면 버린다
  strncpy(cmdQueue[cmdHead], line, sizeof(controlLine) - 1);
  cmdQueue[cmdHead][sizeof(controlLine) - 1] = '\0';
  cmdHead = next;
}

void runQueuedCommands() {
  while (cmdTail != cmdHead) {
    const char* line = cmdQueue[cmdTail];
    if (strcmp(line, "DOWN") == 0) sendButton(1);
    else if (strcmp(line, "UP") == 0 || strcmp(line, "OFF") == 0) sendButton(0);
    else handleServoCommand(line);  // 서보 명령(TALK 등)도 브릿지로 받을 수 있다
    cmdTail = (cmdTail + 1) % CMD_QUEUE_SIZE;
  }
}

void pumpIncoming() {
  enum { RX_LINE, RX_HEADER, RX_PAYLOAD };
  static int state = RX_LINE;
  static uint8_t header[HEADER_SIZE];
  static size_t headerLen = 0;
  static uint32_t payloadLeft = 0;
  static uint8_t frameType = 0;

  while (bridge.connected() && bridge.available()) {
    if (state == RX_PAYLOAD) {  // 데이터는 한꺼번에 읽는다
      uint8_t buf[512];
      int n = bridge.read(buf, min((size_t)payloadLeft, min((size_t)bridge.available(), sizeof(buf))));
      if (n <= 0) break;
      if (frameType == TYPE_SPEAKER && speakerReady) {
        if (xStreamBufferSpacesAvailable(spkBuffer) >= (size_t)n) {  // 가득 차면 이번 조각은 버린다
          xStreamBufferSend(spkBuffer, buf, n, 0);
          statSpkBytes += n;
        } else {
          statSpkDropped += n;
        }
      }
      payloadLeft -= n;
      if (payloadLeft == 0) state = RX_LINE;
      continue;
    }

    uint8_t c = bridge.read();
    if (state == RX_HEADER) {
      header[headerLen++] = c;
      if (headerLen <= 4 && c != FRAME_MAGIC[headerLen - 1]) {  // 프레임이 아니었다
        state = RX_LINE;
        continue;
      }
      if (headerLen == HEADER_SIZE) {
        frameType = header[4];
        uint32_t len = header[5] | (header[6] << 8) | (header[7] << 16) | ((uint32_t)header[8] << 24);
        if (len == 0 || len > MAX_RX_PAYLOAD) {
          state = RX_LINE;  // 이상한 길이는 버리고 다시 맞춘다
        } else {
          payloadLeft = len;
          state = RX_PAYLOAD;
        }
      }
      continue;
    }

    if (c == FRAME_MAGIC[0] && controlLen == 0) {  // 소리 프레임의 시작일 수 있다
      header[0] = c;
      headerLen = 1;
      state = RX_HEADER;
    } else if (c == '\n') {
      controlLine[controlLen] = '\0';
      queueCommand(controlLine);
      controlLen = 0;
    } else if (c != '\r' && controlLen < sizeof(controlLine) - 1) {
      controlLine[controlLen++] = c;
    }
  }
}

// loop에서 부르는 함수: 들어온 것을 읽고, 쌓인 글자 명령을 처리한다.
void readControl() {
  pumpIncoming();
  runQueuedCommands();
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // USB에 모니터가 없어도(배터리 전원) 출력 때문에 멈추지 않게 한다
  pinMode(LED_PIN, OUTPUT);
  setLed(false);

  initServos();
  cameraReady = initCamera();
  lastCameraTryMs = millis();
  micReady = initMic();
  speakerReady = initSpeaker();  // 마이크 I2S를 먼저 잡은 뒤에 스피커 I2S를 만든다

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);         // 전송 지연을 줄이기 위해 절전 끔
  WiFi.setAutoReconnect(true);  // 끊기면 자동으로 다시 접속
  // 접속 실패/끊김 이유를 남긴다. 예) 201 = Dating을 못 찾음(브릿지 꺼짐), 15/204 = 비밀번호 불일치
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    static uint32_t lastMs = 0;
    static uint8_t lastReason = 0;
    uint8_t reason = info.wifi_sta_disconnected.reason;
    if (reason != lastReason || millis() - lastMs >= 5000) {  // 같은 이유는 5초에 한 번만
      Serial.printf("Wi-Fi disconnected from %s, reason=%u\n", AP_SSID, reason);
      lastReason = reason;
      lastMs = millis();
    }
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.begin(AP_SSID, AP_PASSWORD);
  Serial.printf("Wi-Fi connecting to %s...\n", AP_SSID);
}

// 10초마다: 마이크가 모은 양 vs 실제로 보낸 양. 둘 다 정상이면 안경 쪽은 문제없다.
void printStats() {
  if (millis() - lastStatsMs < STATS_INTERVAL_MS) return;
  lastStatsMs = millis();
  Serial.printf("[stats 10s] wifi=%s rssi=%d | mic read %lu B (ok~320000) dropped %lu B | audio sent %lu chunks (ok~100) | frames sent %lu failed %lu max %lums | bridge connects %lu | spk recv %lu B dropped %lu B\n",
                WiFi.status() == WL_CONNECTED ? "on" : "off", WiFi.RSSI(),
                (unsigned long)statMicBytes, (unsigned long)statMicDropped, (unsigned long)statAudioSent,
                (unsigned long)statFramesSent, (unsigned long)statFramesFailed, (unsigned long)statMaxFrameMs,
                (unsigned long)statBridgeConnects,
                (unsigned long)statSpkBytes, (unsigned long)statSpkDropped);
  statMicBytes = statMicDropped = statSpkBytes = statSpkDropped = 0;
  statAudioSent = statFramesSent = statFramesFailed = statMaxFrameMs = statBridgeConnects = 0;
}

void loop() {
  readServoSerial();
  updateServos();

  static bool wasConnected = false;
  bool connected = WiFi.status() == WL_CONNECTED;

  if (connected) {
    if (!wasConnected) {
      Serial.printf("Connected to %s, IP=%s, bridge(gateway)=%s, RSSI=%d\n", AP_SSID, WiFi.localIP().toString().c_str(),
                    WiFi.gatewayIP().toString().c_str(), WiFi.RSSI());
      setStreaming(true);  // 접속하면 바로 스트리밍을 시작하고 LED를 켠다
    }
    connectBridge();  // 컨트롤러 신호를 받으려면 평소에도 브릿지에 붙어 있어야 한다
    readControl();
  } else {
    if (wasConnected) {
      Serial.println("Disconnected, reconnecting...");
      bridge.stop();
    }
    streaming = false;
    // 접속이 오래 안 되면(브릿지가 재시작된 직후 등) 처음부터 다시 접속한다.
    static uint32_t downSinceMs = 0;
    if (wasConnected || downSinceMs == 0) downSinceMs = millis();
    if (millis() - downSinceMs >= WIFI_RECONNECT_MS) {
      downSinceMs = millis();
      WiFi.disconnect();
      WiFi.begin(AP_SSID, AP_PASSWORD);
    }
    if (millis() - lastBlinkMs >= BLINK_HALF_PERIOD_MS) {
      lastBlinkMs = millis();
      setLed(!ledOn);
    }
    if (micReady) xStreamBufferReset(audioBuffer);  // 연결 전 소리는 오래된 것이니 버린다
  }
  wasConnected = connected;

  if (!cameraReady && millis() - lastCameraTryMs >= CAMERA_RETRY_MS) {
    lastCameraTryMs = millis();
    cameraReady = initCamera();
  }

  if (connected && micReady) {
    if (streaming) {
      sendAudio();
    } else {
      xStreamBufferReset(audioBuffer);  // 스트리밍하지 않는 동안의 소리는 버린다
    }
  }

  if (connected && streaming && cameraReady && millis() - lastFrameMs >= FRAME_INTERVAL_MS) {
    lastFrameMs = millis();
    sendFrame();
  }

  printStats();
}
