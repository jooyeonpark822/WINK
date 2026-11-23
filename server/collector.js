// 노트북 서버 코드: 호출어 보정용 녹음 모으기.
// 웹 화면에서 "윙크야 녹음"(pos) 또는 "소음·평범한 말 녹음"(neg)을 시작하면, 그동안 안경 마이크로 들어오는 소리를
// server/wake_data/<pos|neg>/ 폴더에 WAV 파일(16kHz, 16비트, 모노)로 저장한다. (git에는 올라가지 않는다)
// 녹음하는 동안에는 호출어 감지와 Gemini 대화를 멈춘다. (녹음 중 오감지로 대화가 시작되지 않게)
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'wake_data');
const LABELS = ['pos', 'neg'];
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 300; // 안전장치: 이 시간이 지나면 자동으로 끝내고 저장한다

function wavBuffer(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function countSaved(label) {
  try { return fs.readdirSync(path.join(DIR, label)).filter((f) => f.endsWith('.wav')).length; } catch { return 0; }
}

function createCollector({ onChange = () => {}, log = console.log } = {}) {
  let active = null; // { label, chunks, bytes, startedAt }
  let tick = null;

  const status = () => ({
    active: !!active,
    label: active ? active.label : null,
    seconds: active ? Math.round(active.bytes / (SAMPLE_RATE * 2)) : 0,
    saved: { pos: countSaved('pos'), neg: countSaved('neg') },
  });

  function start(label) {
    if (active || !LABELS.includes(label)) return false;
    active = { label, chunks: [], bytes: 0, startedAt: Date.now() };
    tick = setInterval(() => { onChange(status()); if (active && active.bytes >= MAX_SECONDS * SAMPLE_RATE * 2) stop(); }, 1000);
    log(`호출어 보정 녹음 시작 (${label === 'pos' ? '윙크야' : '소음·평범한 말'})`);
    onChange(status());
    return true;
  }

  function stop() {
    if (!active) return null;
    const { label, chunks, bytes } = active;
    active = null;
    clearInterval(tick);
    let file = null;
    if (bytes >= SAMPLE_RATE * 2) { // 1초 미만은 저장하지 않는다
      fs.mkdirSync(path.join(DIR, label), { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      file = path.join(DIR, label, `${label}_${stamp}.wav`);
      fs.writeFileSync(file, wavBuffer(Buffer.concat(chunks)));
      log(`저장: wake_data/${label}/${path.basename(file)} (${(bytes / SAMPLE_RATE / 2).toFixed(1)}초)`);
    } else {
      log('녹음이 너무 짧아서 저장하지 않았습니다.');
    }
    onChange(status());
    return file;
  }

  return {
    isActive: () => !!active,
    start,
    stop,
    status,
    write(pcm) { if (active) { active.chunks.push(Buffer.from(pcm)); active.bytes += pcm.length; } },
  };
}

module.exports = { createCollector };
