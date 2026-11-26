// 노트북 서버 코드: 안경 마이크 소리 -> (컨트롤러 버튼을 누르는 동안 | 호출어) 녹음 -> Gemini Live -> 응답.
//
//  idle(대기)      : Gemini로는 아무것도 보내지 않는다. (호출어 감지를 켠 경우에만 소리를 감지기에 넣는다)
//  listening(듣는 중): 컨트롤러 버튼을 누르고 있는 동안만 Gemini 연결을 열고 말하는 소리를 바로바로 보낸다.
//                    버튼을 떼면 끝이다. (호출어로 시작했다면 말을 시작한 뒤 잠깐 조용해질 때 끝낸다)
//  thinking(생각 중) : 말이 끝났고 Gemini의 답을 기다린다.
//  answering(답하는 중): Gemini가 답하기 시작했다. 끝나면 다시 idle.
const { startLiveTurn } = require('./geminiLive');
const history = require('./conversationHistory');

const PRE_ROLL_CHUNKS = 2;       // 호출어 감지가 약간 늦게 오므로, 직전 조각 2개(약 200ms)를 같이 보낸다
const NO_SPEECH_MS = 6000;       // 호출어 뒤 이 시간 안에 말이 시작되지 않으면 포기한다
const END_SILENCE_MS = 1200;     // 말한 뒤 이 시간 동안 조용하면 말이 끝난 것으로 본다
const MAX_LISTEN_MS = 20000;     // 아무리 길어도 이 시간에서 끊는다
const MIN_SPEECH_MS = 300;       // 이보다 짧은 소리는 말로 치지 않는다
const FRAME_FRESH_MS = 5000;     // 이 시간 안에 찍힌 카메라 사진만 Gemini에 함께 보낸다
const WAKE_MUTE_EXTRA_MS = 1000; // WINK 대답이 다 재생된 뒤에도 이 시간 동안은 호출어 감지를 더 쉰다
const MIN_HOLD_MS = 400;        // 버튼을 이보다 짧게 누르면(톡 건드림) 말한 게 아니라고 보고 취소한다
const MAX_HOLD_MS = 60000;       // 버튼을 뗀다는 신호를 놓쳐도 이 시간이 지나면 끝낸다 (계속 듣는 일을 막는 안전장치)
const NOISE_FLOOR_MIN_RMS = 600; // 말로 볼 최소 소리 크기 (server/.env의 VAD_RMS로 조절)

function rmsOf(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

// emit(type, data): 웹 화면으로 보낼 사건. type: state | wake | input | output | audio | frame | problem | history
function createVoiceSession({ apiKey, wake, emit, log = console.log, minSpeechRms = NOISE_FLOOR_MIN_RMS, onSpeakerAudio = () => {} }) {
  let state = 'idle';
  let turn = null;
  let preRoll = [];
  let lastFrame = null;           // { jpeg, at }
  let noiseFloor = 0;             // 조용할 때의 평균 소리 크기 (주변 소음 기준)
  let listenStart = 0;
  let speechMs = 0;
  let silenceMs = 0;
  let speechStarted = false;
  let gotReply = false;
  let heardText = '';             // 이번 대화에서 Gemini가 받아쓴 내 말 (로그용)
  let answerText = '';            // 이번 대화에서 Gemini가 한 답 (로그용)
  let holdMode = false;          // 버튼을 누르고 있는 동안만 듣는 대화인지 (true면 말 끝 판단을 하지 않는다)
  // WINK 대답 소리가 스피커로 다 나오기 전에 서버는 먼저 대기 상태가 된다. 그 소리를 안경 마이크가 다시 듣고
  // 호출어로 착각하지 않도록, 대답이 다 재생될 때까지(+여유 1초)는 호출어 감지기에 소리를 넣지 않는다.
  let replyFirstAt = 0;          // 이번 대답의 첫 소리가 온 시각
  let replyMs = 0;               // 이번 대답 소리의 총 길이 (24kHz 16비트 모노 = 1ms에 48바이트)
  let wakeMuteUntil = 0;         // 이 시각까지는 호출어 감지를 쉰다

  const setState = (s, extra = {}) => { state = s; emit('state', { state: s, ...extra }); };

  function speechThreshold() { return Math.max(minSpeechRms, noiseFloor * 3); }

  function finishTurn(reason) {
    turn = null;
    preRoll = [];
    // 한 번의 대화가 끝날 때 무슨 말을 듣고 뭐라고 답했는지 남긴다
    if (heardText || answerText) log(`대화 끝${reason ? ` (${reason})` : ''} | 들은 말: ${heardText.trim() || '(없음)'} | 답: ${answerText.trim() || '(없음)'}`);
    else log(`대화 끝${reason ? ` (${reason})` : ''}`);
    // 대화 기록에 남겨서 다음 대화 때 Gemini가 기억하게 한다 (오류로 끝났어도 내 말이 있으면 남긴다)
    const item = history.add(heardText, answerText);
    if (item) emit('history', item);
    heardText = '';
    answerText = '';
    if (replyMs > 0) wakeMuteUntil = Math.max(Date.now(), replyFirstAt + replyMs) + WAKE_MUTE_EXTRA_MS;
    replyFirstAt = 0;
    replyMs = 0;
    setState('idle', reason ? { reason } : {});
  }

  // why: 'wake'(호출어) 또는 'button'(컨트롤러 버튼을 누름). 버튼은 직전 소리를 붙이지 않는다.
  function startListening(why, detail) {
    const byButton = why === 'button';
    log(byButton ? '버튼 누름 -> 듣는 중' : `호출어 감지 (점수 ${detail}) -> 듣는 중`);
    if (byButton) preRoll = [];
    holdMode = byButton;
    emit('wake', { via: byButton ? 'button' : 'wake', score: byButton ? null : detail }); // 웹 화면의 호출어 불빛용
    const fresh = lastFrame && Date.now() - lastFrame.at < FRAME_FRESH_MS ? lastFrame.jpeg : null;
    gotReply = false;
    // history: 지금까지의 대화 기록을 함께 보내서 Gemini가 이전 대화를 기억하고 이어가게 한다
    const t = startLiveTurn(apiKey, { image: fresh, history: history.recent() }, {
      onInputText: (text) => { heardText += text; emit('input', { text }); },
      onOutputText: (text) => { answerText += text; markReply(); emit('output', { text }); },
      onOutputAudio: (pcm) => { if (!replyFirstAt) replyFirstAt = Date.now(); replyMs += pcm.length / 48; markReply(); emit('audio', { pcm: pcm.toString('base64') }); onSpeakerAudio(pcm); },
    });
    turn = t;
    t.done.then(
      () => { if (turn === t) finishTurn(); },
      (err) => {
        if (turn !== t) return;
        log(`Gemini 오류: ${err.message}`);
        emit('problem', { message: err.message });
        finishTurn('error');
      },
    );
    listenStart = Date.now();
    speechMs = 0;
    silenceMs = 0;
    speechStarted = false;
    setState('listening');
    for (const c of preRoll) t.write(c);
    preRoll = [];
  }

  function markReply() {
    if (gotReply) return;
    gotReply = true;
    if (state === 'thinking') setState('answering');
  }

  function stopListening(send, reason = 'no-speech') {
    const t = turn;
    if (!t) return;
    if (send) {
      t.end();
      setState('thinking');
    } else {
      turn = null;
      t.cancel();
      finishTurn(reason);
    }
  }

  function onChunk(pcm) {
    const rms = rmsOf(pcm);
    const chunkMs = pcm.length / 32; // 16kHz x 2바이트 = 1ms에 32바이트

    if (state === 'idle') {
      // 주변 소음 크기: 조용할 때는 빠르게 따라가고, 갑자기 커질 때(말소리)는 거의 따라가지 않는다.
      // (말소리가 소음으로 학습돼서 기준이 계속 올라가는 걸 막는다)
      if (!noiseFloor) noiseFloor = rms;
      else if (rms <= noiseFloor * 1.5) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      else noiseFloor = noiseFloor * 0.999 + rms * 0.001;
      preRoll.push(pcm);
      if (preRoll.length > PRE_ROLL_CHUNKS) preRoll.shift();
      if (Date.now() >= wakeMuteUntil) wake.write(pcm);
      return;
    }
    if (state !== 'listening' || !turn) return; // 생각 중/답하는 중에는 소리를 보내지 않는다

    turn.write(pcm);
    const now = Date.now();
    if (holdMode) {  // 버튼을 누르고 있는 동안은 계속 보낸다. 끝은 버튼을 뗄 때 정해진다. (아래 onButton)
      if (now - listenStart >= MAX_HOLD_MS) stopListening(true);
      return;
    }
    if (rms >= speechThreshold()) {
      speechStarted = true;
      speechMs += chunkMs;
      silenceMs = 0;
    } else if (speechStarted) {
      silenceMs += chunkMs;
    }

    if (speechStarted && silenceMs >= END_SILENCE_MS) {
      return stopListening(speechMs >= MIN_SPEECH_MS);
    }
    if (!speechStarted && now - listenStart >= NO_SPEECH_MS) return stopListening(false);
    if (now - listenStart >= MAX_LISTEN_MS) return stopListening(speechStarted);
  }

  wake.onWake((score) => { if (state === 'idle') startListening('wake', score); });

  return {
    onAudio: onChunk,
    // 컨트롤러 버튼: 누르면(pressed=true) 듣기 시작하고, 떼면(false) 듣기를 끝내고 Gemini의 답을 기다린다.
    // 이미 대화 중에 누른 건 무시한다. 너무 짧게 누른 건 취소한다.
    onButton(pressed) {
      if (pressed) {
        if (state === 'idle') startListening('button');
      } else if (state === 'listening' && holdMode) {
        const heldMs = Date.now() - listenStart;
        log(`버튼 뗌 (${(heldMs / 1000).toFixed(1)}초 눌렀음) -> ${heldMs >= MIN_HOLD_MS ? 'Gemini 답을 기다림' : '너무 짧아서 취소'}`);
        stopListening(heldMs >= MIN_HOLD_MS, 'too-short');
      } else if (state !== 'idle') {
        log(`버튼 뗌 신호를 받았지만 지금은 '${state}' 상태라 무시`);
      }
    },
    onVideo(jpeg) { lastFrame = { jpeg, at: Date.now() }; emit('frame', {}); },
    getFrame: () => (lastFrame ? lastFrame.jpeg : null),
    getState: () => state,
  };
}

module.exports = { createVoiceSession };
