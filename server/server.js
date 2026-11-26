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
    if (on) { bridge.sendCommand('TALK'); bridge.sendCommand('WING SWING'); }  // 팬·틸트 흔들기 + 날개 오가기
    else { bridge.sendCommand('STOP'); bridge.sendCommand('WING HOME'); }      // 팬·틸트 영점 + 날개 영점으로
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
