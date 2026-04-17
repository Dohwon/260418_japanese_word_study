const APP_STORAGE_KEY = "jlpt-study-state-v1";
const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
const REVIEW_INTERVALS = {
  1: 2 * 24 * 60 * 60 * 1000,
  2: 3 * 24 * 60 * 60 * 1000,
  3: 7 * 24 * 60 * 60 * 1000,
  4: 14 * 24 * 60 * 60 * 1000,
};

const root = document.getElementById("app");

const runtime = {
  route: "home",
  studyTab: "study",
  boardTab: "in-progress",
  studySession: null,
  archiveSession: null,
  timerId: null,
};

const levelCatalog = buildLevelCatalog();
const words = LEVELS.flatMap((level) => levelCatalog[level] || []);
const wordMap = new Map(words.map((word) => [word.uid, word]));
let state = hydrateState();

syncRoute();
window.addEventListener("hashchange", syncRoute);
root.addEventListener("click", handleClick);
root.addEventListener("submit", handleSubmit);
startClock();
render();

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
  const progress = {};

  for (const word of words) {
    const record = stored.progress?.[word.uid] || {};
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
    settings: {
      randomOrder: Boolean(stored.settings?.randomOrder),
      randomLevel: Boolean(stored.settings?.randomLevel),
    },
    archiveRuns: Array.isArray(stored.archiveRuns) ? stored.archiveRuns : [],
    progress,
  };
}

function saveState() {
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
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
  const button = event.target.closest("[data-action], [data-route], [data-study-tab], [data-board-tab], [data-setting]");
  if (!button) {
    return;
  }

  if (button.dataset.route) {
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

  if (action === "restart-archive") {
    startArchiveSession();
    render();
  }
}

function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const answer = new FormData(form).get("answer");
  if (form.dataset.form === "study-answer") {
    submitStudyAnswer(String(answer || ""));
  }
  if (form.dataset.form === "archive-answer") {
    submitArchiveAnswer(String(answer || ""));
  }
}

function ensureStudySession() {
  if (runtime.studySession?.cards?.length) {
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
  const selectedLevels = randomLevel ? getAvailableLevels() : [getCurrentLevel()];
  const perLevelFocusDay = Object.fromEntries(selectedLevels.map((level) => [level, getCurrentDay(level)]));

  const pools = {
    0: [],
    1: [],
    2: [],
    3: [],
    4: [],
  };

  for (const level of selectedLevels) {
    const focusDay = perLevelFocusDay[level];
    const levelWords = getWordsByLevel(level);

    for (const word of levelWords) {
      const record = state.progress[word.uid];
      const isDue = record.nextReviewAt <= Date.now();
      const isFresh = record.studyCount === 0;

      if (record.stage === 0) {
        if (randomLevel) {
          if (isFresh || isDue) {
            pools[0].push(word);
          }
          continue;
        }

        if (isFresh && word.day === focusDay) {
          pools[0].push(word);
          continue;
        }

        if (!isFresh && isDue && word.day <= focusDay) {
          pools[0].push(word);
        }
        continue;
      }

      if (record.stage >= 1 && record.stage <= 3 && isDue) {
        pools[record.stage].push(word);
      }

      if (record.stage >= 4) {
        pools[4].push(word);
      }
    }
  }

  const sortFn = randomOrder || randomLevel ? shuffled : ordered;
  const selected = [
    ...sortFn(pools[0]).slice(0, 10),
    ...sortFn(pools[1]).slice(0, 10),
    ...sortFn(pools[2]).slice(0, 5),
    ...sortFn(pools[3]).slice(0, 5),
    ...shuffled(pools[4]).slice(0, 5),
  ];

  return dedupeByUid(selected).map((word) => word.uid);
}

function submitStudyAnswer(rawAnswer) {
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

  const isCorrect = isMeaningMatch(answer, word.meaning);
  session.isAnimating = true;
  session.motion = isCorrect ? "is-right" : "is-left";
  session.message = isCorrect ? "정답입니다. 오른쪽 더미로 보냅니다." : "틀렸습니다. 왼쪽 더미로 보냅니다.";
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
  }, 820);
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
    startedAt: Date.now(),
    feedback: archivedWords.length ? "아카이브 단어 30개를 시작합니다." : "아직 아카이브에 들어간 단어가 없습니다.",
    motion: "",
    messageTone: "",
    completedAt: 0,
    isAnimating: false,
  };
}

function submitArchiveAnswer(rawAnswer) {
  const session = runtime.archiveSession;
  if (!session || session.isAnimating) {
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

  const isCorrect = isMeaningMatch(answer, word.meaning);
  session.isAnimating = true;
  session.motion = isCorrect ? "correct" : "wrong";
  render();

  window.setTimeout(() => {
    registerArchiveAttempt(word.uid, isCorrect);

    if (isCorrect) {
      session.feedback = `${word.kanji}를 맞혔습니다. 다음 카드로 넘어갑니다.`;
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
      session.completedAt = Date.now();
      const elapsedMs = session.completedAt - session.startedAt;
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
    </nav>
  `;
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
  const availableLevels = getAvailableLevels();
  const progressPercent = totalCount ? Math.round((learnedCount / totalCount) * 100) : 0;

  return `
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">JLPT 5급부터 차례대로</div>
        <h1 class="hero-title">한 장씩 넘기면서 <span class="jp">ことば</span>를 쌓는 단어장</h1>
        <p class="hero-description">
          기본 흐름은 PDF 순서를 따라갑니다. 지금은 <strong>${currentLevel}</strong> ${currentDay}일차를 기준으로 새 카드를 꺼내고,
          복습 카드와 틀린 카드까지 한 묶음으로 다시 보여줍니다.
        </p>
        <div class="hero-actions">
          <button class="hero-cta" data-route="study">단어 공부하기</button>
          <button class="hero-secondary" data-route="board">전체 오답 확인하기</button>
        </div>
      </div>
      <div class="hero-aside">
        <div class="hero-card">
          <div class="jp">勉強</div>
          <p>귀여운 둥근 일본어 타이포와 부드러운 카드 더미를 중심으로, 맞으면 오른쪽으로 넘기고 틀리면 왼쪽으로 쌓입니다.</p>
        </div>
        <div class="hero-card">
          <div class="petal-row">
            ${Array.from({ length: 5 }, (_, index) => `<span class="petal ${index < Math.max(1, Math.round(progressPercent / 20)) ? "is-filled" : ""}"></span>`).join("")}
          </div>
          <p>현재 구조화된 데이터는 ${availableLevels.join(", ")} 급수입니다. 이후 같은 형식의 데이터가 추가되면 바로 이어집니다.</p>
        </div>
      </div>
    </section>

    <section class="stats-grid">
      <article class="stat-card">
        <div class="stat-copy">
          <span>전체 단어 대비 학습 비율</span>
          <strong>${progressPercent}%</strong>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progressPercent}%"></div>
        </div>
        <span class="footer-note">${learnedCount} / ${totalCount} 단어</span>
      </article>
      <article class="stat-card">
        <div class="stat-copy">
          <span>오늘 학습한 단어</span>
          <strong>${todayCount}</strong>
        </div>
        <span class="footer-note">오늘 날짜 기준으로 한 번 이상 본 단어 수</span>
      </article>
      <article class="stat-card">
        <div class="stat-copy">
          <span>현재 진행 급수 / 챕터</span>
          <strong>${currentLevel} · ${currentDay}일차</strong>
        </div>
        <span class="footer-note">동일 급수를 끝까지 유지하고, 마스터 비율이 95%를 넘으면 다음 급수로 이동합니다.</span>
      </article>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div class="section-heading">
          <strong>급수 진행 상태</strong>
          <span>N5에서 시작해서 완료 비율이 높은 순서대로 다음 급수로 넘어갑니다.</span>
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
  return `
    <div class="level-chip ${isCurrent ? "is-current" : ""}">
      <strong>${level}</strong>
      <small>${levelWords.length ? `${levelWords.length}단어 · 완료 ${completion}%` : "데이터 준비 중"}</small>
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
          <span>기본은 PDF 순서, 필요할 때만 랜덤 순서와 랜덤 급수 모드를 섞습니다.</span>
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
            <div class="mode-grid">
              <div class="panel">
                <div class="panel-header">
                  <div class="section-heading">
                    <strong>문제 생성 모드</strong>
                    <span>평소에는 DATA 순서를 따르고, 버튼을 켜면 묶음만 바뀝니다.</span>
                  </div>
                </div>
                <div class="mode-buttons">
                  <button class="mode-button ${state.settings.randomOrder ? "is-active" : ""}" data-setting="randomOrder">랜덤 순서 모드</button>
                  <button class="mode-button ${state.settings.randomLevel ? "is-active" : ""}" data-setting="randomLevel">랜덤 급수 모드</button>
                  <button class="ghost-button" data-action="regenerate-study">새 카드 묶기</button>
                </div>
              </div>
              <div class="panel">
                <div class="panel-header">
                  <div class="section-heading">
                    <strong>묶음 규칙</strong>
                    <span>모르는 카드 10, 1회 맞춘 카드 10, 2회 5, 3회 5, 4회 이상 5장 랜덤</span>
                  </div>
                </div>
                <span class="footer-note">틀린 카드는 다음 묶음에서 다시 나오고, 맞은 카드는 2일, 3일, 1주 뒤 순서로 돌아옵니다.</span>
              </div>
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
        <button class="primary-button" data-action="finish-study">공부 종료</button>
      </div>
    `;
  }

  const record = state.progress[word.uid];
  const displayLevel = state.settings.randomLevel ? `${word.level} · ${word.day}일차` : `${word.level} · ${word.day}일차`;

  const cardClasses = ["study-card"];
  if (session.motion) {
    cardClasses.push("is-flipped", session.motion);
  }

  return `
    <div class="deck-shell">
      <aside class="pile is-left">
        <div class="pile-label">오답 더미</div>
        <div class="pile-stack">
          <div class="pile-card"></div>
          <div class="pile-card"></div>
          <div class="pile-card"></div>
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
          <div class="pile-card"></div>
          <div class="pile-card"></div>
          <div class="pile-card"></div>
        </div>
        <div class="pile-count">${session.rightPile.length}장</div>
      </aside>
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
            <span class="table-badge">경과 ${formatDuration((session.completedAt || Date.now()) - session.startedAt)}</span>
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
                  <span class="helper-text">아카이브는 시간 기록이 남습니다.</span>
                  <button class="study-submit" type="submit" ${session.isAnimating ? "disabled" : ""}>아카이브 답안 제출</button>
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
  const inProgress = words.filter((word) => state.progress[word.uid].stage < 4);
  const archived = words.filter((word) => state.progress[word.uid].stage >= 4);

  return `
    <section class="table-panel">
      <div class="table-header">
        <div class="section-heading">
          <strong>전체 단어 확인하기</strong>
          <span>진행 중인 카드와 완료된 아카이브 카드를 한 번에 확인합니다.</span>
        </div>
        <div class="table-tabs">
          <button class="tab-button ${runtime.boardTab === "in-progress" ? "is-active" : ""}" data-board-tab="in-progress">진행중</button>
          <button class="tab-button ${runtime.boardTab === "completed" ? "is-active" : ""}" data-board-tab="completed">완료</button>
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
                    return `
                      <tr>
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
  const normalized = normalizeText(value)
    .replace(/[()]/g, " ")
    .replace(/[\u00b7/|]/g, " ")
    .replace(/,/g, " ");

  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(stripParticle)
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
  return normalizeText(value).replace(/\s+/g, "");
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

function startClock() {
  if (runtime.timerId) {
    window.clearInterval(runtime.timerId);
  }
  runtime.timerId = window.setInterval(() => {
    if (runtime.route === "study" && runtime.studyTab === "archive" && runtime.archiveSession && !runtime.archiveSession.completedAt) {
      render();
    }
  }, 1000);
}
