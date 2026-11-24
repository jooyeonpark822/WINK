#include <Arduino.h>
#include <ESP32Servo.h>

// 서보모터 물리 인터랙션 (보드에 올리는 코드)
// 목표: AI가 말할 때 서보모터가 움직인다.
//
// USB 시리얼(115200)로 한 줄짜리 명령을 받는다. (줄 끝은 \n)
//   TALK  : 말하는 동안 서보가 좌우로 살랑살랑 움직인다.
//   STOP  : 움직임을 멈추고 가운데(90도)로 돌아간다.
//   TEST  : 0 -> 90 -> 180 -> 90도로 한 번 왕복한다. (배선 확인용)
//   ANGLE n : 서보 두 개를 n도(0~180)로 바로 보낸다. (각도 확인용)
//   ANGLE1 n / ANGLE2 n : 서보 1(D0) 또는 서보 2(D1)만 n도로 보낸다. (어느 서보가 어느 쪽인지 확인용, 새 명령이라 팀 확인 필요)
// 시리얼 모니터에서 위 명령을 직접 쳐서 서보 없이도 흐름을 확인할 수 있다.

constexpr int SERVO_PIN = D0;          // 서보 1 신호선(주황/노랑)을 꽂을 핀. 배선이 다르면 여기만 고친다.
constexpr int SERVO2_PIN = D1;         // 서보 2 신호선을 꽂을 핀.
constexpr int CENTER_ANGLE = 90;       // 쉬는 자리
constexpr int SWING_ANGLE = 25;        // 말할 때 가운데에서 좌우로 흔들리는 폭
constexpr uint32_t SWING_PERIOD_MS = 600;  // 한 번 왕복하는 시간 (작을수록 빠르다)
constexpr uint32_t UPDATE_MS = 15;     // 서보 각도를 갱신하는 간격

Servo servo;
Servo servo2;
bool talking = false;
String line;

// 서보 두 개를 같은 각도로 보낸다.
void moveTo(int angle) {
  angle = constrain(angle, 0, 180);
  servo.write(angle);
  servo2.write(angle);
}

// 0 -> 90 -> 180 -> 90도. 움직이는 동안 잠깐 멈추는 방식이라 짧게만 쓴다.
void runTest() {
  const int steps[] = {0, 90, 180, 90};
  for (int a : steps) {
    moveTo(a);
    delay(700);
  }
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if (cmd == "TALK") {
    talking = true;
    Serial.println("OK TALK");
  } else if (cmd == "STOP") {
    talking = false;
    moveTo(CENTER_ANGLE);
    Serial.println("OK STOP");
  } else if (cmd == "TEST") {
    talking = false;
    runTest();
    Serial.println("OK TEST");
  } else if (cmd.startsWith("ANGLE1 ") || cmd.startsWith("ANGLE2 ")) {
    talking = false;
    int angle = constrain(cmd.substring(7).toInt(), 0, 180);
    (cmd[5] == '1' ? servo : servo2).write(angle);
    Serial.printf("OK ANGLE%c %d\n", cmd[5], angle);
  } else if (cmd.startsWith("ANGLE ")) {
    talking = false;
    int angle = cmd.substring(6).toInt();
    moveTo(angle);
    Serial.printf("OK ANGLE %d\n", constrain(angle, 0, 180));
  } else if (cmd.length() > 0) {
    Serial.println("ERR UNKNOWN");
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(line);
      line = "";
    } else if (c != '\r' && line.length() < 32) {
      line += c;
    }
  }
}

// 말하는 중이면 가운데를 기준으로 사인 곡선으로 부드럽게 좌우 흔든다.
void updateSwing() {
  static uint32_t lastUpdate = 0;
  uint32_t now = millis();
  if (now - lastUpdate < UPDATE_MS) return;
  lastUpdate = now;
  if (!talking) return;
  float phase = (now % SWING_PERIOD_MS) / (float)SWING_PERIOD_MS;
  moveTo(CENTER_ANGLE + (int)(SWING_ANGLE * sinf(phase * TWO_PI)));
}

void setup() {
  Serial.begin(115200);
  servo.setPeriodHertz(50);
  servo.attach(SERVO_PIN, 500, 2400);
  servo2.setPeriodHertz(50);
  servo2.attach(SERVO2_PIN, 500, 2400);
  moveTo(CENTER_ANGLE);
  Serial.println("READY");
}

void loop() {
  readSerial();
  updateSwing();
}
