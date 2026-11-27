# WINK SPEC

팀 3명이 ESP32 보드 + 노트북 서버 + 웹 화면으로 WINK(AI 윙맨) 프로토타입을 함께 만든다.
서비스 설명은 `CLAUDE.md`를 본다. 이 문서는 **무엇을 어떤 이름으로 만드는지**만 정한다.
여기 적힌 이름(파일, 함수, 포트, 이벤트, 화면 id)은 그대로 쓴다. 없는 이름이 필요하면 새로 만들지 말고 제안한다.

## 1. 전체 흐름

```
[컨트롤러 보드] --Wi-Fi(8081)--> [브릿지 보드] <--Wi-Fi(8080)--> [안경 보드]
                                      |
                                  USB 시리얼
                                      |
                              [노트북 서버(server)] --웹소켓--> Gemini Live API
                                      |
                              HTTP / SSE(/events)
                                      |
                              [웹 화면(server/public)]  http://localhost:3000
```

- 컨트롤러 버튼을 누르는 동안 WINK가 듣는다. (누름 `DOWN`, 뗌 `UP`)
- 안경 보드는 카메라 사진(JPEG)과 마이크 소리를 브릿지로 보낸다.
- 서버는 소리를 Gemini Live에 보내고, 응답을 글자와 소리로 웹 화면에 보여준다.
- 서보 보드는 AI가 말할 때 움직인다. (노트북 USB 시리얼 명령)

## 2. 영역과 담당 (파일 기준)

담당은 레인(작업 묶음) 단위로 나눈다. 담당 칸의 `lane-X`는 아래 "작업 현황"의 레인이다. 담당자는 바뀔 수 있다.

| 영역 | 종류 | 폴더 / 파일 | 담당 |
|---|---|---|---|
| 브릿지 | 보드에 올리는 코드 | `firmware/bridge/` | `fernwehs` (lane-C) |
| 안경 | 보드에 올리는 코드 | `firmware/glasses/` | `fernwehs` (lane-C) |
| 컨트롤러 | 보드에 올리는 코드 | `firmware/controller/` | (미정) |
| 서보 | 보드에 올리는 코드 | `firmware/servo/` | `jooyeonpark822` (lane-B) |
| 서버 | 노트북 서버 코드 | `server/*.js`, `server/*.py` | (미정). 단 lane 작업에 쓰는 파일은 아래 표를 따른다 |
| AI 말투·성격 | 노트북 서버 코드 | `server/geminiLive.js`의 `SYSTEM_INSTRUCTION`, `server/personas.js`, `server/winkPersonas.js`, `server/flirtCoach.js`, `server/scenarioReplies.js`, `server/partner.js`, `server/coaching.js` | `jooyeonpark822` (lane-A) |
| 웹 화면 | 웹 화면 코드 | `server/public/index.html` | (미정). 서보 시험 버튼(#9)만 `jooyeonpark822` |
| 호출어·모델 | 노트북 서버 코드 | `server/wakeword.py`, `server/wakeDetector.js`, `server/train_verifier.py`, `models/` | (미정) |

서버 파일 중 lane 작업으로 맡은 것:

| 파일 | 담당 | 이슈 |
|---|---|---|
| `server/servoSerial.js` (새 파일), `server/server.js` (`/servo/test` 경로만) | `jooyeonpark822` | #7, #8 |
| `server/bridgeSerial.js`, `server/voiceSession.js`, `server/serialReader.py` (소리를 제품으로 보내는 부분만) | `fernwehs` | #15 |

공용(바꾸면 양쪽이 같이 바뀌어야 하는 값)은 4장의 약속이다. 바꾸려면 먼저 팀에 알린다.

## 3. 보드

공통: 보드는 XIAO ESP32S3 (안경은 Sense). PlatformIO 환경 이름은 `seeed_xiao_esp32s3`. 내장 LED는 핀 21(켜짐 = LOW).

| 보드 | 폴더 | 하는 일 | 핀 |
|---|---|---|---|
| 브릿지 | `firmware/bridge` | Soft AP(`AP_SSID`)를 열고 TCP 두 포트를 받는다. 안경이 보낸 것을 USB 시리얼로 전달하고, 노트북이 보낸 것은 안경에 전달한다. 컨트롤러가 끊기면 안경에 `OFF`를 대신 보낸다. | - |
| 안경 | `firmware/glasses` | 카메라 JPEG와 마이크 소리를 프레임으로 만들어 브릿지 데이터 포트로 보낸다. 노트북이 보낸 스피커 소리 프레임(종류 4)을 받아 스피커로 낸다. 서보 3개(틸트, 팬, 날개 톱니)를 움직인다. 명령은 USB 시리얼이나 브릿지로 받는다. | 카메라 핀은 Sense 보드 기본값(`CAM_PIN_*`). 서보: 틸트 `D0`, 팬 `D1`, 날개 톱니 `D2`. 스피커 앰프(MAX98357A): `BCLK` = `D3`, `LRC` = `D4`, `DIN` = `D5` |
| 컨트롤러 | `firmware/controller` | 버튼을 누르면 `DOWN\n`, 떼면 `UP\n`을 브릿지 제어 포트로 보낸다. | 버튼 `D4` (누르면 LOW, 내부 풀업) |
| 서보 | `firmware/servo` | USB 시리얼(115200) 명령으로 움직인다. | 신호선 `D0` |

보드가 쓰는 Wi-Fi 이름과 비밀번호는 각 `main.cpp`의 `AP_SSID`, `AP_PASSWORD` 상수에 있다. (SPEC에는 적지 않는다)

## 4. 약속 (바꾸면 여러 영역이 같이 바뀐다)

### 4.1 네트워크 포트

| 이름 | 값 | 누가 | 용도 |
|---|---|---|---|
| `DATA_PORT` | 8080 | 브릿지가 열고 안경이 접속 | 안경 -> 브릿지 데이터, 노트북 -> 안경 제어 |
| `CONTROL_PORT` | 8081 | 브릿지가 열고 컨트롤러가 접속 | 컨트롤러 버튼 신호 |
| 서버 `PORT` | 3000 | 노트북 서버 | 웹 화면과 API |

### 4.2 프레임 (시리얼)

`[AA 55 A5 5A] [종류 1바이트] [길이 4바이트, little-endian] [데이터]`

| 종류 | 의미 | 데이터 |
|---|---|---|
| 1 | 카메라 사진 | JPEG 한 장 |
| 2 | 마이크 소리 | PCM 조각 (16kHz, 16비트, 모노) |
| 3 | 컨트롤러 버튼 | 1바이트 (1 = 누름, 0 = 뗌) |
| 4 | 안경 스피커 소리 | PCM 조각 (24kHz, 16비트, 모노). 방향이 반대다: 노트북 -> 브릿지 -> 안경 |

종류 1~3 (안경 -> 노트북): 만든 쪽 `firmware/glasses`의 `writeHeader`, 읽는 쪽 `server/bridgeSerial.js`의 `startBridgeSerial`.
종류 4 (노트북 -> 안경): 만든 쪽 `server/bridgeSerial.js`의 `sendAudio`(20ms = 960바이트 조각으로 재생 속도에 맞춰 보낸다), 읽는 쪽 `firmware/glasses`의 `pumpIncoming`. 브릿지 보드는 노트북이 보낸 바이트를 그대로 안경에 전달한다.

### 4.3 한 줄 명령

| 방향 | 명령 | 뜻 |
|---|---|---|
| 컨트롤러 -> 브릿지 | `DOWN`, `UP` | 버튼 누름, 뗌 |
| 브릿지 -> 안경 | `ON`, `OFF` | 보내기 시작, 멈춤 |
| 노트북 -> 서보 | `TALK`, `STOP`, `TEST`, `ANGLE n` | 말하는 동안 움직임, 멈춤, 왕복 시험, 각도 지정(0~180) |
| 노트북 -> 안경 (서보) | `ANGLE1 n`, `ANGLE2 n` | 틸트(D0) 또는 팬(D1)만 n도(0~180)로. 틸트는 각도가 커질수록 **아래**로 내려가고 0도가 위쪽 끝이다. `STOP`, 부팅, `TEST` 끝의 영점은 틸트 **20도**(올려다보기가 끝까지 갈 수 있는 가장 작은 값), 팬 90도. 영점은 `firmware/glasses`의 `SERVO1_HOME`과 `server/server.js`의 `TILT_HOME`이 같아야 한다 |
| 노트북 -> 안경 (스피커) | `BEEP` | 시험음 (880Hz, 0.4초) |
| 노트북 -> 안경 (날개 톱니, 360도 연속 회전형 서보) | `WING n` (-100~100), `WING STOP`, `WING TRIM n` | 속도로 회전(0 = 정지), 정지, 정지 위치 보정(-200~200us) |
| | `WING SWING`, `WING TURN n`, `WING SPEED n`, `WING CAL ms`, `WING ZERO`, `WING HOME`, `WING POS` | 각도로 움직이기. 이 모터는 각도 센서가 없어서 돌린 시간으로 추정한다. 영점에서 -5 <-> +5도(`WING_SWING_RANGE`) 오가기, n도 돌기, 속도(10~100), 90도 도는 시간 보정, 지금 위치를 0도로, 추정 각도가 0이 되도록 돌아가기, 추정 각도 |

안경은 위 서보 명령(`TALK`, `STOP`, `TEST`, `ANGLE n` 포함)과 `BEEP`을 USB 시리얼과 브릿지(데이터 포트) 양쪽으로 받는다. `ANGLE1`/`ANGLE2`는 서보 보드(`firmware/servo`)에도 있다. 안경에서 `TALK`은 팬은 `cos`, 틸트는 `sin`으로 영점 기준 **동그라미**를 그린다(한 바퀴 3.5초, 팬 ±10도, 틸트 영점에서 아래로 0~12도, 작게 살랑살랑, 시작 0.6초는 서서히). 날개 모터는 정지(`WING STOP`, `WING 0`, 영점 복귀 끝, 부팅)일 때 **PWM 신호를 끊는다**(연속 회전형 서보가 서서히 도는 것과 전원 잡음을 막으려고).

**대답할 때 모터 움직이기:** 서버는 Gemini 대답 소리가 안경 스피커로 나가기 시작하면 안경에 `TALK`과 `WING SWING`을 보내고, 마지막 소리까지 재생이 끝나면(+0.3초) `STOP`과 `WING HOME`을 보낸다. 음성 대화와 글자 질문(`/ask`) 모두 같다. 명령은 `server/bridgeSerial.js`의 `sendCommand`로 보낸다. (줄 명령은 15글자 이하)

### 4.4 서버 -> 웹 화면 (`GET /events`, SSE)

`emit(type, data)`로 보낸다. 종류: `state`, `wake`, `wake-ready`, `input`, `output`, `audio`, `frame`, `problem`, `bridge`, `collect`, `history`, `history-all`.

### 4.5 서버 HTTP 경로

| 경로 | 방식 | 용도 |
|---|---|---|
| `/`, `/index.html` | GET | 웹 화면 |
| `/events` | GET | 실시간 이벤트(SSE) |
| `/frame.jpg` | GET | 가장 최근 카메라 사진 |
| `/ask` | POST | 글자로 질문(시험용) |
| `/servo/test?action=nod\|shake\|lookup\|home\|wing-slow\|wing-fast\|wing-stop` | POST | 안경 모터 시험 버튼. 서버가 브릿지를 거쳐 안경에 `ANGLE1`/`ANGLE2`/`WING *` 명령을 보낸다. 답하는 중에도 누르면 움직인다(답하며 움직이던 동작은 멈춘다). 브릿지가 없으면 409, 알 수 없는 동작이면 400 |
| `/scenario?id=playlist\|charm\|pairing\|topics\|wink\|hearts\|ments\|flutter\|shy\|mission\|megi\|megi_yes\|megi_no\|partner_data\|more\|flirt` | POST | 웹 화면 "시나리오별 버튼". 말하는 버튼은 그 상황의 대표 질문 한 줄(`SCENARIOS`의 prompt)을 Gemini에게 보내 `scenarioReplies.js` 지침대로 대답하게 하고(조용하고 차분한 말투(지침 `WHISPER_TONE`을 `hint`로 전달)로 하고 소리는 `WHISPER_GAIN`배로 줄여 소리는 안경 스피커, 글자는 응답 `text`와 대화 기록), `flirt`는 안경 카메라가 마지막으로 찍은 사진을 함께 보낸다(플러팅 코치). 모터 버튼(페어링·윙크·하트·설렐 때·부끄러울 때)은 눈 화면이 아직 없어 모터/삑 소리로 대신한다. 말하는 버튼은 WINK가 `idle`이 아니면 409, 모터 버튼은 브릿지가 없으면 409, 알 수 없는 id면 400 |
| `/persona` | GET | 윙맨 성격 3종 목록과 지금 선택 `{ current, list: [{id, name, voice, line}] }` |
| `/persona?id=cool\|soft\|witty` | POST | 윙맨 성격 선택. 이후 모든 Gemini 대답(음성, 글자, 시나리오별 버튼)에 그 목소리와 말투가 적용된다. 기본은 `soft`. `server/wink_persona.json`에 저장되어 서버를 다시 켜도 이어진다(git에는 안 올라감) |
| `/persona/preview?id=cool\|soft\|witty` | POST | 그 성격의 예시 대사를 그 목소리로 안경 스피커에 들려준다 (대화 기록에는 안 남김). 브릿지가 없으면 409, WINK가 `idle`이 아니면 409 |
| `/history/clear` | POST | 대화 기록 지우기 |
| `/collect/start?label=pos\|neg`, `/collect/stop` | POST | 호출어 녹음 모으기 |

### 4.6 서버 주요 이름

| 파일 | 이름 | 하는 일 |
|---|---|---|
| `server/server.js` | `emit` | 웹 화면으로 이벤트 보내기 |
| `server/bridgeSerial.js` | `startBridgeSerial`, `sendAudio`, `sendCommand`, `onSpeaking` | 브릿지 시리얼에서 프레임 읽기 (`serialReader.py` 사용). `sendAudio`는 Gemini 대답 소리를 안경 스피커로 보내기. `sendCommand`는 안경에 한 줄 명령 보내기. `onSpeaking(on)`은 안경 스피커에서 대답이 나오기 시작/끝날 때 불리는 핸들러 |
| `server/voiceSession.js` | `createVoiceSession` | 듣기(idle -> listening -> thinking) 상태 관리 |
| `server/geminiLive.js` | `askGemini`, `startLiveTurn`, `buildSystemText`, `speechConfigFor`, `SYSTEM_INSTRUCTION` | Gemini Live 호출과 말투 지침 |
| `server/coaching.js` | `onAudio`, `buildCoachingText` | 말소리/침묵 측정과 코칭 규칙 |
| `server/personas.js` | `buildPersonaText` | 두 사람 페르소나를 지침에 붙이기 |
| `server/scenarioReplies.js` | `buildScenarioRepliesText`, `SCENARIO_REPLIES_INSTRUCTION` | 시나리오별 버튼의 말하는 내용(플레이리스트, 매력 포인트, 대화 주제, 플러팅 멘트, 상대 화장실, 비밀 미션, 메기 데이트, 추가 데이트 질문)을 버튼 없이 말이나 글로 물어도 같은 방식으로 답하게 하는 지침. 버튼의 `SCENARIOS` prompt는 대표 질문 한 줄만 보내고 답하는 방식은 이 파일 한 곳에만 둔다. 모터 버튼은 말로 시킬 수 없어 없다. `geminiLive.js`가 지침 뒤에 붙인다 |
| `server/flirtCoach.js` | `buildFlirtText`, `FLIRT_COACH_INSTRUCTION` | "저 사람한테 플러팅하고 싶어" 때 카메라 이미지(옷, 표정, 주변)와 들린 말을 보고 행동 하나와 멘트 하나를 추천하게 하는 지침과 예시. 눈에 보이는 것만 말하고 감정·호감·외모·나이 등은 단정하지 않는다. 사람이 안 보이면 지어내지 않고 방향을 돌려 달라고 한다. `geminiLive.js`가 지침 뒤에 붙인다 |
| `server/winkPersonas.js` | `list`, `get`, `getCurrent`, `setCurrent`, `buildStyleText` | 윙맨 성격 3종(시원시원하고 털털한 `cool`=Aoede, 부드럽고 세심한 `soft`=Achird, 재치 있고 웃긴 `witty`=Zephyr). 목소리(`voiceConfig`)와 말투 지침을 `geminiLive.js`가 가져다 쓴다. 소리 빠르기는 지침으로 조금 빠르게 부탁한다 |
| `server/conversationHistory.js` | `load`, `save` | 대화 기록 저장 (`history.json`) |
| `server/wakeDetector.js` | `createWakeDetector` | 호출어("윙크야") 감지 |
| `server/collector.js` | `createCollector` | 호출어 녹음 모으기 |

### 4.7 웹 화면 id (`server/public/index.html`)

`how`, `status`, `label`, `lamp`, `lamp-text`, `info`, `heard`, `answer`, `cam`, `sound`, `hist-count`, `hist-clear`, `history`, `collect-box`, `rec-pos`, `rec-neg`, `rec-info`, `persona`, `persona-cards`, `persona-line`, `persona-preview`, `persona-apply`, `persona-info`, `form`, `q`, `ask`, `out`, `servo-test`

### 4.8 환경 변수 (`server/.env`)

`GEMINI_API_KEY`, `SERIAL_PORT`, `WAKE_THRESHOLD`. 값은 `.env`에만 두고 git에 올리지 않는다.

## 5. AI 동작 규칙

- 모델: `models/gemini-2.5-flash-native-audio-preview-12-2025`. 응답은 소리와 글자로 함께 보여준다.
- 말투와 성격은 `SYSTEM_INSTRUCTION`에서 정한다. (WINK 기획서의 3장은 Gemini에게 직접 전달되지 않는다)
- 카메라는 항상 분석하지 않는다. 사물이나 장면을 봐야 답할 수 있을 때만 사진을 쓴다.
- 마이크로는 소리 크기만 측정하고 말 내용은 저장하지 않는다. 측정하지 못한 것은 "없음"이라고 알려 지어내지 못하게 한다.
- 페르소나는 가상 인물만 쓴다. 실제 사람의 이름이나 연락처는 넣지 않는다.

## 6. 작업 규칙

- `main`에는 직접 올리지 않는다. 이슈마다 브랜치를 만들고 PR로 합친다. 시작 전에 `main`을 최신으로 받는다.
- 내 영역(2장) 파일만 고친다. 다른 영역을 고쳐야 하면 멈추고 먼저 이야기한다.
- 4장의 약속을 바꿀 때는 이 문서를 같이 고치는 PR로 올린다.
- 커밋 메시지와 PR 설명은 한국어로 쓰고 이슈 번호를 붙인다. (예: `서보 말하는 동작 추가 (#3)`)
- 보드에 올릴 때는 보드를 한 번에 하나만 USB에 연결한다.
- 비밀번호와 API 키는 코드나 문서에 쓰지 않는다. (`server/.env`만 사용)
- 이슈 제목은 `[A1]`처럼 레인 글자와 번호로 시작한다. 브랜치 이름은 `issue-번호-설명`으로 한다. (예: `issue-7-servo-serial`)

## 7. 작업 현황

GitHub 이슈: https://github.com/jooyeonpark822/WINK/issues

이번 목표: ① AI 말투·대답 다듬기 ② 모터 돌리기 (먼저 웹 버튼으로 시험, 최종은 목소리 명령) ③ Gemini 목소리를 컴퓨터 웹이 아니라 제품(안경 보드 스피커)에서 내기.

| 레인 | 목표 | 담당 | 이슈 |
|---|---|---|---|
| lane-A | AI 말투·대답 | `jooyeonpark822` | #1~#5 |
| lane-B | 모터 (웹 버튼 시험) | `jooyeonpark822` | #6~#10 |
| lane-C | 제품에서 Gemini 소리 | `fernwehs` | #11~#16 |

레인끼리는 같은 파일을 건드리지 않아 동시에 진행할 수 있다. 순서가 있는 것은 아래뿐이다.
- 레인 안: 번호 순서(B2는 B1 뒤, C4와 C5는 C3 뒤, C6은 C2·C4·C5 뒤 등. 각 이슈의 "선행 이슈" 참고)
- 레인 사이: "목소리로 모터" 이슈(`geminiLive.js` 수정, lane-A 파일)는 #10(B5) 뒤에 만든다.

### 제안 중인 이름 (아직 확정 아님, 확정되면 해당 장으로 옮긴다)

| 종류 | 이름 | 이슈 |
|---|---|---|
| 새 파일 | `server/servoSerial.js` | #7 |
| 환경 변수 | `SERVO_PORT` | #7 |

