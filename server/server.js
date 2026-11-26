// 노트북 서버: 브릿지 보드(USB 시리얼)에서 안경 소리/사진을 받고, 호출어("윙크야")가 들리면 Gemini Live와 대화한다.
// 결과는 웹 화면(http://localhost:3000)에 글자와 소리로 보여준다.
// 실행: node server.js   (포트: PORT=3000)
// 글자로 시험: curl -X POST localhost:3000/ask -H "Content-Type: application/json" --data-binary @질문.json
const winkPersonas = require('./winkPersonas'); // 윙맨 성격 3종 (목소리와 말투)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { askGemini } = require('./geminiLive');
const { createWakeDetector } = require('./wakeDetector');
const { startBridgeSerial } = require('./bridgeSerial');
const { createVoiceSession } = require('./voiceSession');
const history = require('./conversationHistory');
const { createCollector } = require('./collector');
const coaching = require('./coaching'); // 소개팅 코칭: 마이크 소리 흐름 기록

// server/.env 파일의 값(GEMINI_API_KEY 등)을 환경변수로 불러온다. 파일이 없으면 건너뛴다.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HTTP_PORT = Number(process.env.PORT) || 3000;

// ---- 웹 화면으로 사건 보내기 (SSE: 서버가 브라우저로 계속 흘려보내는 방식) ----
const viewers = new Set();
let lastState = { state: 'idle' };
const bridgeStatus = { serial: false, port: null };
function emit(type, data = {}) {
  if (type === 'state') lastState = data;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of viewers) res.write(msg);
}

// ---- 호출 방법 ----
// 이 06 버전은 호출어("윙크야") 감지가 기본으로 켜져 있다. (모델: models/wink_ya.onnx, openWakeWord) 컨트롤러 버튼으로도 호출할 수 있다.
// 호출어 감지를 끄려면 server/.env 에 WAKE_WORD=off 를 적는다. (기준은 WAKE_THRESHOLD, 기본 0.5)
const wakeEnabled = String(process.env.WAKE_WORD || 'on').toLowerCase() !== 'off';
let wake;
if (wakeEnabled) {
  const wakeThreshold = process.env.WAKE_THRESHOLD ? Number(process.env.WAKE_THRESHOLD) : undefined;
  wake = createWakeDetector({ threshold: wakeThreshold, debug: !!process.env.WINK_DEBUG });
  if (!wake) {
    console.error('호출어 감지기를 찾을 수 없습니다. server/.venv 에 openwakeword, onnxruntime 을 설치해야 합니다.');
    process.exit(1);
  }
  wake.onReady((word) => emit('wake-ready', { word }));
} else {
  console.log('호출어 감지는 꺼져 있습니다. 컨트롤러 버튼으로 호출하세요. (WAKE_WORD=off 로 꺼 둠)');
  wake = { write() {}, onWake() {}, isReady: () => false, getWord: () => '' }; // 아무것도 하지 않는 자리 채움
}

// ---- 소리 -> 호출어 -> Gemini ----
let bridge = null; // startBridgeSerial의 결과. 아래에서 채운다. (Gemini 대답 소리를 안경 스피커로 보낼 때 쓴다)
const session = createVoiceSession({
  apiKey: GEMINI_API_KEY,
  wake,
  emit,
  onSpeakerAudio: (pcm) => { if (bridge) bridge.sendAudio(pcm); }, // Gemini 대답 소리 -> 안경 스피커
  minSpeechRms: process.env.VAD_RMS ? Number(process.env.VAD_RMS) : undefined,
});

// 시험용: server/.env 에 WINK_DUMP=파일이름.pcm 을 적으면 들어오는 마이크 소리를 그 파일에 저장한다. (16kHz 16비트 모노, 서버를 켤 때마다 새로 씀)
const dumpFile = process.env.WINK_DUMP ? fs.createWriteStream(path.join(__dirname, process.env.WINK_DUMP)) : null;

// ---- 모터 시험 버튼 (웹 화면 맨 아래) ----
// 안경 보드의 모터(D0 틸트, D1 팬, D2 날개)를 브릿지로 명령을 보내 움직인다. (보드에 올린 안경 코드가 ANGLE1/ANGLE2/WING 명령을 받는다)
// 팬·틸트 동작은 서버가 ANGLE1(틸트), ANGLE2(팬)를 초당 25번 이어서 보내 부드럽게 만든다.
const PAN_HOME = 90;     // 팬 영점
const TILT_HOME = 20;    // 틸트 영점. 각도가 커질수록 틸트는 아래로 내려가고(0도가 가장 위쪽 끝), 올려다보기(위로 LOOKUP_TILT도)가 딱 끝까지 가는 가장 작은 값이다. 끝에 닿아 서보가 힘을 쓰면 25로 올린다. 안경 코드의 SERVO1_HOME과 같아야 한다
const PAN_RIGHT = 1;     // 팬이 오른쪽으로 갈 때 각도가 커지면 1, 작아지면 -1. (반대로 움직이면 이 값만 바꾼다)
const NOD_DEG = 25;      // 끄덕끄덕 틸트 폭
const SHAKE_DEG = 25;    // 절레절레 팬 폭
const LOOKUP_PAN = 30;   // 올려다보기: 영점에서 팬 오른쪽으로
const LOOKUP_TILT = 20;  // 올려다보기: 영점에서 틸트 위로 (각도가 작아지는 쪽)
const WING_SLOW = 30;    // 날개 느리게 (WING SPEED)
const WING_FAST = 80;    // 날개 빠르게
const MOTION_HZ = 25;
let pose = { pan: PAN_HOME, tilt: TILT_HOME };  // 서버가 마지막으로 보낸 팬·틸트 자세
let motionTimer = null;

function setPose(pan, tilt, force = false) {
  const p = Math.round(Math.min(180, Math.max(0, pan)));
  const t = Math.round(Math.min(180, Math.max(0, tilt)));
  if (force || p !== pose.pan) bridge.sendCommand(`ANGLE2 ${p}`);
  if (force || t !== pose.tilt) bridge.sendCommand(`ANGLE1 ${t}`);
  pose = { pan: p, tilt: t };
}
function stopMotion() { if (motionTimer) { clearInterval(motionTimer); motionTimer = null; } }
// durationMs 동안 fn(경과 ms)가 돌려주는 {pan, tilt}로 움직이고, 끝나면 onDone을 부른다. 새 동작을 시작하면 하던 동작은 멈춘다.
function animate(durationMs, fn, onDone) {
  stopMotion();
  const start = Date.now();
  let first = true;
  motionTimer = setInterval(() => {
    const t = Date.now() - start;
    if (t >= durationMs) { stopMotion(); if (onDone) onDone(); return; }
    const p = fn(t);
    setPose(p.pan, p.tilt, first);  // 첫 걸음은 두 서보 모두 보낸다 (서버가 아는 자세와 실제가 어긋났을 수 있어서)
    first = false;
  }, 1000 / MOTION_HZ);
}
// 지금 자세에서 목표 자세로 ms 동안 부드럽게 이동
function moveTo(pan, tilt, ms, onDone) {
  const from = { ...pose };
  animate(ms, (t) => {
    const k = 0.5 - 0.5 * Math.cos(Math.PI * t / ms);
    return { pan: from.pan + (pan - from.pan) * k, tilt: from.tilt + (tilt - from.tilt) * k };
  }, () => { setPose(pan, tilt, true); if (onDone) onDone(); });
}
const atHome = () => pose.pan === PAN_HOME && pose.tilt === TILT_HOME;
// 영점이 아니면 영점으로 먼저 간 뒤 동작을 시작한다 (자세가 갑자기 튀지 않게)
const fromHome = (run) => (atHome() ? run() : moveTo(PAN_HOME, TILT_HOME, 500, run));

// action: nod | shake | lookup | home | wing-slow | wing-fast | wing-stop. 알 수 없는 동작이면 false
function runMotor(action) {
  switch (action) {
    case 'nod': // 끄덕끄덕: 틸트만 영점에서 아래로 NOD_DEG까지 3번 (한 번에 0.8초)
      fromHome(() => animate(2400, (t) => ({ pan: PAN_HOME, tilt: TILT_HOME + NOD_DEG * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / 800)) }),
        () => setPose(PAN_HOME, TILT_HOME, true)));
      return true;
    case 'shake': // 절레절레: 팬만 좌우로 3번 (한 번에 0.9초)
      fromHome(() => animate(2700, (t) => ({ pan: PAN_HOME + SHAKE_DEG * Math.sin(2 * Math.PI * t / 900), tilt: TILT_HOME }),
        () => setPose(PAN_HOME, TILT_HOME, true)));
      return true;
    case 'lookup': // 올려다보기: 영점에서 팬 오른쪽 LOOKUP_PAN도, 틸트 위로 LOOKUP_TILT도(각도는 작아진다). 자세를 유지한다 (원점 버튼으로 돌아온다)
      moveTo(PAN_HOME + PAN_RIGHT * LOOKUP_PAN, TILT_HOME - LOOKUP_TILT, 700);
      return true;
    case 'home': // 원점: 팬·틸트를 영점으로
      moveTo(PAN_HOME, TILT_HOME, 700);
      return true;
    case 'wing-slow':
      bridge.sendCommand(`WING SPEED ${WING_SLOW}`); bridge.sendCommand('WING SWING');
      return true;
    case 'wing-fast':
      bridge.sendCommand(`WING SPEED ${WING_FAST}`); bridge.sendCommand('WING SWING');
      return true;
    case 'wing-stop': // 정지: 날개를 영점으로 돌려놓고 멈춘다
      bridge.sendCommand('WING HOME');
      return true;
    default:
      return false;
  }
}

// 호출어 보정용 녹음 모으기 (웹 화면의 "호출어 보정 데이터 모으기")
const collector = createCollector({ onChange: (s) => emit('collect', s) });

// 16비트 PCM 소리를 gain배로 줄인다 (소리를 작게 들려주려고)
function scalePcm(pcm, gain) {
  const out = Buffer.alloc(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
  return out;
}

// 글로 물어보기: 같은 대화 기록을 쓰고, 대답 소리는 안경 스피커로 보내고, 주고받은 내용을 기록에 남긴다
async function askAndSpeak(text, hint, gain = 1) {
  let answer = '';
  await askGemini(GEMINI_API_KEY, { text, hint, search: true, history: history.recent() }, { onOutputText: (t) => { answer += t; }, onOutputAudio: (pcm) => { if (bridge) bridge.sendAudio(gain === 1 ? pcm : scalePcm(pcm, gain)); } });
  const item = history.add(text, answer);
  if (item) emit('history', item);
  return answer;
}

// ---- 시나리오별 버튼 (웹 화면, 모터 시험 아래) ----
// kind 'gemini': prompt를 Gemini에게 보내 귓속말처럼 짧게 대답하게 한다 (소리는 안경 스피커, 글자는 화면). 대답이 길면 브릿지가 막힐 수 있어 짧게 시킨다.
// kind 'motor': 안경에 눈 화면이 아직 없어서 모터/삑 소리로 대신 표현한다. run()이 true를 돌려주면 성공
const SCENE_DEG = 5;  // 시나리오별 버튼에서 머리(팬·틸트)가 움직이는 폭. 약간씩만
// 귓속말 톤: 목소리 말투는 지침(hint)으로 알려 준다. 시나리오별 버튼의 말하는 대답에 쓴다
const WHISPER_TONE = '지금은 상대 몰래 사용자 귀에만 들리게 하는 조용한 귓속말 상황이야. 평소 목소리 그대로 자연스럽고 차분하게, 조금 낮고 부드럽게 말해. 속삭이는 소리나 숨소리를 억지로 내지 말고, 또렷한 발음은 그대로 유지해.';
const WHISPER_GAIN = 0.45;  // 귓속말 대답은 소리를 이 비율로 줄여서 안경 스피커로 보낸다 (1이면 그대로)
const WHISPER = '귓속말하듯 짧게, 두 문장 안으로 말해줘. ';
const SCENARIOS = {
  playlist: { kind: 'gemini', prompt: WHISPER + '지금 데이트 직전에 상대를 기다리는 중이야. 상대가 나를 떠올리며 고른 플레이리스트라는 설정으로, 노래 하나만 골라서 제목과 가수를 알려줘.' },
  charm: { kind: 'gemini', prompt: WHISPER + '지금까지 알고 있는 상대 정보를 바탕으로 상대의 매력 포인트를 하나만 알려줘. 모르는 건 지어내지 마.' },
  pairing: { kind: 'motor', label: '페어링 신호(삑 + 끄덕)', run: () => { bridge.sendCommand('BEEP');
    fromHome(() => animate(1600, (t) => ({ pan: PAN_HOME, tilt: TILT_HOME + SCENE_DEG * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / 800)) }), () => setPose(PAN_HOME, TILT_HOME, true)));
    return true; } },
  topics: { kind: 'gemini', prompt: WHISPER + '지금 대화가 끊겨서 어색해. 이어갈 만한 대화 주제 4~5개를 각각 열 글자 안팎으로만 알려줘.' },
  wink: { kind: 'motor', label: '윙크(고개를 살짝 갸웃)', run: () => {
    fromHome(() => animate(900, (t) => ({ pan: PAN_HOME + PAN_RIGHT * SCENE_DEG * Math.sin(Math.PI * t / 900), tilt: TILT_HOME + SCENE_DEG * Math.sin(Math.PI * t / 900) }), () => setPose(PAN_HOME, TILT_HOME, true)));
    return true; } },
  hearts: { kind: 'motor', label: '하트 날리기(날개를 빠르게 퍼덕)', run: () => {
    bridge.sendCommand(`WING SPEED ${WING_FAST}`); bridge.sendCommand('WING SWING');
    setTimeout(() => bridge && bridge.sendCommand('WING HOME'), 3000);
    return true; } },
  ments: { kind: 'gemini', prompt: WHISPER + '지금 상대에게 해볼 만한 플러팅 멘트를 하나만 제안해줘. 반드시 "이렇게 말해봐" 하고 알려주는 식으로, 먼저 "이렇게 말해봐"라고 한 뒤 상대에게 건넬 말을 한 문장으로 들려줘. 예를 들면 "이렇게 말해봐. 대화하다 보니까 시간이 훌쩍 갔네. 너랑 있으면 정말 즐거워." 같은 느낌이야. 과하거나 무례하지 않게.' },
  flutter: { kind: 'motor', label: '설렐 때 빠른 날갯짓', run: () => {
    bridge.sendCommand(`WING SPEED ${WING_FAST}`); bridge.sendCommand('WING SWING');
    setTimeout(() => bridge && bridge.sendCommand('WING HOME'), 2500);
    return true; } },
  shy: { kind: 'motor', label: '부끄러울 때 고개 숙이고 절레절레', run: () => {
    moveTo(PAN_HOME, TILT_HOME + SCENE_DEG, 500, () => animate(1800, (t) => ({ pan: PAN_HOME + SCENE_DEG * Math.sin(2 * Math.PI * t / 600), tilt: TILT_HOME + SCENE_DEG }),
      () => moveTo(PAN_HOME, TILT_HOME, 600)));
    return true; } },
  mission: { kind: 'gemini', prompt: WHISPER + '오프라인 연프 미션이야. 나에게만 주는 비밀 미션 하나를 알려주고, 상대는 다른 비밀 미션을 받았으며 미션을 먼저 해내는 승자에게 데이트 우선권이 있다고 말해줘.' },
  megi: { kind: 'gemini', prompt: WHISPER + '메기(데이트에 끼어드는 제3의 인물)와의 데이트를 나에게 귓속말로 제안하고, 수락할지는 앱에서 확인하라고 말해줘.' },
  megi_yes: { kind: 'gemini', prompt: WHISPER + '메기와의 데이트를 수락했어. 짧게 응원해줘.' },
  megi_no: { kind: 'gemini', prompt: WHISPER + '메기와의 데이트를 거절했어. 짧게 한마디 해줘.' },
  more: { kind: 'gemini', prompt: WHISPER + '데이트가 끝나기 직전이야. 추가 데이트를 할지 나에게 한 문장으로 물어봐줘.' },
};

// ---- 브릿지 보드 (USB 시리얼) ----
bridge = startBridgeSerial({
  portPath: process.env.SERIAL_PORT || undefined,
  debug: !!process.env.WINK_DEBUG,
  // 녹음 중에는 소리를 파일에만 모으고, 호출어 감지/Gemini로는 보내지 않는다
  onAudio: (pcm) => { if (dumpFile) dumpFile.write(pcm); if (collector.isActive()) collector.write(pcm); else { session.onAudio(pcm); coaching.onAudio(pcm, session.getState() === 'idle'); } },
  onVideo: session.onVideo,
  onButton: (pressed) => { if (!collector.isActive()) session.onButton(pressed); },
  onStatus: (connected, port) => { bridgeStatus.serial = connected; bridgeStatus.port = port; emit('bridge', bridgeStatus); },
  // 안경 스피커에서 대답이 나오는 동안 모터를 움직이고, 끝나면 영점으로 돌려놓는다. (안경 보드가 이 명령을 받아 처리한다)
  onSpeaking: (on) => {
    if (!bridge) return;
    console.log(on ? '대답 소리가 안경 스피커로 나가기 시작 -> 모터 시작 (TALK, WING SWING)' : '대답 소리 재생이 끝남 -> 모터 정지 (STOP, WING HOME)');
    stopMotion();  // 시험 버튼으로 움직이던 동작은 멈춘다
    if (on) { bridge.sendCommand('TALK'); bridge.sendCommand('WING SWING'); }  // 팬·틸트 흔들기 + 날개 오가기
    else { bridge.sendCommand('STOP'); bridge.sendCommand('WING HOME'); pose = { pan: PAN_HOME, tilt: TILT_HOME }; }      // 팬·틸트 영점 + 날개 영점으로
  },
});

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(lastState)}\n\n`);
    res.write(`event: bridge\ndata: ${JSON.stringify(bridgeStatus)}\n\n`);
    res.write(`event: wake-mode\ndata: ${JSON.stringify({ enabled: wakeEnabled })}\n\n`);
    res.write(`event: history-all\ndata: ${JSON.stringify(history.all())}\n\n`);
    res.write(`event: collect\ndata: ${JSON.stringify(collector.status())}\n\n`);
    if (wake.isReady()) res.write(`event: wake-ready\ndata: ${JSON.stringify({ word: wake.getWord() })}\n\n`);
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
    return;
  }

  // 모터 시험 버튼: POST /servo/test?action=nod|shake|lookup|home|wing-slow|wing-fast|wing-stop
  if (url === '/servo/test' && req.method === 'POST') {
    const action = new URL(req.url, 'http://x').searchParams.get('action');
    let status = 200;
    let error;
    if (!bridgeStatus.serial) { status = 409; error = '브릿지 보드가 연결되지 않았습니다.'; }
    else if (!runMotor(action)) { status = 400; error = `알 수 없는 동작입니다: ${action}`; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, action }));
  }

  // 윙맨 성격: GET /persona (목록과 지금 선택), POST /persona?id=cool|soft|witty (선택), POST /persona/preview?id=... (예시 대사를 그 목소리로 안경 스피커에 들려주기)
  if (url === '/persona' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ current: winkPersonas.getCurrent().id, list: winkPersonas.list() }));
  }
  if ((url === '/persona' || url === '/persona/preview') && req.method === 'POST') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const p = winkPersonas.get(id);
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (!p) return json(400, { ok: false, error: '알 수 없는 성격입니다.' });
    if (url === '/persona') { winkPersonas.setCurrent(id); return json(200, { ok: true, current: id }); }
    if (!bridgeStatus.serial) return json(409, { ok: false, error: '브릿지 보드가 연결되지 않았습니다. (소리는 안경 스피커로 나와요)' });
    if (session.getState() !== 'idle') return json(409, { ok: false, error: 'WINK가 듣거나 답하는 중이에요. 끝난 뒤에 눌러 주세요.' });
    // 대화 기록에는 남기지 않는다. 고른 성격이 아니라 미리 듣는 성격의 목소리와 말투를 쓴다
    askGemini(GEMINI_API_KEY, { text: `다음 문장을 한 글자도 바꾸지 말고 그대로 한 번만 말해줘: ${p.line}`, persona: p }, { onOutputAudio: (pcm) => { if (bridge) bridge.sendAudio(pcm); } })
      .then(() => json(200, { ok: true, line: p.line }))
      .catch((err) => json(502, { ok: false, error: err.message }));
    return;
  }

  // 시나리오별 버튼: POST /scenario?id=playlist|charm|...  (SCENARIOS 참고)
  if (url === '/scenario' && req.method === 'POST') {
    const sc = SCENARIOS[new URL(req.url, 'http://x').searchParams.get('id')];
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (!sc) return json(400, { ok: false, error: '알 수 없는 버튼입니다.' });
    if (sc.kind === 'motor') {
      if (!bridgeStatus.serial) return json(409, { ok: false, error: '브릿지 보드가 연결되지 않았습니다.' });
      sc.run();
      return json(200, { ok: true, text: sc.label });
    }
    if (session.getState() !== 'idle') return json(409, { ok: false, error: 'WINK가 듣거나 답하는 중이에요. 끝난 뒤에 눌러 주세요.' });
    askAndSpeak(sc.prompt, WHISPER_TONE, WHISPER_GAIN).then((answer) => json(200, { ok: true, text: answer })).catch((err) => json(502, { ok: false, error: err.message }));
    return;
  }

  // 호출어 보정 녹음: /collect/start?label=pos|neg , /collect/stop
  if (url === '/collect/start' && req.method === 'POST') {
    const label = new URL(req.url, 'http://x').searchParams.get('label');
    // 대화 중에는 시작하지 않는다 (듣는 중에 소리가 끊기지 않게)
    const ok = session.getState() === 'idle' && collector.start(label);
    res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok }));
  }
  if (url === '/collect/stop' && req.method === 'POST') {
    collector.stop();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"ok":true}');
  }

  if (url === '/frame.jpg') {
    const jpeg = session.getFrame();
    if (!jpeg) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(jpeg);
  }

  // 대화 기록 지우기 (새 대화 시작). Gemini는 이전 대화를 잊는다.
  if (url === '/history/clear' && req.method === 'POST') {
    history.clear();
    console.log('대화 기록을 지웠습니다.');
    emit('history-all', []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"ok":true}');
  }

  if (url === '/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      try { text = String(JSON.parse(body).text || '').trim(); } catch {}
      if (!text) { res.writeHead(400); return res.end('text가 필요합니다.'); }
      try {
        const answer = await askAndSpeak(text);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ text: answer }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(HTTP_PORT, () => console.log(`서버 실행 중: http://localhost:${HTTP_PORT}`));
