// 노트북 서버: 브릿지 보드(USB 시리얼)에서 안경 소리/사진을 받고, 호출어("윙크야")가 들리면 Gemini Live와 대화한다.
// 결과는 웹 화면(http://localhost:3000)에 글자와 소리로 보여준다.
// 실행: node server.js   (포트: PORT=3000)
// 글자로 시험: curl -X POST localhost:3000/ask -H "Content-Type: application/json" --data-binary @질문.json
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
    else if (session.getState() === 'answering') { status = 409; error = 'WINK가 답하는 중이에요. 답이 끝난 뒤에 눌러 주세요.'; }
    else if (!runMotor(action)) { status = 400; error = `알 수 없는 동작입니다: ${action}`; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, action }));
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
      let answer = '';
      try {
        // 글로 물어볼 때도 같은 대화 기록을 쓰고, 주고받은 내용을 기록에 남긴다
        await askGemini(GEMINI_API_KEY, { text, search: true, history: history.recent() }, { onOutputText: (t) => { answer += t; }, onOutputAudio: (pcm) => { if (bridge) bridge.sendAudio(pcm); } });
        const item = history.add(text, answer);
        if (item) emit('history', item);
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
