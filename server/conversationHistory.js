// 노트북 서버 코드: WINK와 나눈 대화 기록을 저장한다. (Gemini가 이전 대화를 기억하게 하는 데 쓴다)
// 기록은 server/history.json 파일에 남아서 서버를 다시 켜도 이어진다. (git에는 올라가지 않는다: .gitignore)
// 파일이 너무 커지지 않게 최근 MAX_SAVED개만 저장하고, Gemini에게는 그중 최근 MAX_SENT개만 알려준다.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'history.json');
const MAX_SAVED = 200;  // 파일에 남기는 최대 주고받기 수
const MAX_SENT = 20;    // Gemini에게 알려주는 최근 주고받기 수 (길수록 기억은 길지만 응답이 느려지고 비용이 는다)

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];  // 파일이 없거나 깨졌으면 빈 기록으로 시작
  }
}

let items = load();

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (e) {
    console.log(`대화 기록을 저장하지 못했습니다: ${e.message}`);
  }
}

module.exports = {
  // 한 번의 주고받기를 추가한다. 내 말이 비어 있으면(받아쓰기 실패) 남기지 않는다.
  add(user, wink) {
    user = String(user || '').trim();
    wink = String(wink || '').trim();
    if (!user) return null;
    const item = { user, wink: wink || '(답 없음)', at: new Date().toISOString() };
    items.push(item);
    if (items.length > MAX_SAVED) items = items.slice(-MAX_SAVED);
    save();
    return item;
  },
  // Gemini에게 알려줄 최근 기록 (오래된 것부터)
  recent: (n = MAX_SENT) => items.slice(-n).map(({ user, wink }) => ({ user, wink })),
  // 웹 화면에 보여줄 전체 기록
  all: () => items.slice(),
  // 기록을 모두 지운다 (새 대화 시작)
  clear() {
    items = [];
    save();
  },
};
