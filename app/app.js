const APP_STORAGE_KEY = "jlpt-study-state-v1";
const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
const REVIEW_INTERVALS = {
  1: 2 * 24 * 60 * 60 * 1000,
  2: 3 * 24 * 60 * 60 * 1000,
  3: 7 * 24 * 60 * 60 * 1000,
  4: 14 * 24 * 60 * 60 * 1000,
};
const MEANING_SYNONYM_GROUPS = [
  ["사이", "간격"],
  ["뜻", "의미"],
  ["색", "색깔"],
  ["아침밥", "아침 식사", "조식"],
  ["점심밥", "점심 식사", "중식"],
  ["저녁밥", "저녁 식사", "석식"],
  ["바깥", "밖", "외부"],
  ["뒤", "후방", "후면", "뒷쪽", "뒷편"],
  ["나중", "이후", "뒤에"],
  ["저기", "저곳"],
  ["저쪽", "저편"],
  ["집", "가옥", "주택", "댁"],
  ["아기", "유아"],
  ["아이", "어린이", "아동"],
  ["개", "강아지", "견"],
  ["바다", "해양"],
  ["겉옷", "상의", "웃옷"],
  ["그림", "삽화"],
  ["동반자", "파트너"],
  ["모임", "집회"],
  ["사랑", "애정"],
  ["돈", "금전"],
  ["나라", "국가", "왕국"],
  ["의자", "걸상"],
  ["연못", "못"],
  ["회사", "기업"],
  ["꽃병", "화병"],
  ["소고기", "쇠고기"],
  ["꽃", "화"],
  ["소", "쇠"],
];
const MEANING_IGNORABLE_TOKENS = new Set(["그", "이", "저"]);
const MEANING_SYNONYM_MAP = buildMeaningSynonymMap();

const root = document.getElementById("app");

const runtime = {
  route: "home",
  studyTab: "study",
  boardTab: "in-progress",
  boardLevel: "all",
  studySession: null,
  archiveSession: null,
  timerId: null,
  auth: {
    status: "loading",
    user: null,
    clientId: "",
    googleReady: false,
    error: "",
    syncMessage: "",
  },
  syncTimer: 0,
};
const semanticDecisionCache = new Map();

const levelCatalog = buildLevelCatalog();
const words = LEVELS.flatMap((level) => levelCatalog[level] || []);
const wordMap = new Map(words.map((word) => [word.uid, word]));
let state = hydrateState();

initializeRoute();
window.addEventListener("hashchange", syncRoute);
root.addEventListener("click", handleClick);
root.addEventListener("submit", handleSubmit);
startClock();
bootApp();

function buildLevelCatalog() {
  const catalog = {
    N5: normalizeLevelData(typeof WORDS_DATA !== "undefined" ? WORDS_DATA : [], "N5"),
    N4: normalizeLevelData(typeof N4_VOCAB_DATA !== "undefined" ? N4_VOCAB_DATA : [], "N4"),
    N3: normalizeLevelData(typeof N3_VOCAB_DATA !== "undefined" ? N3_VOCAB_DATA : [], "N3"),
    N2: [],
    N1: [],
  };

  return catalog;
}

function normalizeLevelData(source, fallbackLevel) {
  return source.map((item, index) => {
    const level = item.level || fallbackLevel;
    return {
      uid: `${level}-${item.id}`,
      sourceId: item.id,
      order: index,
      level,
      day: Number(item.day) || 1,
      kanji: item.kanji,
      hiragana: item.hiragana,
      meaning: item.meaning,
    };
  });
}

function hydrateState() {
  const stored = safeParse(localStorage.getItem(APP_STORAGE_KEY)) || {};
  return createStateFromSnapshot(stored);
}

function createStateFromSnapshot(snapshot = {}) {
  const progress = {};

  for (const word of words) {
    const record = snapshot.progress?.[word.uid] || {};
    progress[word.uid] = {
      stage: clampNumber(record.stage, 0, 4, 0),
      studyCount: Number(record.studyCount) || 0,
      correctHits: Number(record.correctHits) || 0,
      wrongHits: Number(record.wrongHits) || 0,
      nextReviewAt: Number(record.nextReviewAt) || 0,
      lastStudiedAt: Number(record.lastStudiedAt) || 0,
      lastStudiedDay: record.lastStudiedDay || "",
    };
  }

  return {
    meta: {
      updatedAt: Number(snapshot.meta?.updatedAt) || 0,
    },
    settings: {
      randomOrder: Boolean(snapshot.settings?.randomOrder),
      randomLevel: Boolean(snapshot.settings?.randomLevel),
    },
    archiveRuns: Array.isArray(snapshot.archiveRuns) ? snapshot.archiveRuns : [],
    progress,
  };
}

function saveState() {
  state.meta.updatedAt = Date.now();
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
  queueServerSync();
}

function saveStateLocallyOnly() {
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
}

async function bootApp() {
  render();
  await loadAuthConfig();
  await restoreServerSession();
  render();
}

async function loadAuthConfig() {
  try {
    const response = await fetch("/api/auth/config");
    if (!response.ok) {
      throw new Error(`auth-config ${response.status}`);
    }
    const payload = await response.json();
    runtime.auth.clientId = payload.clientId || "";
    runtime.auth.error = payload.clientId ? "" : "GOOGLE_CLIENT_ID가 아직 설정되지 않았습니다.";
  } catch (error) {
    runtime.auth.clientId = "";
    runtime.auth.error = "로그인 설정을 불러오지 못했습니다.";
  }
}

async function restoreServerSession() {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) {
      throw new Error(`session ${response.status}`);
    }

    const payload = await response.json();
    runtime.auth.status = "ready";
    runtime.auth.user = payload.authenticated ? payload.user : null;
    runtime.auth.error = "";
    runtime.auth.syncMessage = payload.authenticated ? "서버 계정 데이터를 불러왔습니다." : "";

    if (!payload.authenticated) {
      return;
    }

    const remoteState = createStateFromSnapshot(payload.state || {});
    const localUpdatedAt = Number(state.meta?.updatedAt) || 0;
    const remoteUpdatedAt = Number(remoteState.meta?.updatedAt) || 0;
    const localHasProgress = hasMeaningfulProgressSnapshot(state);
    const remoteHasProgress = hasMeaningfulProgressSnapshot(remoteState);

    if (localHasProgress && !remoteHasProgress) {
      await pushStateToServer();
      runtime.auth.syncMessage = "현재 기기 학습 기록을 서버에 복구했습니다.";
      return;
    }

    if (remoteUpdatedAt > localUpdatedAt) {
      state = remoteState;
      saveStateLocallyOnly();
      runtime.auth.syncMessage = "서버에 저장된 학습 기록으로 동기화했습니다.";
      return;
    }

    if (localUpdatedAt > remoteUpdatedAt || hasMeaningfulLocalProgress()) {
      await pushStateToServer();
      runtime.auth.syncMessage = "현재 기기 학습 기록을 서버에 동기화했습니다.";
      return;
    }

    state = remoteState;
    saveStateLocallyOnly();
    runtime.auth.syncMessage = "계정 학습 기록이 이미 최신 상태입니다.";
  } catch (error) {
    runtime.auth.status = "ready";
    runtime.auth.user = null;
    runtime.auth.error = "로그인 상태를 확인하지 못했습니다.";
    runtime.auth.syncMessage = "";
  }
}

function hasMeaningfulLocalProgress() {
  return hasMeaningfulProgressSnapshot(state);
}

function hasMeaningfulProgressSnapshot(snapshot) {
  if (!snapshot) {
    return false;
  }
  if (snapshot.archiveRuns?.length) {
    return true;
  }
  if (snapshot.settings?.randomOrder || snapshot.settings?.randomLevel) {
    return true;
  }
  return words.some((word) => {
    const record = snapshot.progress?.[word.uid];
    return (record?.studyCount || 0) > 0;
  });
}

function queueServerSync() {
  if (!runtime.auth.user) {
    return;
  }
  if (runtime.syncTimer) {
    window.clearTimeout(runtime.syncTimer);
  }
  runtime.syncTimer = window.setTimeout(() => {
    pushStateToServer().catch(() => {});
  }, 350);
}

async function pushStateToServer() {
  if (!runtime.auth.user) {
    return;
  }
  if (runtime.syncTimer) {
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = 0;
  }

  const response = await fetch("/api/state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state }),
  });

  if (!response.ok) {
    throw new Error(`state-sync ${response.status}`);
  }

  runtime.auth.syncMessage = "학습 기록을 계정에 저장했습니다.";
}

function initializeRoute() {
  runtime.route = "home";
  if (!window.location.hash) {
    return;
  }
  if (window.history?.replaceState) {
    window.history.replaceState(null, "", `${window.location.pathname || ""}${window.location.search || ""}`);
    return;
  }
  window.location.hash = "";
}

function syncRoute() {
  const hash = window.location.hash.replace("#", "").trim();
  runtime.route = hash || "home";
  if (!["home", "study", "board"].includes(runtime.route)) {
    runtime.route = "home";
  }
  if (runtime.route === "study" && runtime.studyTab === "study") {
    ensureStudySession();
  }
  render();
}

function handleClick(event) {
  const button = event.target.closest("[data-action], [data-route], [data-study-tab], [data-board-tab], [data-board-level], [data-setting]");
  if (!button) {
    return;
  }

  if (button.dataset.route) {
    if (runtime.route === button.dataset.route) {
      if (button.dataset.route === "study") {
        runtime.studyTab = "study";
        runtime.studySession = null;
        ensureStudySession();
      }
      render();
      return;
    }
    window.location.hash = button.dataset.route;
    return;
  }

  if (button.dataset.studyTab) {
    runtime.studyTab = button.dataset.studyTab;
    if (runtime.studyTab === "study") {
      ensureStudySession();
    }
    render();
    return;
  }

  if (button.dataset.boardTab) {
    runtime.boardTab = button.dataset.boardTab;
    render();
    return;
  }

  if (button.dataset.boardLevel) {
    runtime.boardLevel = button.dataset.boardLevel;
    render();
    return;
  }

  if (button.dataset.setting) {
    const key = button.dataset.setting;
    state.settings[key] = !state.settings[key];
    saveState();
    runtime.studySession = null;
    ensureStudySession();
    render();
    return;
  }

  const action = button.dataset.action;
  if (action === "logout") {
    logout().catch(() => {});
    return;
  }

  if (action === "regenerate-study") {
    runtime.studySession = null;
    ensureStudySession();
    render();
    return;
  }

  if (action === "finish-study") {
    runtime.studySession = null;
    runtime.boardTab = "in-progress";
    window.location.hash = "board";
    return;
  }

  if (action === "start-archive") {
    startArchiveSession();
    render();
    return;
  }

  if (action === "pause-archive") {
    pauseArchiveSession();
    return;
  }

  if (action === "resume-archive") {
    resumeArchiveSession();
    return;
  }

  if (action === "restart-archive") {
    startArchiveSession();
    render();
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const answer = new FormData(form).get("answer");
  if (form.dataset.form === "study-answer") {
    await submitStudyAnswer(String(answer || ""));
  }
  if (form.dataset.form === "archive-answer") {
    await submitArchiveAnswer(String(answer || ""));
  }
}

function ensureStudySession() {
  if (runtime.studySession) {
    return;
  }

  const cards = buildStudyQueue();
  runtime.studySession = {
    cards,
    currentIndex: 0,
    answerDraft: "",
    leftPile: [],
    rightPile: [],
    isAnimating: false,
    motion: "",
    message: cards.length ? "" : "오늘 바로 풀 수 있는 카드가 없습니다. 새 묶음을 만들거나 다음 복습 시점을 기다려 주세요.",
  };
}

function buildStudyQueue() {
  const randomOrder = state.settings.randomOrder;
  const randomLevel = state.settings.randomLevel;
  const now = Date.now();
  const selectedLevels = randomLevel ? getAvailableLevels() : [getCurrentLevel()];
  const perLevelFocusDay = Object.fromEntries(selectedLevels.map((level) => [level, getCurrentDay(level)]));

  const pools = {
    fresh: [],
    wrong: [],
    hit1: [],
    hit2: [],
    hit3: [],
    hit4: [],
  };

  for (const level of selectedLevels) {
    const focusDay = perLevelFocusDay[level];
    const levelWords = getWordsByLevel(level);

    for (const word of levelWords) {
      const record = state.progress[word.uid];
      const isFresh = record.studyCount === 0;
      const isDue = record.nextReviewAt <= now;

      if (isFresh) {
        if (randomLevel || word.day === focusDay) {
          pools.fresh.push(word);
        }
        continue;
      }

      if (!isDue) {
        continue;
      }

      const effectiveHits = getEffectiveCorrectCount(record);

      if (record.wrongHits > 0 && effectiveHits === 0) {
        pools.wrong.push(word);
        continue;
      }

      if (effectiveHits === 1) {
        pools.hit1.push(word);
        continue;
      }

      if (effectiveHits === 2) {
        pools.hit2.push(word);
        continue;
      }

      if (effectiveHits === 3) {
        pools.hit3.push(word);
        continue;
      }

      if (effectiveHits >= 4) {
        pools.hit4.push(word);
      }
    }
  }

  const randomize = randomOrder || randomLevel;
  const usedIds = new Set();
  const selected = [
    ...takeStudyBucket(pools.fresh, 10, "fresh", randomize, usedIds),
    ...takeStudyBucket(pools.wrong, 7, "wrong", randomize, usedIds),
    ...takeStudyBucket(pools.hit1, 5, "hit1", randomize, usedIds),
    ...takeStudyBucket(pools.hit2, 3, "hit2", randomize, usedIds),
    ...takeStudyBucket(pools.hit3, 3, "hit3", randomize, usedIds),
    ...takeStudyBucket(pools.hit4, 2, "hit4", true, usedIds),
  ];

  if (selected.length < 30) {
    const fallback = [
      ...listStudyBucketCandidates(pools.fresh, "fresh", randomize, usedIds),
      ...listStudyBucketCandidates(pools.wrong, "wrong", randomize, usedIds),
      ...listStudyBucketCandidates(pools.hit1, "hit1", randomize, usedIds),
      ...listStudyBucketCandidates(pools.hit2, "hit2", randomize, usedIds),
      ...listStudyBucketCandidates(pools.hit3, "hit3", randomize, usedIds),
      ...listStudyBucketCandidates(pools.hit4, "hit4", true, usedIds),
    ].slice(0, 30 - selected.length);

    selected.push(...fallback);
  }

  return selected.map((word) => word.uid);
}

function takeStudyBucket(pool, targetCount, bucketType, randomize, usedIds) {
  const picked = listStudyBucketCandidates(pool, bucketType, randomize, usedIds).slice(0, targetCount);
  for (const word of picked) {
    usedIds.add(word.uid);
  }
  return picked;
}

function listStudyBucketCandidates(pool, bucketType, randomize, usedIds) {
  return pool
    .filter((word) => !usedIds.has(word.uid))
    .map((word) => ({
      word,
      record: state.progress[word.uid],
      randomKey: Math.random(),
    }))
    .sort((left, right) => compareStudyCandidates(left, right, bucketType, randomize))
    .map((entry) => entry.word);
}

function compareStudyCandidates(left, right, bucketType, randomize) {
  const leftRecord = left.record;
  const rightRecord = right.record;

  if (bucketType === "wrong") {
    const wrongDiff = rightRecord.wrongHits - leftRecord.wrongHits;
    if (wrongDiff !== 0) {
      return wrongDiff;
    }

    const effectiveDiff = getEffectiveCorrectCount(leftRecord) - getEffectiveCorrectCount(rightRecord);
    if (effectiveDiff !== 0) {
      return effectiveDiff;
    }
  }

  const studyCountDiff = leftRecord.studyCount - rightRecord.studyCount;
  if (studyCountDiff !== 0) {
    return studyCountDiff;
  }

  const lastStudiedDiff = leftRecord.lastStudiedAt - rightRecord.lastStudiedAt;
  if (lastStudiedDiff !== 0) {
    return lastStudiedDiff;
  }

  if (randomize) {
    const randomDiff = left.randomKey - right.randomKey;
    if (randomDiff !== 0) {
      return randomDiff;
    }
  }

  return compareWordSequence(left.word, right.word);
}

function getEffectiveCorrectCount(record) {
  return Math.max(0, (Number(record.correctHits) || 0) - (Number(record.wrongHits) || 0));
}

function compareWordSequence(leftWord, rightWord) {
  const levelDiff = LEVELS.indexOf(leftWord.level) - LEVELS.indexOf(rightWord.level);
  if (levelDiff !== 0) {
    return levelDiff;
  }
  if (leftWord.day !== rightWord.day) {
    return leftWord.day - rightWord.day;
  }
  return leftWord.order - rightWord.order;
}

async function submitStudyAnswer(rawAnswer) {
  ensureStudySession();
  const session = runtime.studySession;
  if (!session || session.isAnimating) {
    return;
  }

  const word = getCurrentStudyWord();
  if (!word) {
    return;
  }

  const answer = rawAnswer.trim();
  if (!answer) {
    session.message = "뜻을 입력하면 카드가 넘어갑니다.";
    render();
    return;
  }

  session.isAnimating = true;
  session.message = "정답 판정 중입니다.";
  render();

  const match = await determineMeaningMatch(answer, word.meaning);
  if (runtime.studySession !== session || getCurrentStudyWord()?.uid !== word.uid) {
    return;
  }

  const isCorrect = match.isCorrect;
  session.isAnimating = true;
  session.motion = isCorrect ? "is-right" : "is-left";
  session.message = getStudyResultMessage(isCorrect, match.mode);
  render();

  window.setTimeout(() => {
    registerStudyResult(word.uid, isCorrect);
    if (isCorrect) {
      session.rightPile.push(word.uid);
    } else {
      session.leftPile.push(word.uid);
    }
    session.currentIndex += 1;
    session.answerDraft = "";
    session.isAnimating = false;
    session.motion = "";
    if (session.currentIndex >= session.cards.length) {
      session.message = "오늘 카드가 모두 넘어갔습니다. 공부 종료를 누르면 전체 단어 확인하기로 이동합니다.";
    }
    render();
  }, 980);
}

function registerStudyResult(wordId, isCorrect) {
  const record = state.progress[wordId];
  record.studyCount += 1;
  record.lastStudiedAt = Date.now();
  record.lastStudiedDay = getTodayKey();

  if (isCorrect) {
    record.correctHits += 1;
    record.stage = Math.min(record.stage + 1, 4);
    record.nextReviewAt = Date.now() + REVIEW_INTERVALS[record.stage];
  } else {
    record.wrongHits += 1;
    record.stage = Math.max(record.stage - 1, 0);
    record.nextReviewAt = Date.now();
  }

  saveState();
}

function startArchiveSession() {
  const archivedWords = shuffled(words.filter((word) => state.progress[word.uid].stage >= 4)).slice(0, 30);
  runtime.archiveSession = {
    cards: archivedWords,
    currentIndex: 0,
    wrongByWord: {},
    startedAt: archivedWords.length ? Date.now() : 0,
    elapsedMs: 0,
    isPaused: !archivedWords.length,
    feedback: archivedWords.length ? "아카이브 단어 30개를 시작합니다." : "아직 아카이브에 들어간 단어가 없습니다.",
    motion: "",
    messageTone: "",
    completedAt: 0,
    isAnimating: false,
  };
}

async function submitArchiveAnswer(rawAnswer) {
  const session = runtime.archiveSession;
  if (!session || session.isAnimating || session.isPaused) {
    return;
  }

  const word = session.cards[session.currentIndex];
  if (!word) {
    return;
  }

  const answer = rawAnswer.trim();
  if (!answer) {
    session.feedback = "뜻을 입력해야 판정할 수 있습니다.";
    session.messageTone = "danger";
    render();
    return;
  }

  session.isAnimating = true;
  session.feedback = "정답 판정 중입니다.";
  session.messageTone = "";
  render();

  const match = await determineMeaningMatch(answer, word.meaning);
  if (runtime.archiveSession !== session || session.cards[session.currentIndex]?.uid !== word.uid) {
    return;
  }

  const isCorrect = match.isCorrect;
  session.motion = isCorrect ? "correct" : "wrong";
  render();

  window.setTimeout(() => {
    registerArchiveAttempt(word.uid, isCorrect);

    if (isCorrect) {
      session.feedback = getArchiveResultMessage(word.kanji, match.mode);
      session.messageTone = "success";
      session.currentIndex += 1;
    } else {
      const wrongCount = (session.wrongByWord[word.uid] || 0) + 1;
      session.wrongByWord[word.uid] = wrongCount;
      if (wrongCount >= 3) {
        demoteArchivedWord(word.uid);
        session.feedback = `${word.kanji}는 3번 틀려서 다시 일반 공부 목록으로 되돌렸습니다.`;
        session.messageTone = "danger";
        session.currentIndex += 1;
      } else {
        session.feedback = `틀렸습니다. 뒷면 뜻은 "${word.meaning}" 입니다. 다시 맞춰 보세요. (${wrongCount}/3)`;
        session.messageTone = "danger";
      }
    }

    session.motion = "";
    session.isAnimating = false;

    if (session.currentIndex >= session.cards.length && !session.completedAt) {
      const elapsedMs = getArchiveElapsedMs(session);
      session.elapsedMs = elapsedMs;
      session.completedAt = Date.now();
      session.isPaused = true;
      session.startedAt = 0;
      state.archiveRuns.push({
        date: new Date().toISOString(),
        elapsedMs,
      });
      state.archiveRuns = state.archiveRuns
        .slice()
        .sort((a, b) => a.elapsedMs - b.elapsedMs)
        .slice(0, 25);
      saveState();
      session.feedback = `아카이브 30문제가 끝났습니다. 총 ${formatDuration(elapsedMs)}가 걸렸습니다.`;
      session.messageTone = "success";
    }

    render();
  }, 520);
}

function pauseArchiveSession() {
  const session = runtime.archiveSession;
  if (!session || session.completedAt || session.isPaused || !session.cards.length) {
    return;
  }

  session.elapsedMs = getArchiveElapsedMs(session);
  session.startedAt = 0;
  session.isPaused = true;
  session.feedback = "아카이브 시간을 잠시 멈췄습니다.";
  session.messageTone = "";
  render();
}

function resumeArchiveSession() {
  const session = runtime.archiveSession;
  if (!session || session.completedAt || !session.isPaused || !session.cards.length) {
    return;
  }

  session.startedAt = Date.now();
  session.isPaused = false;
  session.feedback = "아카이브 시간을 다시 시작합니다.";
  session.messageTone = "";
  render();
}

function getArchiveElapsedMs(session) {
  if (!session || !session.cards.length) {
    return 0;
  }
  if (session.completedAt) {
    return Number(session.elapsedMs) || 0;
  }
  if (session.isPaused || !session.startedAt) {
    return Number(session.elapsedMs) || 0;
  }
  return (Number(session.elapsedMs) || 0) + Math.max(0, Date.now() - session.startedAt);
}

async function determineMeaningMatch(answer, meaning) {
  if (isMeaningMatch(answer, meaning)) {
    return { isCorrect: true, mode: "heuristic" };
  }

  const cacheKey = `${compactString(answer)}::${compactString(meaning)}`;
  if (semanticDecisionCache.has(cacheKey)) {
    return semanticDecisionCache.get(cacheKey);
  }

  try {
    const response = await fetch("/api/meaning-match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answer, meaning }),
    });

    if (!response.ok) {
      throw new Error(`meaning-match ${response.status}`);
    }

    const payload = await response.json();
    const result = {
      isCorrect: Boolean(payload.isCorrect),
      mode: payload.mode || "semantic",
      score: Number(payload.score) || 0,
    };
    semanticDecisionCache.set(cacheKey, result);
    return result;
  } catch (error) {
    return { isCorrect: false, mode: "fallback" };
  }
}

function getStudyResultMessage(isCorrect, mode) {
  if (!isCorrect) {
    return "틀렸습니다. 왼쪽 더미로 보냅니다.";
  }
  if (mode === "semantic") {
    return "의미가 비슷해서 정답 처리했습니다. 오른쪽 더미로 보냅니다.";
  }
  return "정답입니다. 오른쪽 더미로 보냅니다.";
}

function getArchiveResultMessage(kanji, mode) {
  if (mode === "semantic") {
    return `${kanji}를 의미 유사도로 정답 처리했습니다. 다음 카드로 넘어갑니다.`;
  }
  return `${kanji}를 맞혔습니다. 다음 카드로 넘어갑니다.`;
}

function registerArchiveAttempt(wordId, isCorrect) {
  const record = state.progress[wordId];
  record.studyCount += 1;
  record.lastStudiedAt = Date.now();
  record.lastStudiedDay = getTodayKey();
  if (isCorrect) {
    record.correctHits += 1;
    record.stage = 4;
    record.nextReviewAt = Date.now() + REVIEW_INTERVALS[4];
  } else {
    record.wrongHits += 1;
  }
  saveState();
}

function demoteArchivedWord(wordId) {
  const record = state.progress[wordId];
  record.stage = 3;
  record.nextReviewAt = Date.now();
  saveState();
}

function getCurrentStudyWord() {
  const session = runtime.studySession;
  if (!session) {
    return null;
  }
  const wordId = session.cards[session.currentIndex];
  return wordId ? wordMap.get(wordId) : null;
}

function getCurrentLevel() {
  const available = getAvailableLevels();
  for (const level of available) {
    if (getLevelCompletion(level) < 0.95) {
      return level;
    }
  }
  return available[available.length - 1] || "N5";
}

function getCurrentDay(level) {
  const daySet = [...new Set(getWordsByLevel(level).map((word) => word.day))].sort((a, b) => a - b);
  for (const day of daySet) {
    const hasFreshWord = getWordsByLevel(level).some((word) => word.day === day && state.progress[word.uid].studyCount === 0);
    if (hasFreshWord) {
      return day;
    }
  }
  return daySet[daySet.length - 1] || 1;
}

function getLevelCompletion(level) {
  const levelWords = getWordsByLevel(level);
  if (!levelWords.length) {
    return 0;
  }
  const archived = levelWords.filter((word) => state.progress[word.uid].stage >= 4).length;
  return archived / levelWords.length;
}

function getWordsByLevel(level) {
  return levelCatalog[level] || [];
}

function getAvailableLevels() {
  return LEVELS.filter((level) => getWordsByLevel(level).length);
}

function render() {
  root.innerHTML = `
    <div class="shell">
      ${renderNav()}
      <main class="page">
        ${renderRoute()}
      </main>
    </div>
  `;

  const activeInput = root.querySelector(".study-input");
  if (activeInput && !runtime.studySession?.isAnimating && !runtime.archiveSession?.isAnimating) {
    window.requestAnimationFrame(() => activeInput.focus());
  }

  window.requestAnimationFrame(() => {
    renderGoogleLoginButton();
  });
}

function renderNav() {
  return `
    <nav class="nav">
      <div class="nav-brand">
        <div class="nav-kana">単</div>
        <div class="nav-copy">
          <strong>JLPT 단어 공부장</strong>
          <span>순서대로 쌓고, 틀린 카드까지 다시 잡는 학습 흐름</span>
        </div>
      </div>
      <div class="nav-actions">
        <button class="nav-link ${runtime.route === "home" ? "is-active" : ""}" data-route="home">홈</button>
        <button class="nav-link ${runtime.route === "study" ? "is-active" : ""}" data-route="study">단어 공부하기</button>
        <button class="nav-link ${runtime.route === "board" ? "is-active" : ""}" data-route="board">전체 오답 확인하기</button>
      </div>
      ${renderAuthPanel()}
    </nav>
  `;
}

function renderAuthPanel() {
  if (runtime.auth.user) {
    const syncDot = runtime.auth.syncMessage ? "🟢" : "🟠";
    return `
      <div class="auth-panel is-signed-in">
        <div class="auth-user">
          ${
            runtime.auth.user.picture
              ? `<img class="auth-avatar" src="${escapeAttribute(runtime.auth.user.picture)}" alt="${escapeAttribute(runtime.auth.user.name || runtime.auth.user.email || "사용자")}" />`
              : `<div class="auth-avatar auth-avatar-fallback">${escapeHtml((runtime.auth.user.name || runtime.auth.user.email || "U").slice(0, 1))}</div>`
          }
          <div class="auth-copy">
            <strong>${escapeHtml(runtime.auth.user.name || "Google 사용자")}</strong>
            <span>${syncDot} ${escapeHtml(runtime.auth.user.email || "동기화 저장 사용 중")}</span>
          </div>
        </div>
        <button class="ghost-button auth-logout-button" data-action="logout">로그아웃</button>
      </div>
    `;
  }

  if (runtime.auth.status === "loading") {
    return `
      <div class="auth-panel">
        <div class="auth-note">로그인 상태를 확인 중입니다.</div>
      </div>
    `;
  }

  if (!runtime.auth.clientId) {
    return `
      <div class="auth-panel">
        <div class="auth-note">${escapeHtml(runtime.auth.error || "Google 로그인 설정이 필요합니다.")}</div>
      </div>
    `;
  }

  return `
    <div class="auth-panel">
      <div class="google-signin-slot" id="google-signin-slot"></div>
      <div class="auth-note">${escapeHtml(runtime.auth.error || "로그인하면 모바일과 웹 진행도가 같은 계정으로 동기화됩니다.")}</div>
    </div>
  `;
}

function renderGoogleLoginButton() {
  if (runtime.auth.user || !runtime.auth.clientId) {
    return;
  }
  if (!window.google?.accounts?.id) {
    return;
  }

  const slot = document.getElementById("google-signin-slot");
  if (!slot) {
    return;
  }

  if (!runtime.auth.googleReady) {
    window.google.accounts.id.initialize({
      client_id: runtime.auth.clientId,
      callback: handleGoogleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    runtime.auth.googleReady = true;
  }

  slot.innerHTML = "";
  window.google.accounts.id.renderButton(slot, {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "signin_with",
    width: Math.min(slot.clientWidth || 320, 320),
  });
}

async function handleGoogleCredentialResponse(response) {
  if (!response?.credential) {
    runtime.auth.error = "Google 로그인 응답을 받지 못했습니다.";
    render();
    return;
  }

  runtime.auth.status = "loading";
  runtime.auth.error = "";
  render();

  try {
    const loginResponse = await fetch("/api/auth/google", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ credential: response.credential }),
    });

    if (!loginResponse.ok) {
      throw new Error(`google-login ${loginResponse.status}`);
    }

    runtime.auth.syncMessage = "Google 계정으로 로그인했습니다.";
    await restoreServerSession();
  } catch (error) {
    runtime.auth.status = "ready";
    runtime.auth.user = null;
    runtime.auth.error = "Google 로그인에 실패했습니다.";
    runtime.auth.syncMessage = "";
  }

  render();
}

async function logout() {
  runtime.auth.status = "loading";
  render();

  try {
    await fetch("/api/logout", {
      method: "POST",
    });
  } catch (error) {
    // Ignore logout transport errors and clear the local auth view anyway.
  }

  runtime.auth.status = "ready";
  runtime.auth.user = null;
  runtime.auth.error = "";
  runtime.auth.googleReady = false;
  runtime.auth.syncMessage = "";
  render();
}

function renderRoute() {
  if (runtime.route === "study") {
    return renderStudyPage();
  }
  if (runtime.route === "board") {
    return renderBoardPage();
  }
  return renderHomePage();
}

function renderHomePage() {
  const learnedCount = words.filter((word) => state.progress[word.uid].studyCount > 0).length;
  const totalCount = words.length;
  const todayCount = words.filter((word) => state.progress[word.uid].lastStudiedDay === getTodayKey()).length;
  const currentLevel = getCurrentLevel();
  const currentDay = getCurrentDay(currentLevel);
  const progressPercent = totalCount ? Math.round((learnedCount / totalCount) * 100) : 0;

  return `
    <section class="hero hero-compact">
      <div class="hero-copy">
        <div class="eyebrow">JLPT 5급부터 차례대로</div>
        <h1 class="hero-title">한 장씩 넘기면서 <span class="jp">ことば</span>를 쌓는 단어장</h1>
        <div class="hero-actions">
          <button class="hero-cta" data-route="study">단어 공부 시작하기</button>
          <button class="hero-secondary" data-route="board">오답 목록 보기</button>
        </div>
      </div>
    </section>

    <section class="stats-grid">
      <article class="stat-card">
        <div class="stat-copy">
          <span>전체 학습 비율</span>
          <strong class="stat-num">${progressPercent}%</strong>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progressPercent}%"></div>
        </div>
        <span class="footer-note">${learnedCount} / ${totalCount} 단어</span>
      </article>
      <article class="stat-card">
        <div class="stat-copy">
          <span>오늘 학습한 단어</span>
          <strong class="stat-num">${todayCount}</strong>
        </div>
        <span class="footer-note">오늘 한 번 이상 본 단어</span>
      </article>
      <article class="stat-card">
        <div class="stat-copy">
          <span>현재 급수 / 챕터</span>
          <strong class="stat-num stat-num-sm">${currentLevel} · ${currentDay}일차</strong>
        </div>
        <span class="footer-note">완료율 95% 초과 시 다음 급수로 이동</span>
      </article>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div class="section-heading">
          <strong>급수 진행 상태</strong>
        </div>
      </div>
      <div class="level-grid">
        ${LEVELS.map((level) => renderLevelChip(level, level === currentLevel)).join("")}
      </div>
    </section>
  `;
}

function renderLevelChip(level, isCurrent) {
  const levelWords = getWordsByLevel(level);
  const completion = levelWords.length ? Math.round(getLevelCompletion(level) * 100) : 0;
  const isDim = !isCurrent && levelWords.length === 0;
  return `
    <div class="level-chip ${isCurrent ? "is-current" : ""} ${isDim ? "is-dim" : ""}">
      <strong>${level}</strong>
      <small>${levelWords.length ? `${levelWords.length}단어 · ${completion}%` : "준비 중"}</small>
    </div>
  `;
}

function renderStudyPage() {
  ensureStudySession();
  const currentLevel = getCurrentLevel();
  const session = runtime.studySession;
  const focusDay = getCurrentDay(currentLevel);
  const total = session?.cards?.length || 0;
  const current = Math.min((session?.currentIndex || 0) + 1, total || 1);
  const archiveCount = words.filter((word) => state.progress[word.uid].stage >= 4).length;

  return `
    <section class="study-board">
      <div class="study-header">
        <div class="section-heading">
          <strong>단어 공부하기</strong>
        </div>
        <div class="tabs">
          <button class="tab-button ${runtime.studyTab === "study" ? "is-active" : ""}" data-study-tab="study">공부하기</button>
          <button class="tab-button ${runtime.studyTab === "archive" ? "is-active" : ""}" data-study-tab="archive">아카이브</button>
        </div>
      </div>
      ${
        runtime.studyTab === "study"
          ? `
            <div class="study-meta">
              <div class="meta-pill">
                <span>기본 진행 급수</span>
                <strong>${currentLevel}</strong>
              </div>
              <div class="meta-pill">
                <span>현재 챕터</span>
                <strong>${focusDay}일차</strong>
              </div>
              <div class="meta-pill">
                <span>이번 묶음</span>
                <strong>${total}장</strong>
              </div>
              <div class="meta-pill">
                <span>아카이브 보관</span>
                <strong>${archiveCount}장</strong>
              </div>
            </div>
            <div class="mode-controls">
              <div class="mode-buttons">
                <button class="mode-button ${state.settings.randomOrder ? "is-active" : ""}" data-setting="randomOrder">랜덤 순서</button>
                <button class="mode-button ${state.settings.randomLevel ? "is-active" : ""}" data-setting="randomLevel">랜덤 급수</button>
                <button class="ghost-button" data-action="regenerate-study">새 카드 묶기</button>
              </div>
              <span class="bundle-rule-note">묶음 규칙: 모르는 카드 10, 1회 맞춘 10, 2회 5, 3회 5, 4회 이상 5장</span>
            </div>
            ${renderStudyDeck(current, total)}
          `
          : renderArchivePanel()
      }
    </section>
  `;
}

function renderStudyDeck(current, total) {
  const session = runtime.studySession;
  const word = getCurrentStudyWord();
  const isDone = !word && total > 0;
  const completionLabel = total ? `${Math.min(current, total)} / ${total}` : "0 / 0";

  if (!total) {
    return `
      <div class="empty-card">
        <p>${session?.message || "현재 풀 수 있는 카드가 없습니다."}</p>
      </div>
    `;
  }

  if (isDone) {
    return `
      <div class="empty-card">
        <p>${session.message}</p>
        <button class="ghost-button finish-study-button" data-action="finish-study">공부 종료</button>
      </div>
    `;
  }

  const record = state.progress[word.uid];
  const displayLevel = state.settings.randomLevel ? `${word.level} · ${word.day}일차` : `${word.level} · ${word.day}일차`;

  const cardClasses = ["study-card"];
  if (session.motion) {
    cardClasses.push("is-revealed", session.motion);
  }

  return `
    <div class="deck-shell">
      <aside class="pile is-left">
        <div class="pile-label">오답 더미</div>
        <div class="pile-stack">
          ${renderPileStack(session.leftPile, "left")}
        </div>
        <div class="pile-count">${session.leftPile.length}장</div>
      </aside>
      <section class="card-stage">
        <div class="ghost-stack">
          <div class="ghost-card"></div>
          <div class="ghost-card"></div>
        </div>
        <article class="${cardClasses.join(" ")}">
          <div class="study-card-inner">
            <div class="study-face front">
              <div class="study-face-content">
                <div class="card-topline">
                  <span class="card-index">${completionLabel}</span>
                  <span class="card-badge">${displayLevel}</span>
                </div>
                <div class="card-word">
                  <div class="kanji">${escapeHtml(word.kanji)}</div>
                  <div class="hiragana">뜻을 적어 주세요</div>
                </div>
                <div class="card-prompt">한글 의미를 입력하면 카드가 뒤집히면서 히라가나와 뜻이 함께 보입니다.</div>
              </div>
            </div>
            <div class="study-face back">
              <div class="study-face-content">
                <div class="card-backline">
                  <span class="card-badge">${record.stage >= 4 ? "아카이브 후보" : `현재 누적 ${record.stage}회`}</span>
                  <span class="card-badge">${session.motion === "is-right" ? "정답" : "오답"}</span>
                </div>
                <div class="card-word">
                  <div class="kanji">${escapeHtml(word.kanji)}</div>
                  <div class="hiragana">${escapeHtml(word.hiragana)}</div>
                </div>
                <div class="card-meaning">${escapeHtml(word.meaning)}</div>
                <div class="card-hint">광의의 의미와 동의어도 최대한 넓게 판정합니다.</div>
              </div>
            </div>
          </div>
        </article>
        <form class="study-form" data-form="study-answer">
          <input class="study-input" type="text" name="answer" placeholder="예: 지갑, 바깥, 식사" autocomplete="off" />
          <div class="study-form-row">
            <span class="helper-text">${session.message || "히라가나는 입력하지 않아도 됩니다."}</span>
            <button class="study-submit" type="submit" ${session.isAnimating ? "disabled" : ""}>뜻 맞추기</button>
          </div>
        </form>
      </section>
      <aside class="pile is-right">
        <div class="pile-label">정답 더미</div>
        <div class="pile-stack">
          ${renderPileStack(session.rightPile, "right")}
        </div>
        <div class="pile-count">${session.rightPile.length}장</div>
      </aside>
    </div>
  `;
}

function renderPileStack(pileIds, side) {
  const previewIds = pileIds.slice(-3);
  const emptyCount = Math.max(0, 3 - previewIds.length);
  const cards = [];

  for (let index = 0; index < emptyCount; index += 1) {
    cards.push(`<div class="pile-card is-empty depth-${index + 1}"></div>`);
  }

  previewIds.forEach((wordId, index) => {
    const depth = emptyCount + index + 1;
    const word = wordMap.get(wordId);
    cards.push(renderPileCard(word, side, depth));
  });

  return cards.join("");
}

function renderPileCard(word, side, depth) {
  if (!word) {
    return `<div class="pile-card is-empty depth-${depth}"></div>`;
  }

  const toneClass = side === "left" ? "is-wrong" : "is-correct";
  return `
    <div class="pile-card is-filled ${toneClass} depth-${depth}">
      <div class="pile-card-face">
        <div class="pile-mini-kanji">${escapeHtml(word.kanji)}</div>
        <div class="pile-mini-hiragana">${escapeHtml(word.hiragana)}</div>
        <div class="pile-mini-meaning">${escapeHtml(word.meaning)}</div>
      </div>
    </div>
  `;
}

function renderArchivePanel() {
  const session = runtime.archiveSession;
  const records = state.archiveRuns.slice().sort((a, b) => a.elapsedMs - b.elapsedMs).slice(0, 25);

  if (!session) {
    return `
      <div class="archive-layout">
        <div class="panel archive-card-stage">
          <div class="section-heading">
            <strong>아카이브 단어 공부하기</strong>
            <span>4번 이상 맞힌 단어 중 30개를 무작위로 뽑아 시간 기록을 남깁니다.</span>
          </div>
          <div class="empty-card">
            <p>시작 버튼을 누르면 아카이브 테스트가 열립니다. 틀리면 빨갛게 표시되고, 같은 카드를 다시 맞춰야 합니다.</p>
            <button class="primary-button" data-action="start-archive">아카이브 30문제 시작</button>
          </div>
        </div>
        ${renderArchiveRecords(records)}
      </div>
    `;
  }

  const word = session.cards[session.currentIndex];
  const elapsedLabel = formatDuration(getArchiveElapsedMs(session));
  return `
    <div class="archive-layout">
      <div class="panel archive-card-stage">
        <div class="archive-header">
          <div class="section-heading">
            <strong>아카이브 단어 공부하기</strong>
            <span>틀린 횟수가 3번이 되면 일반 공부 목록으로 내려갑니다.</span>
          </div>
          <div class="utility-row">
            <span class="table-badge">${session.cards.length ? `${Math.min(session.currentIndex + 1, session.cards.length)} / ${session.cards.length}` : "0 / 0"}</span>
            <span class="table-badge">${session.cards.length ? `경과 ${elapsedLabel}` : "기록 대기 중"}</span>
            ${
              word && !session.completedAt
                ? `
                  <button class="ghost-button" data-action="${session.isPaused ? "resume-archive" : "pause-archive"}">
                    ${session.isPaused ? "아카이브 재개" : "아카이브 일시정지"}
                  </button>
                `
                : ""
            }
          </div>
        </div>
        ${
          word
            ? `
              <div class="archive-card-shell ${session.motion ? `is-${session.motion}` : ""}">
                <div class="study-face">
                  <div class="study-face-content">
                    <div class="card-topline">
                      <span class="card-index">${word.level} · ${word.day}일차</span>
                      <span class="card-badge">오답 ${session.wrongByWord[word.uid] || 0}/3</span>
                    </div>
                    <div class="card-word">
                      <div class="kanji">${escapeHtml(word.kanji)}</div>
                      <div class="hiragana">${escapeHtml(word.hiragana)}</div>
                    </div>
                    <div class="card-prompt">뜻을 맞히면 카드가 날아가고, 틀리면 빨갛게 표시된 뒤 다시 풀게 됩니다.</div>
                    <div class="card-meaning">정답 기준: ${escapeHtml(word.meaning)}</div>
                  </div>
                </div>
              </div>
              <form class="study-form" data-form="archive-answer">
                <input class="study-input" type="text" name="answer" placeholder="뜻을 적고 Enter" autocomplete="off" />
                <div class="study-form-row">
                  <span class="helper-text">${session.isPaused ? "일시정지 중에는 시간이 오르지 않고 답안도 잠깁니다." : "아카이브는 시간 기록이 남습니다."}</span>
                  <button class="study-submit" type="submit" ${session.isAnimating || session.isPaused ? "disabled" : ""}>아카이브 답안 제출</button>
                </div>
              </form>
            `
            : `
              <div class="empty-card">
                <p>${session.feedback}</p>
                <button class="primary-button" data-action="restart-archive">새 아카이브 세션 만들기</button>
              </div>
            `
        }
        <div class="archive-feedback ${session.messageTone ? `is-${session.messageTone}` : ""}">
          ${escapeHtml(session.feedback)}
        </div>
      </div>
      ${renderArchiveRecords(records)}
    </div>
  `;
}

function renderArchiveRecords(records) {
  return `
    <aside class="record-panel">
      <div class="record-head">
        <h2>시간초 기록</h2>
        <span class="table-caption">가장 빠른 기록이 위로 올라옵니다. 최대 25개까지 보관합니다.</span>
      </div>
      <div class="record-table-wrap">
        <table>
          <thead>
            <tr>
              <th>날짜</th>
              <th>맞추는데 걸린 시간</th>
            </tr>
          </thead>
          <tbody>
            ${
              records.length
                ? records
                    .map(
                      (record) => `
                        <tr>
                          <td>${formatDate(record.date)}</td>
                          <td>${formatDuration(record.elapsedMs)}</td>
                        </tr>
                      `,
                    )
                    .join("")
                : `
                  <tr>
                    <td colspan="2">아직 기록이 없습니다.</td>
                  </tr>
                `
            }
          </tbody>
        </table>
      </div>
    </aside>
  `;
}

function renderBoardPage() {
  const availableLevels = getAvailableLevels();
  const levelFilter = (word) => runtime.boardLevel === "all" || word.level === runtime.boardLevel;

  const inProgress = words.filter((word) => state.progress[word.uid].stage < 4 && levelFilter(word));
  const archived = words.filter((word) => state.progress[word.uid].stage >= 4 && levelFilter(word));

  return `
    <section class="table-panel">
      <div class="table-header">
        <div class="section-heading">
          <strong>전체 단어 확인하기</strong>
        </div>
        <div class="board-filter-row">
          <div class="table-tabs">
            <button class="tab-button ${runtime.boardTab === "in-progress" ? "is-active" : ""}" data-board-tab="in-progress">진행중</button>
            <button class="tab-button ${runtime.boardTab === "completed" ? "is-active" : ""}" data-board-tab="completed">완료</button>
          </div>
          <div class="table-tabs">
            <button class="tab-button ${runtime.boardLevel === "all" ? "is-active" : ""}" data-board-level="all">전체</button>
            ${availableLevels.map((lv) => `<button class="tab-button ${runtime.boardLevel === lv ? "is-active" : ""}" data-board-level="${lv}">${lv}</button>`).join("")}
          </div>
        </div>
      </div>
      ${
        runtime.boardTab === "in-progress"
          ? renderProgressTable(inProgress)
          : renderCompletedTable(archived)
      }
    </section>
  `;
}

function renderProgressTable(items) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>한자</th>
            <th>히라가나</th>
            <th>뜻</th>
            <th>급수</th>
            <th>틀린 횟수</th>
            <th>맞은 횟수</th>
          </tr>
        </thead>
        <tbody>
          ${
            items.length
                ? items
                    .map((word) => {
                      const record = state.progress[word.uid];
                      const rowClass = getWrongHighlightClass(record.wrongHits);
                      return `
                      <tr class="${rowClass}">
                        <td class="jp-inline">${escapeHtml(word.kanji)}</td>
                        <td class="jp-inline">${escapeHtml(word.hiragana)}</td>
                        <td>${escapeHtml(word.meaning)}</td>
                        <td>${word.level}</td>
                        <td>${record.wrongHits}</td>
                        <td>${record.correctHits}</td>
                      </tr>
                    `;
                  })
                  .join("")
              : `
                <tr>
                  <td colspan="6">진행 중인 단어가 없습니다.</td>
                </tr>
              `
          }
        </tbody>
      </table>
    </div>
  `;
}

function getWrongHighlightClass(wrongHits) {
  if (wrongHits >= 5) {
    return "is-wrong-5";
  }
  if (wrongHits === 4) {
    return "is-wrong-4";
  }
  if (wrongHits === 3) {
    return "is-wrong-3";
  }
  if (wrongHits === 2) {
    return "is-wrong-2";
  }
  return "";
}

function renderCompletedTable(items) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>한자</th>
            <th>히라가나</th>
            <th>뜻</th>
            <th>급수</th>
            <th>공부한 횟수</th>
          </tr>
        </thead>
        <tbody>
          ${
            items.length
              ? items
                  .map((word) => {
                    const record = state.progress[word.uid];
                    return `
                      <tr>
                        <td class="jp-inline">${escapeHtml(word.kanji)}</td>
                        <td class="jp-inline">${escapeHtml(word.hiragana)}</td>
                        <td>${escapeHtml(word.meaning)}</td>
                        <td>${word.level}</td>
                        <td>${record.studyCount}</td>
                      </tr>
                    `;
                  })
                  .join("")
              : `
                <tr>
                  <td colspan="5">완료된 단어가 없습니다.</td>
                </tr>
              `
          }
        </tbody>
      </table>
    </div>
  `;
}

function isMeaningMatch(answer, meaning) {
  const answerTokens = buildMeaningTokens(answer);
  const meaningTokens = buildMeaningTokens(meaning);
  const answerCompact = compactString(answer);
  const meaningCompact = compactString(meaning);

  if (!answerTokens.length) {
    return false;
  }

  const fullMatch =
    answerCompact === meaningCompact ||
    (Math.min(answerCompact.length, meaningCompact.length) >= 2 &&
      (meaningCompact.includes(answerCompact) || answerCompact.includes(meaningCompact)));

  if (fullMatch) {
    return true;
  }

  return answerTokens.every((token) =>
    meaningTokens.some((candidate) => {
      if (token === candidate) {
        return true;
      }
      if (Math.min(token.length, candidate.length) >= 2) {
        return candidate.includes(token) || token.includes(candidate);
      }
      return false;
    }),
  );
}

function buildMeaningTokens(value) {
  const normalized = canonicalizeMeaningText(
    normalizeText(value)
    .replace(/[()]/g, " ")
    .replace(/[\u00b7/|]/g, " ")
    .replace(/,/g, " "),
  );

  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(stripParticle)
    .map(canonicalizeMeaningToken)
    .filter((token) => !MEANING_IGNORABLE_TOKENS.has(token))
    .filter(Boolean);
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .replace(/[~!@#$%^&*_+=?:;"'`[\]{}<>\\.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripParticle(token) {
  return token.replace(/(을|를|이|가|은|는|의|에|에서|으로|로|과|와|도|만|이나|나)$/g, "");
}

function compactString(value) {
  return canonicalizeMeaningText(normalizeText(value)).replace(/\s+/g, "");
}

function buildMeaningSynonymMap() {
  const map = new Map();
  for (const group of MEANING_SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const token of group) {
      map.set(token, canonical);
    }
  }
  return map;
}

function canonicalizeMeaningText(value) {
  let normalized = value;
  const entries = [...MEANING_SYNONYM_MAP.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [alias, canonical] of entries) {
    normalized = normalized.replaceAll(alias, canonical);
  }
  return normalized;
}

function canonicalizeMeaningToken(token) {
  return MEANING_SYNONYM_MAP.get(token) || token;
}

function dedupeByUid(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.uid)) {
      return false;
    }
    seen.add(item.uid);
    return true;
  });
}

function ordered(items) {
  return items.slice().sort((left, right) => {
    const levelDiff = LEVELS.indexOf(left.level) - LEVELS.indexOf(right.level);
    if (levelDiff !== 0) {
      return levelDiff;
    }
    if (left.day !== right.day) {
      return left.day - right.day;
    }
    return left.order - right.order;
  });
}

function shuffled(items) {
  const clone = items.slice();
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }
  return clone;
}

function safeParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function startClock() {
  if (runtime.timerId) {
    window.clearInterval(runtime.timerId);
  }
  runtime.timerId = window.setInterval(() => {
    if (
      runtime.route === "study" &&
      runtime.studyTab === "archive" &&
      runtime.archiveSession &&
      !runtime.archiveSession.completedAt &&
      !runtime.archiveSession.isPaused
    ) {
      render();
    }
  }, 1000);
}
