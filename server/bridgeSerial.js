// 노트북 서버 코드: 브릿지 보드(USB 시리얼)에서 안경 보드가 보낸 프레임을 읽는다.
// 시리얼 읽기는 파이썬 프로그램(serialReader.py, pyserial)이 맡고, 여기서는 그 출력에서 프레임을 해석한다.
// (node의 serialport는 Windows에서 초당 16KB쯤에서 막혀서 소리가 대부분 사라졌다. pyserial은 초당 약 780KB)
// 프레임 형식은 firmware/glasses 와 같다: [AA 55 A5 5A] [종류 1바이트] [길이 4바이트, little-endian] [데이터]
//   종류 1 = 카메라 JPEG 한 장, 2 = 마이크 PCM 조각(16kHz, 16비트, 모노), 3 = 컨트롤러 버튼 (데이터 1바이트: 1=누름, 0=뗌)
// 포트는 server/.env 의 SERIAL_PORT(예: COM6)로 정할 수 있고, 없으면 Espressif(ESP32) 보드를 자동으로 찾는다.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MAGIC = Buffer.from([0xaa, 0x55, 0xa5, 0x5a]);
const HEADER_SIZE = 9;
const MAX_PAYLOAD = 2 * 1024 * 1024; // 이보다 크면 잘못 읽은 것으로 보고 다시 맞춘다
const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;
const TYPE_BUTTON = 3;
const STATS_MS = 10000;               // 이 간격으로 받은 양을 점검한다
const AUDIO_BYTES_PER_SEC = 32000;    // 16kHz x 16비트 모노
const AUDIO_WARN_RATIO = 0.8;         // 소리가 기대치의 80% 아래면 경고

// handlers: { onAudio(Buffer), onVideo(Buffer), onButton(pressed: boolean), onStatus(connected, portPath) }
// debug: true면 10초마다 받은 양을 항상 보여준다 (아니면 문제가 있을 때만)
function startBridgeSerial({ portPath, log = console.log, debug = false, ...handlers }) {
  const { onAudio = () => {}, onVideo = () => {}, onButton = () => {}, onStatus = () => {} } = handlers;
  const python = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
  const script = path.join(__dirname, 'serialReader.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    log('시리얼 읽기 프로그램(serialReader.py)이나 server/.venv 를 찾을 수 없습니다.');
    return { stop() {} };
  }

  const args = [script];
  if (portPath) args.push('--port', portPath);
  // PYTHONIOENCODING: Windows에서 파이썬의 한글 안내가 깨지지 않게 UTF-8로 내보낸다.
  const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let buf = Buffer.alloc(0);
  let lastWarn = '';
  let connected = false;
  // 10초 통계: USB로 받은 바이트, 종류별 프레임 수, 프레임이 아니라서 버린 바이트(데이터가 깨졌다는 신호)
  const zero = () => ({ bytes: 0, audio: 0, audioBytes: 0, video: 0, button: 0, skipped: 0, bad: 0 });
  let stats = zero();

  function parse() {
    for (;;) {
      const at = buf.indexOf(MAGIC);
      if (at < 0) {
        const keep = Math.min(buf.length, MAGIC.length - 1); // 헤더가 잘려 들어왔을 수 있어 끝 3바이트는 남긴다
        stats.skipped += buf.length - keep;
        buf = buf.subarray(buf.length - keep);
        return;
      }
      if (at > 0) { stats.skipped += at; buf = buf.subarray(at); }
      if (buf.length < HEADER_SIZE) return;
      const type = buf[4];
      const len = buf.readUInt32LE(5);
      if (len > MAX_PAYLOAD) { stats.bad++; buf = buf.subarray(MAGIC.length); continue; }
      if (buf.length < HEADER_SIZE + len) return;
      const payload = Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + len));
      buf = buf.subarray(HEADER_SIZE + len);
      if (type === TYPE_AUDIO) { stats.audio++; stats.audioBytes += len; onAudio(payload); }
      else if (type === TYPE_VIDEO) { stats.video++; onVideo(payload); }
      else if (type === TYPE_BUTTON) { stats.button++; onButton(payload.length ? payload[0] !== 0 : true); } // 데이터 1바이트: 1=누름, 0=뗌
      else stats.bad++;
    }
  }

  child.stdout.on('data', (chunk) => {
    stats.bytes += chunk.length;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    parse();
  });

  setInterval(() => {
    const s = stats;
    stats = zero();
    if (!connected) return;
    const sec = STATS_MS / 1000;
    const audioPct = Math.round((s.audioBytes / (AUDIO_BYTES_PER_SEC * sec)) * 100);
    const line = `[시리얼 ${sec}초] 받은 ${Math.round(s.bytes / 1024)}KB | 소리 ${s.audio}조각(기대치의 ${audioPct}%) | 사진 ${s.video}장 | 버튼 ${s.button} | 버린 바이트 ${s.skipped} | 이상한 헤더 ${s.bad}`;
    if (s.bytes === 0) log(`[시리얼 ${sec}초] 브릿지에서 받은 데이터가 없습니다. 안경 보드가 켜져 있고 Dating Wi-Fi에 붙었는지 확인하세요.`);
    else if (audioPct < AUDIO_WARN_RATIO * 100 || s.skipped > 0 || s.bad > 0) log(`${line}  <- 소리가 모자라거나 데이터가 깨졌습니다`);
    else if (debug) log(line);
  }, STATS_MS).unref();

  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (line.startsWith('OPEN ')) {
      lastWarn = '';
      buf = Buffer.alloc(0);
      connected = true;
      const port = line.slice(5).trim();
      log(`브릿지 보드 연결됨 (${port})`);
      onStatus(true, port);
    } else if (line.startsWith('CLOSED')) {
      connected = false;
      log('브릿지 보드 연결이 끊겼습니다.');
      onStatus(false, null);
    } else {
      const msg = line.replace(/^WAIT /, '');
      if (msg !== lastWarn) { lastWarn = msg; log(msg); } // 같은 안내는 한 번만
    }
  });
  child.on('error', (e) => log(`시리얼 읽기 프로그램을 시작하지 못했습니다: ${e.message}`));
  process.on('exit', () => { try { child.kill(); } catch {} });

  return { stop() { try { child.kill(); } catch {} } };
}

module.exports = { startBridgeSerial };
