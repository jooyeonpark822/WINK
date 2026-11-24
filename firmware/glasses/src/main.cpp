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
constexpr size_t HEADER_SIZE = 9;

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
constexpr int SERVO1_PIN = D0;
constexpr int SERVO2_PIN = D1;
constexpr ledc_timer_t SERVO_TIMER = LEDC_TIMER_2;
constexpr ledc_channel_t SERVO1_CHANNEL = LEDC_CHANNEL_2;
constexpr ledc_channel_t SERVO2_CHANNEL = LEDC_CHANNEL_3;
constexpr int SERVO_MIN_US = 500;
constexpr int SERVO_MAX_US = 2400;
constexpr int SERVO_CENTER = 90;
constexpr int SERVO_SWING = 25;                  // 말할 때 가운데에서 좌우로 흔들리는 폭
constexpr uint32_t SERVO_SWING_PERIOD_MS = 600;  // 한 번 왕복하는 시간
constexpr uint32_t SERVO_UPDATE_MS = 15;
constexpr uint32_t SERVO_TEST_STEP_MS = 700;

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
StreamBufferHandle_t audioBuffer;

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

void servoWrite(ledc_channel_t channel, int angle) {
  angle = constrain(angle, 0, 180);
  uint32_t pulseUs = SERVO_MIN_US + (uint32_t)angle * (SERVO_MAX_US - SERVO_MIN_US) / 180;
  uint32_t duty = pulseUs * 16384UL / 20000UL;  // 14비트, 50Hz(20ms)
  ledc_set_duty(LEDC_LOW_SPEED_MODE, channel, duty);
  ledc_update_duty(LEDC_LOW_SPEED_MODE, channel);
}

void servoMoveBoth(int angle) {
  servoWrite(SERVO1_CHANNEL, angle);
  servoWrite(SERVO2_CHANNEL, angle);
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
  servoMoveBoth(SERVO_CENTER);
  Serial.println("Servo OK (D0, D1)");
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
    servoMoveBoth(SERVO_CENTER);
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

  if (servoTestStep >= 0) {  // TEST: 0 -> 90 -> 180 -> 90도
    const int steps[] = {0, 90, 180, 90};
    if (servoTestStepMs == 0 || now - servoTestStepMs >= SERVO_TEST_STEP_MS) {
      if (servoTestStep >= 4) {
        servoTestStep = -1;
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
  servoMoveBoth(SERVO_CENTER + (int)(SERVO_SWING * sinf(phase * TWO_PI)));
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

bool sendAll(const uint8_t* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    size_t n = bridge.write(data + sent, len - sent);
    if (n == 0) return false;
    sent += n;
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
void readControl() {
  while (bridge.connected() && bridge.available()) {
    char c = bridge.read();
    if (c == '\n') {
      controlLine[controlLen] = '\0';
      if (strcmp(controlLine, "DOWN") == 0) sendButton(1);
      else if (strcmp(controlLine, "UP") == 0 || strcmp(controlLine, "OFF") == 0) sendButton(0);
      else handleServoCommand(controlLine);  // 서보 명령(TALK 등)도 브릿지로 받을 수 있다
      controlLen = 0;
    } else if (c != '\r' && controlLen < sizeof(controlLine) - 1) {
      controlLine[controlLen++] = c;
    }
  }
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
  Serial.printf("[stats 10s] wifi=%s rssi=%d | mic read %lu B (ok~320000) dropped %lu B | audio sent %lu chunks (ok~100) | frames sent %lu failed %lu max %lums | bridge connects %lu\n",
                WiFi.status() == WL_CONNECTED ? "on" : "off", WiFi.RSSI(),
                (unsigned long)statMicBytes, (unsigned long)statMicDropped, (unsigned long)statAudioSent,
                (unsigned long)statFramesSent, (unsigned long)statFramesFailed, (unsigned long)statMaxFrameMs,
                (unsigned long)statBridgeConnects);
  statMicBytes = statMicDropped = 0;
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
