#include <Arduino.h>
#include <WiFi.h>
#include <lwip/sockets.h>

// Soft AP + TCP 브리지
//  - 데이터 포트(8080): 안경 보드가 접속한다.
//      안경 보드가 보낸 데이터(카메라 프레임, 소리) -> USB 시리얼(노트북)로 그대로 전달
//      노트북이 USB 시리얼로 보낸 데이터 -> 데이터 포트에 접속한 모든 기기에 전달
//  - 제어 포트(8081): 컨트롤러 보드가 접속한다.
//      컨트롤러가 보낸 "ON\n" / "OFF\n" -> 데이터 포트에 접속한 기기(안경 보드)에 전달
//      컨트롤러 접속이 끊기면 안경 보드가 계속 켜져 있지 않게 "OFF\n"를 대신 보낸다.
// 시리얼로는 전달할 데이터 외에 아무것도 출력하지 않는다. (노트북 서버가 프레임을 파싱함)
constexpr char AP_SSID[] = "Dating";
constexpr char AP_PASSWORD[] = "12345678";
constexpr int AP_CHANNEL = 1;
constexpr int MAX_STATIONS = 8;  // Soft AP에 동시에 붙을 수 있는 기기 수 (꺼진 보드가 잠시 남아도 여유 있게)
constexpr uint16_t DATA_PORT = 8080;
constexpr uint16_t CONTROL_PORT = 8081;
constexpr int MAX_DATA_CLIENTS = 4;
constexpr int MAX_CONTROL_CLIENTS = 4;

constexpr size_t SERIAL_TX_BUFFER = 16384;
constexpr uint32_t SERIAL_TX_TIMEOUT_MS = 200;  // 노트북이 안 읽으면 기다리지 않고 버린다

WiFiServer dataServer(DATA_PORT);
WiFiServer controlServer(CONTROL_PORT);
WiFiClient dataClients[MAX_DATA_CLIENTS];
WiFiClient controlClients[MAX_CONTROL_CLIENTS];
uint32_t dataSince[MAX_DATA_CLIENTS] = {};        // 각 자리에 연결된 시각
uint32_t controlSince[MAX_CONTROL_CLIENTS] = {};

// 전원이 갑자기 꺼진 보드는 연결이 끊겼다는 걸 알릴 수 없어서, 자리를 계속 차지한 채 남는다.
// keepalive로 몇 초 안에 끊긴 연결을 알아채게 한다.
void enableKeepAlive(WiFiClient& client) {
  int fd = client.fd();
  int on = 1, idle = 3, interval = 1, count = 3;
  setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof(interval));
  setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count));
}

// 새 연결을 빈 자리에 넣는다. 자리가 없으면 가장 오래된 연결을 내보내고 새 연결을 받는다.
// (다시 켠 보드가 먼저 끊어졌다고 알려지지 않은 옛 연결 때문에 거절되는 일을 막는다)
template <size_t N>
void acceptInto(WiFiServer& server, WiFiClient (&slots)[N], uint32_t (&since)[N]) {
  WiFiClient incoming = server.accept();
  if (!incoming) return;

  size_t target = 0;
  bool found = false;
  for (size_t i = 0; i < N; i++) {
    if (!slots[i] || !slots[i].connected()) {
      target = i;
      found = true;
      break;
    }
    if (since[i] < since[target]) target = i;  // 가장 오래된 자리
  }
  if (!found) slots[target].stop();

  slots[target] = incoming;
  slots[target].setNoDelay(true);
  enableKeepAlive(slots[target]);
  since[target] = millis();
}

void writeToDataClients(const uint8_t* buf, size_t n) {
  for (int i = 0; i < MAX_DATA_CLIENTS; i++) {
    if (dataClients[i] && dataClients[i].connected()) dataClients[i].write(buf, n);
  }
}

void setup() {
  Serial.setTxBufferSize(SERIAL_TX_BUFFER);
  Serial.begin(115200);
  Serial.setTxTimeoutMs(SERIAL_TX_TIMEOUT_MS);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD, AP_CHANNEL, 0, MAX_STATIONS);

  dataServer.begin();
  dataServer.setNoDelay(true);
  controlServer.begin();
  controlServer.setNoDelay(true);
}

void loop() {
  acceptInto(dataServer, dataClients, dataSince);
  acceptInto(controlServer, controlClients, controlSince);

  // 데이터 포트 기기(안경) -> 시리얼
  for (int i = 0; i < MAX_DATA_CLIENTS; i++) {
    if (!dataClients[i]) continue;
    uint8_t buf[1460];
    int avail;
    while ((avail = dataClients[i].available()) > 0) {
      int n = dataClients[i].read(buf, min(avail, (int)sizeof(buf)));
      if (n <= 0) break;
      Serial.write(buf, n);
    }
    if (!dataClients[i].connected()) dataClients[i].stop();
  }

  // 제어 포트 기기(컨트롤러) -> 데이터 포트 기기(안경)
  for (int i = 0; i < MAX_CONTROL_CLIENTS; i++) {
    if (!controlClients[i]) continue;
    uint8_t buf[64];
    int avail;
    while ((avail = controlClients[i].available()) > 0) {
      int n = controlClients[i].read(buf, min(avail, (int)sizeof(buf)));
      if (n <= 0) break;
      writeToDataClients(buf, n);
    }
    if (!controlClients[i].connected()) {
      controlClients[i].stop();
      writeToDataClients((const uint8_t*)"OFF\n", 4);
    }
  }

  // 시리얼 -> 데이터 포트 기기
  while (Serial.available()) {
    uint8_t buf[256];
    size_t n = Serial.readBytes(buf, min((size_t)Serial.available(), sizeof(buf)));
    writeToDataClients(buf, n);
  }
}
