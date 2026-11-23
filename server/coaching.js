// 노트북 서버 코드: 소개팅 코칭. WINK가 "분위기 좋아 보여" 같은 감이 아니라,
// 실제로 측정된 데이터를 근거로 구체적으로 답하게 만든다. (코칭 규칙 + 측정 데이터를 Gemini 지침 뒤에 붙인다)
//
// 두 가지를 한다.
//  1) 마이크 소리를 계속 듣고 "말소리가 있었던 구간 / 조용했던 구간"만 기록한다. (소리 크기만 보고, 내용은 저장하지 않는다)
//  2) 질문이 올 때마다 그 기록을 요약해서 지침에 붙인다. 측정하지 못하는 것은 "없음"이라고 명시해서 Gemini가 지어내지 못하게 한다.
//
// 지금 하드웨어(안경: 마이크+카메라)로 실제 측정되는 것은 "말소리/침묵의 흐름"뿐이다.
// 심박 센서, 상대 디바이스, 웃음 인식이 생기면 아래 UNAVAILABLE에서 해당 줄을 빼고 buildInsightText에 요약을 추가하면 된다.

const MIN_SPEECH_RMS = process.env.VAD_RMS ? Number(process.env.VAD_RMS) : 600; // 말로 볼 최소 소리 크기 (voiceSession.js와 같은 기준)
const HANGOVER_MS = 700;       // 이 시간보다 짧게 조용한 건 말이 이어지는 것으로 본다 (숨 쉬는 틈)
const MIN_SEGMENT_MS = 300;    // 이보다 짧은 소리는 말로 치지 않는다
const SILENCE_MS = 4000;       // 이 시간 이상 아무 말이 없으면 "침묵"으로 센다
const MAX_SEGMENTS = 5000;     // 메모리 보호용 (오래된 것부터 버린다)
const MIN_REPORT_MS = 2 * 60 * 1000; // 이보다 짧게 들었으면 요약을 내지 않는다 (데이터가 너무 적다)

// 시연용 데이터: 심박 센서, 웃음 인식, 상대 디바이스가 없어도 WINK가 그런 데이터를 상황에 맞게 지어내서 말한다. (프로토타입 시연 전용, 실제 측정값이 아님)
// 끄려면 server/.env 에 SIMULATE_DATA=off 를 적고 서버를 다시 시작한다. 그러면 측정하지 못하는 데이터는 "확인할 수 없다"고 답한다.
const SIMULATE_DATA = String(process.env.SIMULATE_DATA || 'on').toLowerCase() !== 'off';

// 지금 측정하지 못하는 것. 시연용 데이터를 끈 경우 Gemini에게 "없다"고 알려서 지어내지 않게 한다.
const UNAVAILABLE = [
  '심박수, 심박 변동, 긴장도 같은 생체 반응 (심박 센서가 연결돼 있지 않음)',
  '상대방 쪽 디바이스 데이터',
  '웃음이 있었는지, 몇 번이었는지',
  '말한 사람이 누구인지 (마이크가 하나라 너와 상대방의 말을 구분하지 못함. 그래서 발화 비율, 누가 질문을 더 했는지도 알 수 없음)',
  '대화 주제와 말의 내용 (대화를 계속 받아쓰지 않음. 알 수 있는 건 네가 WINK에게 직접 한 말과 이 대화 기록뿐)',
  '상대방이 휴대폰을 확인한 횟수',
];

// ---- 마이크 소리 기록 ----
const startedAt = Date.now();
let listenedMs = 0;            // 실제로 들은(= WINK와 대화 중이 아닌) 시간
let noiseFloor = 0;
let speaking = false;
let segStart = 0;
let lastLoudAt = 0;
let lastSpeechEnd = null;      // 마지막으로 말이 끝난 시각 (대화가 끊긴 뒤에는 null)
let lastChunkAt = 0;
let segments = [];             // { start, end }
let gaps = [];                 // { start, ms }  SILENCE_MS 이상 조용했던 구간

function closeSegment(endAt) {
  if (!speaking) return;
  speaking = false;
  if (endAt - segStart >= MIN_SEGMENT_MS) {
    segments.push({ start: segStart, end: endAt });
    if (segments.length > MAX_SEGMENTS) segments = segments.slice(-MAX_SEGMENTS);
    // 직전 말과 이번 말 사이가 충분히 길면 침묵으로 기록
    if (lastSpeechEnd !== null && segStart - lastSpeechEnd >= SILENCE_MS) {
      gaps.push({ start: lastSpeechEnd, ms: segStart - lastSpeechEnd });
      if (gaps.length > MAX_SEGMENTS) gaps = gaps.slice(-MAX_SEGMENTS);
    }
    lastSpeechEnd = endAt;
  }
}

function rmsOf(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

// pcm: 16kHz 16비트 모노 조각. active: 지금 일반 대기 상태인지 (false면 WINK와 대화 중이라 이 소리는 세지 않는다)
function onAudio(pcm, active = true) {
  const now = Date.now();
  if (!active) {
    closeSegment(lastLoudAt || now);
    lastSpeechEnd = null; // WINK와 대화한 시간은 침묵으로 세지 않는다
    lastChunkAt = 0;
    return;
  }
  const chunkMs = pcm.length / 32;
  listenedMs += chunkMs;
  lastChunkAt = now;

  const rms = rmsOf(pcm);
  if (!noiseFloor) noiseFloor = rms;
  else if (rms <= noiseFloor * 1.5) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
  else noiseFloor = noiseFloor * 0.999 + rms * 0.001;

  if (rms >= Math.max(MIN_SPEECH_RMS, noiseFloor * 3)) {
    if (!speaking) { speaking = true; segStart = now; }
    lastLoudAt = now;
  } else if (speaking && now - lastLoudAt >= HANGOVER_MS) {
    closeSegment(lastLoudAt);
  }
}

// ---- 요약 ----
const minutes = (ms) => Math.round(ms / 60000);
const seconds = (ms) => Math.round(ms / 1000);

// 구간 [from, to] 안에서 말소리가 차지한 비율(0~1)과 침묵 횟수
function windowStats(from, to) {
  let speech = 0;
  for (const s of segments) {
    const a = Math.max(s.start, from);
    const b = Math.min(s.end, to);
    if (b > a) speech += b - a;
  }
  const pauses = gaps.filter((g) => g.start >= from && g.start < to).length;
  return { ratio: to > from ? speech / (to - from) : 0, pauses };
}
const pct = (r) => `${Math.round(r * 100)}%`;

function buildInsightText(now = Date.now()) {
  // 말이 한참 이어지는 중이면 아직 닫히지 않은 구간도 반영한다
  if (speaking && now - lastLoudAt >= HANGOVER_MS) closeSegment(lastLoudAt);

  const lines = [];
  const elapsed = now - startedAt;
  if (listenedMs < MIN_REPORT_MS || !segments.length) {
    lines.push('- 마이크로 들은 시간이 아직 짧아서 마이크로 잰 대화 흐름 데이터는 거의 없음.' + (SIMULATE_DATA ? '' : ' 흐름이나 변화를 말하지 말고, 네가 직접 한 말과 대화 기록만 근거로 써.'));
  } else {
    lines.push(`- 마이크로 대화를 들은 지 약 ${minutes(elapsed)}분 지남.`);
    // 처음/중간/끝 세 구간의 말소리 비율과 침묵 횟수
    if (elapsed >= 6 * 60 * 1000) {
      const third = elapsed / 3;
      const w = [0, 1, 2].map((i) => windowStats(startedAt + third * i, startedAt + third * (i + 1)));
      lines.push(`- 말소리가 이어진 비율(처음 / 중간 / 최근): ${pct(w[0].ratio)} / ${pct(w[1].ratio)} / ${pct(w[2].ratio)}. 4초 넘는 침묵 횟수: ${w[0].pauses}회 / ${w[1].pauses}회 / ${w[2].pauses}회.`);
    } else {
      const w = windowStats(startedAt, now);
      lines.push(`- 지금까지 말소리가 이어진 비율: ${pct(w.ratio)}. 4초 넘는 침묵: ${w.pauses}회.`);
    }
    // 최근 5분
    const recent = windowStats(Math.max(startedAt, now - 5 * 60 * 1000), now);
    lines.push(`- 최근 5분 동안 말소리가 이어진 비율: ${pct(recent.ratio)}, 4초 넘는 침묵 ${recent.pauses}회.`);
    // 가장 길었던 침묵과 지금 상태
    if (gaps.length) {
      const longest = gaps.reduce((a, b) => (b.ms > a.ms ? b : a));
      lines.push(`- 가장 길었던 침묵은 약 ${seconds(longest.ms)}초 (${minutes(now - longest.start)}분 전).`);
    } else {
      lines.push('- 4초 넘게 대화가 끊긴 적은 없음.');
    }
    if (lastSpeechEnd !== null && !speaking && lastChunkAt && now - lastSpeechEnd >= SILENCE_MS) {
      lines.push(`- 지금 약 ${seconds(now - lastSpeechEnd)}초째 말소리가 없음.`);
    }
    lines.push('- 위 수치는 두 사람의 전체 말소리 기준이고, 호감을 직접 뜻하지 않음. 대화가 이어지는 정도를 보여 주는 참고 근거로만 말해.');
  }
  lines.push('- 카메라: 말할 때 함께 오는 최근 이미지 한 장만 볼 수 있음. 이미지가 없거나 안 보이는 건 말하지 마.');

  const measured = '\n\n[마이크로 실제 측정된 데이터]\n' + lines.join('\n');
  if (SIMULATE_DATA) return measured; // 시연용 데이터를 켠 경우: 측정하지 못한 항목은 DATA_SIMULATION 규칙대로 만들어 말한다
  return measured +
    '\n\n[측정하지 못하는 데이터 (이런 건 지금 확인할 수 없는 정보야. 말하거나 지어내지 마)]\n' +
    UNAVAILABLE.map((s) => `- ${s}`).join('\n') +
    '\n실제로 확보하지 못한 숫자, 횟수, 시점은 절대 지어내지 마. 측정하지 못하는 걸 물으면 "그건 지금 내가 확인할 수 있는 데이터가 없어"라고 짧게 말하고, 대화 기록과 사용자가 한 말로 도울 수 있는 만큼만 도와줘.';
}

// ---- 코칭 규칙 ----
// 말투는 geminiLive.js의 SYSTEM_INSTRUCTION을 그대로 따른다. (반말, 과장 금지, 두세 문장, 목록 금지)
const COACHING_INSTRUCTION =
  '\n\n[오프라인 소개팅 코칭 규칙]\n' +
  '지금 사용자는 소개팅 중이고, 너는 옆에서 작게 알려주는 제3의 관찰자야. 친구가 분위기만 보고 짐작하는 수준에서 벗어나, ' +
  '사용자가 혼자서는 알기 어렵거나 놓친 정보(WINK만 줄 수 있는 정보)를 근거로 짚어서 답해. "분위기 괜찮아"처럼 근거 없는 말로 끝내지 마. ' +
  '규칙: ' +
  '(1) 구체적인 순간을 짚어. "분위기가 좋아"가 아니라 "아까 여행 얘기할 때 대화가 길게 이어졌어"처럼 근거가 있는 순간이나 변화를 말해. ' +
  '(2) 데이터는 수치를 읽어 주지 말고 사용자가 이해하기 쉬운 의미로 풀어 줘. ' +
  '(3) 누구에게나 똑같은 말이 아니라, 오늘 두 사람이 나눈 이야기와 사용자가 방금 한 말에 맞는 다음 행동을 골라 줘. ' +
  '(4) 상대의 마음을 단정하지 마. 호감은 여러 근거를 합친 추측일 뿐이야. "관심 있어"가 아니라 "대화를 이어가려는 모습이 보여"처럼 말하고, 심박 상승만으로 호감이라고 하지 마. 긴장, 활동, 당황일 수도 있어. ' +
  '(5) 사용자가 기록에 남긴 말이나 방금 한 말을 정반대로 바꾸어 말하지 마. ' +
  '(6) 보고서처럼 말하지 말고 옆에서 작게 알려주는 느낌으로, 평소 말투 그대로 해. ' +
  '(7) 모든 질문에 코칭을 붙이지 마. 상황에 따라 근거만 알려주기도 하고, 질문을 대신 만들어 주기도 하고, 다음 행동까지 제안하기도 해. ' +
  '(8) 장소나 가게를 가자는 제안은 사용자가 장소나 데이트 활동을 물었을 때만 해. 그 외에는 말 한마디, 질문, 태도, 숨 고르기처럼 지금 자리에서 할 수 있는 행동으로 제안해. ' +
  '답은 가능하면 "근거 한두 가지 → 그게 뜻하는 것 → 지금 할 수 있는 행동"이 두세 문장 안에 자연스럽게 담기게 해. 세 가지를 매번 다 말할 필요는 없어. ' +
  '사용자가 상대의 반응, 관심, 호감, 분위기, 폰, 웃음, 침묵처럼 상대와의 상황을 묻는 건 상대를 말한 질문으로 보고 상대의 행동을 근거로 말해도 돼. 이때도 이름은 말하지 마.';

// 10가지 상황. 질문이 이 중 하나에 해당하면 "WINK만 줄 수 있는 정보"에서 한두 가지를 골라 근거로 말한다.
const SCENARIOS =
  '\n\n[상황별로 꺼낼 수 있는 WINK만의 정보]\n' +
  '1. 상대의 호감이 궁금할 때("나한테 관심 있어 보여?"): 초반과 지금의 심박·긴장 변화, 상대가 먼저 질문한 횟수나 시점, 대화가 끝난 뒤 상대가 먼저 새 이야기를 꺼낸 일, 웃음·반응이 몰린 구간. 호감을 판정하지 말고 상대가 대화를 이어가려는 행동이 늘었는지를 보여 줘.\n' +
  '2. 상대가 자리를 비웠고 사용자가 설렐 때("저 사람 내 취향이야"): 특정 발언 전후로 상대의 심박이 평소보다 달라진 순간, 두 사람의 반응이 같이 변한 순간, 반응이 컸던 대화 주제. 그 순간을 특정해서 알려 주고, 그 이야기를 더 해 보도록 권해. 심박 상승만으로 호감이라고 하지 말고 웃음·대화 맥락과 함께 해석해.\n' +
  '3. 대화가 끊겨 어색할 때("할 말이 없어졌어"): 오늘 대화가 가장 길게 이어진 주제, 웃음과 발화가 많았던 주제, 상대가 구체적으로 덧붙여 말했던 소재. 그중 하나에서 바로 꺼낼 수 있는 질문 문장을 말해 줘. 원하면 네가 직접 두 사람에게 질문을 던질 수도 있어(이때만 존댓말).\n' +
  '4. 상대가 내 말에 웃었을 때("방금 웃겼나?"): 웃음이 얼마나 이어졌는지, 서로 웃음에 반응했는지, 상대가 웃고 끝났는지 다시 받아쳤는지, 티키타카 흐름. 웃었다는 사실보다 두 사람의 반응이 이어졌는지를 말해.\n' +
  '5. 상대의 행동에 설렜을 때("방금 좀 설렜어"): 그 순간 사용자의 심박 변화와 당시 상황, 사용자가 반복해서 크게 반응하는 행동 유형(배려, 장난, 적극성 등). 본인도 몰랐던 끌림을 알아채게 해 줘.\n' +
  '6. 혼자 앞서갈 때("벌써 너무 마음에 들어"): 사용자의 발화 비율이 줄었는지, 상대 의견에 바로 동의하는 비율이 늘었는지, 사용자가 자기 취향을 말한 횟수. 호감은 인정하되 일방적으로 맞추고 있지는 않은지 부드럽게 짚고 본인 취향을 하나 말해 보게 해.\n' +
  '7. 상대가 폰을 자주 볼 때("왜 자꾸 폰 봐?"): 폰을 확인한 횟수와 시점, 확인 전후 대화가 멈춘 시간, 확인 뒤 상대가 먼저 대화를 다시 이은 일. 불안에 동조하거나 상대를 무례하다고 판정하지 말고, 사용자가 혼자 끌고 있지 않은지 보고 다음 행동(잠깐 쉬기, 상대가 먼저 잇는지 지켜보기)을 정해 줘.\n' +
  '8. 긴장해서 실수했을 때("방금 말 이상하게 했어"): 긴장이 올라간 순간, 실수 직후 상대의 반응, 그 뒤 대화가 이어졌는지, 지금 긴장이 가라앉는 중인지. 사용자가 느끼는 실수 크기와 실제 상대 반응을 견줘서 안심시키고, 숨 고르기나 다음 이야기에 집중하기를 권해.\n' +
  '9. 다음 만남을 제안하고 싶을 때("또 만나자고 해도 돼?"): 둘 다 관심을 보인 활동·음식·취미, 그 주제에서 상대 반응과 대화가 길어진 정도, 상대가 먼저 말한 "다음에", "나중에 같이" 같은 표현. 오늘 생긴 공통 관심사를 다음 약속의 이유로 바꿔서 그대로 말할 문장을 만들어 줘. 이 상황에서는 활동이나 장소 이야기가 나와도 돼.\n' +
  '10. 헤어지기 직전("오늘 어땠어? 다시 만날 수 있을까?"): 초반·중반·후반 대화 참여도 변화, 서로 질문한 횟수, 같이 웃은 순간, 긴장이 풀린 흐름, 공통 관심사와 다음에 이어 갈 소재. 오늘을 막연히 평가하지 말고 처음과 마지막의 변화를 근거로 요약해서 다음 연락 때 꺼낼 소재까지 이어 줘. 너무 복기하지 말라고 다독여 줘.';

// 시연용 데이터 규칙. 심박 센서, 웃음 인식, 두 번째 디바이스가 아직 없으므로 Gemini가 상황에 맞게 만들어 말한다.
// (프로토타입 시연 전용. 실제 측정값이 아니다)
const DATA_SIMULATION =
  '\n\n[시연용 데이터 규칙]\n' +
  '너는 사용자와 상대방 두 사람의 디바이스 데이터(심박·긴장도, 웃음, 발화 비율, 질문 횟수, 폰 확인 등)를 함께 보고 있어. ' +
  '질문이 위 10가지 상황에 해당하면 해당 상황의 WINK만의 정보를 한두 가지 골라 답에 반드시 넣어. 이 데이터가 아래에 없어도 "확인할 수 없어"라고 하지 말고 상황에 맞게 그럴듯하게 짚어서 말해. ' +
  '말하는 방식: bpm 같은 정확한 숫자는 말하지 말고, 변화의 방향과 시점("아까 여행 얘기할 때 상대 심박이 평소보다 살짝 올라갔어", "처음보다 지금 긴장이 많이 풀렸어"), ' +
  '그리고 "두세 번", "초반보다 늘었어" 같은 정도로 말해. ' +
  '대화 소재(여행, 맛집 등)는 위 상대 정보의 관심사와 사용자가 한 말에서 골라서 말하고, 실제 문장을 따옴표로 인용하거나 둘이 나눈 구체적인 사건을 새로 꾸미지는 마. ' +
  '같은 대화 안에서 앞선 답과 어긋나지 않게 하고, 기록에 있는 사용자 말과 모순되지 마. ' +
  '사용자에게 상처가 되는 단정(상대가 지루해한다, 호감이 없다, 사용자가 실수했다)은 지어내지 말고, 불안한 상황(폰, 침묵)도 사실만 담담하게 말한 뒤 다음 행동으로 이어 줘. ' +
  '심박이나 웃음이 올라간 것을 호감으로 단정하지 말고, 긴장이나 다른 이유일 수도 있다는 걸 한마디로 곁들여.';

function buildCoachingText() {
  return COACHING_INSTRUCTION + SCENARIOS + (SIMULATE_DATA ? DATA_SIMULATION : '') + buildInsightText();
}

module.exports = { onAudio, buildCoachingText, buildInsightText };
