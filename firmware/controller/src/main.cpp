#include <Arduino.h>
#include <WiFi.h>

// 브릿지 보드의 Soft AP에 접속하고, 버튼을 누르는 순간 "DOWN\n", 떼는 순간 "UP\n" 한 줄을 보낸다. (누르고 있는 동안만 WINK가 듣는다)
// 신호는 브릿지의 제어 포트(8081)로 가고, 브릿지가 안경 보드에 전달하고, 안경 보드가 노트북 서버에 알린다.
// 서버는 DOWN을 받으면 듣기 시작하고, UP을 받으면 듣기를 끝내고 Gemini의 답을 기다린다.
// 연결 전: 내장 LED 계속 깜빡임 / 연결 후: LED 켜진 상태로 고정
constexpr char AP_SSID[] = "Dating";
constexpr char AP_PASSWORD[] = "12345678";

constexpr uint16_t BRIDGE_CONTROL_PORT = 8081;  // firmware/bridge의 CONTROL_PORT와 같아야 한다
constexpr uint32_t BRIDGE_RETRY_MS = 1000;
constexpr uint32_t DOWN_RETRY_WINDOW_MS = 1500;  // 연결이 잠깐 끊겼을 때 이 시간 안이면 "누름" 신호를 다시 보낸다 (뗌 신호는 반드시 보낸다)
constexpr size_t EVENT_QUEUE_SIZE = 8;

// 버튼: 조이스틱의 SW 핀(D4). 누르면 GND와 연결되어 LOW (내부 풀업 사용)
constexpr uint8_t BUTTON_PIN = D4;
constexpr uint32_t DEBOUNCE_MS = 20;

// 내장 LED (GPIO21, 반전 로직: LOW = 켜짐)
constexpr uint8_t LED_PIN = 21;
constexpr uint32_t BLINK_HALF_PERIOD_MS = 250;

bool ledOn = false;
uint32_t lastBlinkMs = 0;
uint32_t lastBridgeTryMs = 0;
bool buttonPressed = false;      // 디바운스를 거친 현재 상태
bool lastRawPressed = false;
uint32_t rawChangedMs = 0;
WiFiClient bridge;

// 아직 못 보낸 버튼 사건 (순서를 지켜서 보낸다). 'D' = 누름, 'U' = 뗌
struct ButtonEvent {
  char type;
  uint32_t atMs;
};
ButtonEvent eventQueue[EVENT_QUEUE_SIZE];
size_t eventCount = 0;

void setLed(bool on) {
  ledOn = on;
  digitalWrite(LED_PIN, on ? LOW : HIGH);
}

bool connectBridge() {
  if (bridge.connected()) return true;
  if (millis() - lastBridgeTryMs < BRIDGE_RETRY_MS) return false;
  lastBridgeTryMs = millis();

  bridge.stop();
  if (!bridge.connect(WiFi.gatewayIP(), BRIDGE_CONTROL_PORT, 2000)) {
    Serial.println("Bridge TCP connect failed");
    return false;
  }
  bridge.setNoDelay(true);
  return true;
}

void pushEvent(char type);

void updateButton() {
  bool raw = digitalRead(BUTTON_PIN) == LOW;
  if (raw != lastRawPressed) {
    lastRawPressed = raw;
    rawChangedMs = millis();
  }
  if (raw != buttonPressed && millis() - rawChangedMs >= DEBOUNCE_MS) {
    buttonPressed = raw;
    Serial.println(buttonPressed ? "Button pressed" : "Button released");
    pushEvent(buttonPressed ? 'D' : 'U');  // 누를 때도, 뗄 때도 알린다
  }
}

void pushEvent(char type) {
  if (eventCount == EVENT_QUEUE_SIZE) {  // 가득 차면 가장 오래된 것을 버린다
    memmove(eventQueue, eventQueue + 1, sizeof(ButtonEvent) * (EVENT_QUEUE_SIZE - 1));
    eventCount--;
  }
  eventQueue[eventCount++] = {type, millis()};
}

void popEvent() {
  memmove(eventQueue, eventQueue + 1, sizeof(ButtonEvent) * (eventCount - 1));
  eventCount--;
}

// 쌓인 버튼 사건을 순서대로 보낸다. 연결이 안 되면 다음 loop에서 다시 시도한다.
// 너무 오래된 "누름"은 버리고(이미 끝난 눌림으로 듣기를 시작하면 안 되므로), "뗌"은 반드시 보낸다.
void sendEvents() {
  while (eventCount > 0) {
    ButtonEvent& e = eventQueue[0];
    if (e.type == 'D' && millis() - e.atMs > DOWN_RETRY_WINDOW_MS) {
      popEvent();
      continue;
    }
    if (!connectBridge()) return;

    const char* msg = e.type == 'D' ? "DOWN\n" : "UP\n";
    if (bridge.write((const uint8_t*)msg, strlen(msg)) > 0) {
      Serial.printf("%s sent\n", e.type == 'D' ? "DOWN" : "UP");
      popEvent();
    } else {
      bridge.stop();  // 다음 loop에서 다시 연결하고 보낸다
      return;
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // USB에 모니터가 없어도(배터리 전원) 출력 때문에 멈추지 않게 한다
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  setLed(false);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);         // 전송 지연을 줄이기 위해 절전 끔
  WiFi.setAutoReconnect(true);  // 끊기면 자동으로 다시 접속
  WiFi.begin(AP_SSID, AP_PASSWORD);
}

void loop() {
  static bool wasConnected = false;
  bool connected = WiFi.status() == WL_CONNECTED;

  if (connected) {
    if (!wasConnected) {
      setLed(true);  // 연결되면 켜진 상태로 고정
      Serial.printf("Connected to %s, IP=%s\n", AP_SSID, WiFi.localIP().toString().c_str());
    }
  } else {
    if (wasConnected) {
      Serial.println("Disconnected, reconnecting...");
      bridge.stop();
    }
    if (millis() - lastBlinkMs >= BLINK_HALF_PERIOD_MS) {
      lastBlinkMs = millis();
      setLed(!ledOn);
    }
  }
  wasConnected = connected;

  updateButton();
  if (connected) sendEvents();
}
