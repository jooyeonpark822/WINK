// 노트북 서버 코드: 호출어("윙크야") 감지 프로그램(wakeword.py, microWakeWord)을 띄우고 마이크 소리를 넣어 준다.
// 호출어가 들릴 때만 Gemini로 소리를 보내서, 호출어 없는 대화는 Gemini로 나가지 않게 한다.
// Python 환경(server/.venv)이 없으면 null을 돌려준다. (호출어 없이는 시작하지 않는다)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MAX_BACKLOG = 256 * 1024; // 감지기가 못 따라오면 소리를 더 쌓지 않는다

// threshold: 호출어로 볼 점수 기준 (0~1, 선택). 낮을수록 잘 반응하지만 오감지도 늘어난다.
function createWakeDetector({ threshold, log = console.log, debug = false } = {}) {
  const python = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
  const script = path.join(__dirname, 'wakeword.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) return null;

  const args = [script];
  if (threshold !== undefined && !Number.isNaN(threshold)) args.push('--threshold', String(threshold));
  if (debug) args.push('--debug');
  // PYTHONIOENCODING: Windows에서 파이썬의 한글 출력이 깨지지 않게 UTF-8로 내보낸다.
  const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let ready = false;
  let word = '';  // 호출어 이름 (wakeword.py 의 기본 이름)
  const listeners = [];
  const readyListeners = [];

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'ready') {
      ready = true;
      word = msg.word || '';
      log(`호출어 감지기 준비됨 ("${word}", 모델 ${msg.model}, 기준 ${msg.cutoff}${msg.verifier ? ', 내 목소리 검증 모델 사용' : ''})`);
      for (const cb of readyListeners) cb(word);
    } else if (msg.event === 'wake') {
      for (const cb of listeners) cb(msg.score);
    }
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (debug && line.trim() && !line.startsWith('INFO:')) log(line);
  });
  child.stdin.on('error', () => {}); // 감지기가 꺼진 뒤에 쓰다가 나는 오류는 무시한다
  child.on('error', (err) => { ready = false; log('호출어 감지기를 시작하지 못했습니다:', err.message); });
  child.on('exit', (code) => {
    if (ready) log(`호출어 감지기가 종료되었습니다 (코드 ${code}).`);
    ready = false;
  });
  process.on('exit', () => { try { child.kill(); } catch {} });

  return {
    isReady: () => ready,
    getWord: () => word,
    write(buf) {
      if (ready && child.stdin.writable && child.stdin.writableLength < MAX_BACKLOG) child.stdin.write(buf);
    },
    onWake(cb) { listeners.push(cb); },
    onReady(cb) { readyListeners.push(cb); },
    stop() { try { child.kill(); } catch {} },
  };
}

module.exports = { createWakeDetector };
