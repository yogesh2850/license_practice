const QUESTIONS_PER_PAGE = 6;
const PROFILE_KEY = "license_practice_profiles_v1";
const SESSION_KEY = "license_practice_session_v1";
const LEGACY_HISTORY_KEY = "license_practice_history_v1";
const LEGACY_COVERAGE_KEY = "license_practice_coverage_v1";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const state = {
  view: "home",
  test: null,
  questions: [],
  page: 0,
  answers: {},
  gradedPages: {},
  startedAt: null,
  savedAttemptId: null,
  selectedAttemptId: null,
  mode: "test",
  nameError: "",
  token: "",
  cloud: false,
  authBusy: false,
  authEmail: "",
};

function tests() {
  return window.TESTS ?? [
    {
      id: "class-c-1",
      name: "Class C Practice Test 1",
      length: 36,
      passScore: 30,
    },
  ];
}

function getTest(testId) {
  return tests().find((item) => item.id === testId) ?? tests()[0];
}

function questionsForTest(test) {
  if (Array.isArray(test.questions) && test.questions.length) return test.questions;
  if (Array.isArray(test.questionIds) && test.questionIds.length) {
    const byId = new Map(window.QUESTION_BANK.map((question) => [question.id, question]));
    return test.questionIds.map((id) => byId.get(id)).filter(Boolean);
  }
  return window.QUESTION_BANK;
}

function shuffle(list) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function emailKey(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase();
}

function emptyProfile(email) {
  const key = emailKey(email);
  return {
    name: key,
    email: key,
    attempts: [],
    coverage: { byTest: {} },
    missed: {},
    inProgress: null,
  };
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "");
    if (parsed && parsed.profiles && typeof parsed.profiles === "object") return parsed;
  } catch {
    // Ignore malformed profile data.
  }
  return { currentKey: "", profiles: {} };
}

function saveStore(store) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(store));
}

function migrateLegacyInto(profile) {
  try {
    const history = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) ?? "");
    if (history && Array.isArray(history.attempts) && history.attempts.length && !profile.attempts.length) {
      profile.attempts = history.attempts;
    }
  } catch {
    // Ignore legacy history.
  }
  try {
    const coverage = JSON.parse(localStorage.getItem(LEGACY_COVERAGE_KEY) ?? "");
    if (coverage && coverage.byTest && !Object.keys(profile.coverage.byTest).length) {
      profile.coverage = coverage;
    }
  } catch {
    // Ignore legacy coverage.
  }
}

function currentProfile() {
  const store = loadStore();
  if (!store.currentKey || !store.profiles[store.currentKey]) return null;
  const profile = store.profiles[store.currentKey];
  const email = emailKey(profile.email || profile.name || store.currentKey);
  if (!EMAIL_RE.test(email)) return null;
  return profile;
}

function currentDisplayName() {
  return currentProfile()?.email || currentProfile()?.name || "";
}

function apiUrl(path) {
  const configured = String(window.APP_CONFIG?.apiUrl ?? "").replace(/\/$/, "");
  if (configured) return `${configured}/api${path}`;
  return new URL(`api${path}`, window.location.href).href;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const session = token ?? state.token;
  if (session) headers.authorization = `Bearer ${session}`;
  const response = await fetch(apiUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

async function probeCloud() {
  try {
    const response = await fetch(apiUrl("/health"), { signal: AbortSignal.timeout(2500) });
    state.cloud = response.ok;
  } catch {
    state.cloud = false;
  }
  return state.cloud;
}

function saveSession(token, email) {
  state.token = token || "";
  if (!token) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, email }));
}

let syncTimer = 0;
function queueCloudSync() {
  if (!state.token || !state.cloud) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    pushProfile().catch(() => {});
  }, 400);
}

async function pushProfile() {
  const profile = currentProfile();
  if (!profile || !state.token) return;
  await api("/profile", {
    method: "PUT",
    body: {
      attempts: profile.attempts ?? [],
      coverage: profile.coverage ?? { byTest: {} },
      missed: profile.missed ?? {},
      inProgress: profile.inProgress ?? null,
    },
  });
}

function applyProfile(email, profile) {
  const key = emailKey(email);
  const store = loadStore();
  store.profiles[key] = {
    ...emptyProfile(key),
    ...profile,
    name: key,
    email: key,
  };
  store.currentKey = key;
  saveStore(store);
  restoreInProgress();
}

function takeLegacyLocalData() {
  const store = loadStore();
  const current = store.profiles[store.currentKey];
  if (current && (current.attempts?.length || Object.keys(current.missed ?? {}).length || current.inProgress)) {
    return {
      attempts: current.attempts ?? [],
      coverage: current.coverage ?? { byTest: {} },
      missed: current.missed ?? {},
      inProgress: current.inProgress ?? null,
    };
  }
  const first = Object.values(store.profiles)[0];
  if (!first) return null;
  if (!(first.attempts?.length || Object.keys(first.missed ?? {}).length || first.inProgress)) return null;
  return {
    attempts: first.attempts ?? [],
    coverage: first.coverage ?? { byTest: {} },
    missed: first.missed ?? {},
    inProgress: first.inProgress ?? null,
  };
}

async function bufToB64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBuf(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  return { hash: await bufToB64(bits), salt: await bufToB64(salt) };
}

async function signupOrLogin(rawEmail, password, mode) {
  const email = emailKey(rawEmail);
  state.authEmail = email;
  if (!EMAIL_RE.test(email)) {
    state.nameError = "Enter a valid email address.";
    return false;
  }
  if (String(password ?? "").length < 6) {
    state.nameError = "Password must be at least 6 characters.";
    return false;
  }
  state.authBusy = true;
  state.nameError = "";
  render();
  try {
    const cloud = await probeCloud();
    if (cloud) {
      const data = await api(mode === "signup" ? "/signup" : "/login", {
        method: "POST",
        body: { email, password },
      });
      saveSession(data.token, email);
      let profile = data.profile ?? emptyProfile(email);
      if (mode === "signup") {
        const legacy = takeLegacyLocalData();
        if (legacy && !(profile.attempts?.length)) {
          profile = { ...profile, ...legacy, email, name: email };
          applyProfile(email, profile);
          await pushProfile();
        } else {
          applyProfile(email, profile);
        }
      } else {
        applyProfile(email, profile);
      }
      state.nameError = "";
      return { existed: mode === "login", name: email };
    }

    const store = loadStore();
    const existing = store.profiles[email];
    if (mode === "signup") {
      if (existing?.passwordHash) {
        state.nameError = "That email already has an account. Log in instead.";
        return false;
      }
      const secret = await hashPassword(password);
      const legacy = existing && !existing.passwordHash ? existing : takeLegacyLocalData();
      store.profiles[email] = {
        ...emptyProfile(email),
        ...(legacy || {}),
        email,
        name: email,
        passwordHash: secret.hash,
        passwordSalt: secret.salt,
      };
    } else {
      if (!existing?.passwordHash) {
        state.nameError = "No account for that email. Create an account first.";
        return false;
      }
      const secret = await hashPassword(password, existing.passwordSalt);
      if (secret.hash !== existing.passwordHash) {
        state.nameError = "Email or password is incorrect.";
        return false;
      }
    }
    store.currentKey = email;
    saveStore(store);
    saveSession("", email);
    restoreInProgress();
    state.nameError = "";
    return { existed: mode === "login", name: email };
  } catch (error) {
    state.nameError = error.message || "Could not log in.";
    return false;
  } finally {
    state.authBusy = false;
  }
}

async function logout() {
  if (state.token) {
    try {
      await api("/logout", { method: "POST" });
    } catch {
      // Ignore network errors on logout.
    }
  }
  saveSession("", "");
  const store = loadStore();
  store.currentKey = "";
  saveStore(store);
  state.questions = [];
  state.test = null;
  state.page = 0;
  state.answers = {};
  state.gradedPages = {};
  state.startedAt = null;
  state.savedAttemptId = null;
  state.mode = "test";
  state.view = "home";
  render();
}

function withProfile(mutator) {
  const store = loadStore();
  const key = store.currentKey;
  if (!key || !store.profiles[key]) return null;
  const result = mutator(store.profiles[key], store);
  saveStore(store);
  queueCloudSync();
  return result;
}

function loadHistory() {
  return { attempts: currentProfile()?.attempts ?? [] };
}

function saveHistory(history) {
  withProfile((profile) => {
    profile.attempts = history.attempts;
  });
}

function saveAttempt(attempt) {
  const history = loadHistory();
  history.attempts.unshift(attempt);
  saveHistory(history);
  return attempt;
}

function loadCoverageMap() {
  return currentProfile()?.coverage ?? { byTest: {} };
}

function saveCoverageMap(map) {
  withProfile((profile) => {
    profile.coverage = map;
  });
}

function missedList() {
  return Object.values(currentProfile()?.missed ?? {}).sort((a, b) =>
    String(b.lastMissedAt ?? "").localeCompare(String(a.lastMissedAt ?? "")),
  );
}

function rememberMissed(results) {
  withProfile((profile) => {
    profile.missed = profile.missed ?? {};
    for (const result of results ?? []) {
      if (!result.correct) {
        const previous = profile.missed[result.id] ?? { timesMissed: 0 };
        profile.missed[result.id] = {
          id: result.id,
          prompt: result.prompt,
          topic: result.topic,
          answer: result.answer,
          selected: result.selected,
          lastMissedAt: new Date().toISOString(),
          timesMissed: (previous.timesMissed ?? 0) + 1,
        };
      } else if (profile.missed[result.id]) {
        delete profile.missed[result.id];
      }
    }
  });
}

function dismissMissed(questionId) {
  withProfile((profile) => {
    if (profile.missed) delete profile.missed[questionId];
  });
}

function persistInProgress() {
  if (!testInProgress()) {
    withProfile((profile) => {
      profile.inProgress = null;
    });
    return;
  }
  withProfile((profile) => {
    profile.inProgress = {
      mode: state.mode,
      test: state.test,
      questions: state.questions,
      page: state.page,
      answers: state.answers,
      gradedPages: state.gradedPages,
      startedAt: state.startedAt,
    };
  });
}

function clearInProgress() {
  withProfile((profile) => {
    profile.inProgress = null;
  });
}

function restoreInProgress() {
  const saved = currentProfile()?.inProgress;
  if (!saved?.questions?.length) {
    state.questions = [];
    state.test = null;
    state.page = 0;
    state.answers = {};
    state.gradedPages = {};
    state.startedAt = null;
    state.savedAttemptId = null;
    state.mode = "test";
    return false;
  }
  state.mode = saved.mode ?? "test";
  state.test = saved.test;
  state.questions = saved.questions;
  state.page = saved.page ?? 0;
  state.answers = Object.fromEntries(
    Object.entries(saved.answers ?? {}).map(([id, value]) => [Number(id), value]),
  );
  state.gradedPages = saved.gradedPages ?? {};
  state.startedAt = saved.startedAt;
  state.savedAttemptId = null;
  return true;
}

function unfinishedSummary() {
  if (!testInProgress()) return null;
  const answered = Object.keys(state.answers).length;
  return {
    name: state.test?.name ?? "Practice test",
    page: state.page + 1,
    pages: pageCount(),
    remaining: Math.max(0, state.questions.length - answered),
    total: state.questions.length,
    kind: state.mode === "review" ? "review" : state.mode === "facts" ? "fact practice" : "test",
  };
}

function isMeasurementAnswer(text) {
  const value = String(text ?? "");
  return (
    /\d+\s*(–|-)?\s*\d*\s*(mph|feet|ft|inches?|seconds?|days?|hours?|years?|months?|pounds?|points?|miles?)|\d+\s*%|\$\s*[\d,]+|0\.\d+\s*%|one-tenth|one-third|one-quarter|one mile|one year|three seconds|two seconds|five seconds|one month|six months|\bhalf\b|\d+\s*(mph|feet)/i.test(
      value,
    ) || /^\d+$/.test(value.trim())
  );
}

function isFactQuestion(question) {
  const correct = question.choices[question.answer] ?? "";
  if (!isMeasurementAnswer(correct)) return false;
  if (/^911$|^sr\s*1$/i.test(String(correct).trim())) return false;
  const measuredChoices = question.choices.filter((choice) => isMeasurementAnswer(choice)).length;
  return measuredChoices >= 2;
}

function factGroup(question) {
  const answer = question.choices[question.answer] ?? "";
  const blob = `${question.prompt} ${answer}`;
  if (/BAC|0\.\d+\s*%/i.test(blob)) return "Alcohol and BAC";
  if (/\$|points/i.test(answer)) return "Fines, points, and other numbers";
  if (
    /mph|speed limit|wet road|packed snow|on ice|visibility|school zone|alley|highway|trailer|residential|blind intersection|NEV|slow-moving|streetcar/i.test(
      blob,
    ) && /mph|\bhalf\b|one-quarter/i.test(answer)
  ) {
    return "Speed limits and conditions";
  }
  if (/feet|inches|mile/i.test(answer)) return "Distances";
  if (/second|day|hour|year|month|following.distance|scan the road/i.test(blob)) {
    return "Time and following distance";
  }
  return "Other numbers";
}

function distinctiveWords(prompt) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "you",
    "may",
    "not",
    "are",
    "was",
    "but",
    "can",
    "how",
    "has",
    "had",
    "its",
    "our",
    "any",
    "all",
    "that",
    "this",
    "with",
    "from",
    "your",
    "have",
    "should",
    "generally",
    "approximately",
    "about",
    "unless",
    "otherwise",
    "posted",
    "normal",
    "normally",
    "recommended",
    "minimum",
    "maximum",
    "ideal",
    "must",
    "when",
    "while",
    "into",
    "than",
    "more",
    "speed",
    "limit",
    "driver",
    "vehicle",
    "california",
    "highway",
    "highways",
    "traffic",
  ]);
  return [
    ...new Set(
      String(prompt)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((word) => word.length > 2 && !stop.has(word)),
    ),
  ];
}

function factFingerprint(question) {
  return {
    answer: String(question.choices[question.answer] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9%]+/g, ""),
    words: distinctiveWords(question.prompt),
  };
}

function uniqueFactQuestions() {
  const facts = (window.QUESTION_BANK ?? []).filter(isFactQuestion).sort((a, b) => a.id - b.id);
  const wordCounts = {};
  for (const question of facts) {
    for (const word of distinctiveWords(question.prompt)) {
      wordCounts[word] = (wordCounts[word] ?? 0) + 1;
    }
  }
  const kept = [];
  for (const question of facts) {
    const next = factFingerprint(question);
    const duplicate = kept.some((existing) => {
      const prev = factFingerprint(existing);
      if (prev.answer !== next.answer) return false;
      const [shorter, longer] =
        next.words.length <= prev.words.length ? [next.words, prev.words] : [prev.words, next.words];
      if (shorter.length >= 2) {
        const contained = shorter.filter((word) => longer.includes(word)).length;
        if (contained / shorter.length >= 0.8) return true;
      }
      const shared = next.words.filter((word) => prev.words.includes(word));
      return shared.some((word) => (wordCounts[word] ?? 0) <= 3);
    });
    if (!duplicate) kept.push(question);
  }
  return kept;
}

function toPracticeQuestions(bankQuestions) {
  return bankQuestions.map((question) => {
    const choices = question.choices.map((text, index) => ({
      text,
      correct: index === question.answer,
    }));
    return {
      id: question.id,
      prompt: question.prompt,
      topic: question.topic,
      choices: shuffle(choices),
    };
  });
}

function coverageFor(testId, bank) {
  const map = loadCoverageMap();
  const bankIds = new Set(bank.map((question) => question.id));
  let entry = map.byTest[testId];
  if (!entry) {
    const seen = new Set();
    for (const attempt of loadHistory().attempts.filter((item) => item.testId === testId)) {
      for (const result of attempt.results ?? []) seen.add(result.id);
    }
    entry = { seenIds: [...seen].filter((id) => bankIds.has(id)), cycles: 0 };
  }
  entry.seenIds = (entry.seenIds ?? []).filter((id) => bankIds.has(id));
  map.byTest[testId] = entry;
  saveCoverageMap(map);
  return entry;
}

function coverageStats(testId, bank) {
  const entry = coverageFor(testId, bank);
  const total = bank.length;
  const seen = entry.seenIds.length;
  return {
    seen,
    total,
    remaining: Math.max(0, total - seen),
    cycles: entry.cycles ?? 0,
    percent: percent(seen, total),
  };
}

function pickCoveringQuestions(bank, length, testId) {
  const take = Math.min(length, bank.length);
  const byId = new Map(bank.map((question) => [question.id, question]));
  const allIds = bank.map((question) => question.id);
  const seen = new Set(coverageFor(testId, bank).seenIds);
  const unseen = shuffle(allIds.filter((id) => !seen.has(id)));
  let pickedIds;
  if (unseen.length >= take) {
    pickedIds = unseen.slice(0, take);
  } else {
    const refill = shuffle(allIds.filter((id) => seen.has(id)));
    pickedIds = [...unseen, ...refill.slice(0, take - unseen.length)];
  }
  return shuffle(pickedIds.map((id) => byId.get(id)).filter(Boolean));
}

function markCovered(testId, bank, questionIds) {
  const map = loadCoverageMap();
  const entry = coverageFor(testId, bank);
  const seen = new Set(entry.seenIds);
  for (const id of questionIds) seen.add(id);
  const allCovered = bank.every((question) => seen.has(question.id));
  if (allCovered) {
    entry.seenIds = [...questionIds];
    entry.cycles = (entry.cycles ?? 0) + 1;
  } else {
    entry.seenIds = [...seen];
  }
  map.byTest[testId] = entry;
  saveCoverageMap(map);
}

function requireName() {
  if (currentDisplayName()) return true;
  state.nameError = "Log in with your email first so we can save this test to you.";
  state.view = "home";
  render();
  return false;
}

function beginQuestionSet(test, questions, mode) {
  state.test = test;
  state.questions = questions;
  state.mode = mode;
  state.page = 0;
  state.answers = {};
  state.gradedPages = {};
  state.startedAt = new Date().toISOString();
  state.savedAttemptId = null;
  state.view = "test";
  persistInProgress();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startTest(testId, { forceNew = false } = {}) {
  if (!requireName()) return;
  if (testInProgress() && !forceNew) {
    state.view = "home";
    render();
    return;
  }
  if (testInProgress() && forceNew) {
    const replace = window.confirm(
      "Start a new shuffled test? This replaces your unfinished test. To keep those remaining questions, tap Continue or Restart this test instead.",
    );
    if (!replace) return;
  }
  const test = getTest(testId);
  const length = test.length ?? 36;
  const bank = questionsForTest(test);
  const questions = pickCoveringQuestions(bank, length, test.id).map((question) => {
    const choices = question.choices.map((text, index) => ({
      text,
      correct: index === question.answer,
    }));
    return {
      id: question.id,
      prompt: question.prompt,
      topic: question.topic,
      choices: shuffle(choices),
    };
  });
  beginQuestionSet(test, questions, "test");
}

function resumeTest() {
  if (!restoreInProgress() && !testInProgress()) return;
  state.view = "test";
  render();
}

function restartUnfinishedTest() {
  if (!testInProgress() && !restoreInProgress()) return;
  state.page = 0;
  state.answers = {};
  state.gradedPages = {};
  state.startedAt = new Date().toISOString();
  state.savedAttemptId = null;
  state.view = "test";
  persistInProgress();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startMissedReview() {
  if (!requireName()) return;
  if (testInProgress() && state.mode !== "review") {
    state.view = "home";
    render();
    return;
  }
  const missed = missedList();
  const byId = new Map(window.QUESTION_BANK.map((question) => [question.id, question]));
  const questions = missed
    .map((item) => byId.get(Number(item.id)))
    .filter(Boolean)
    .slice(0, 36)
    .map((question) => {
      const choices = question.choices.map((text, index) => ({
        text,
        correct: index === question.answer,
      }));
      return {
        id: question.id,
        prompt: question.prompt,
        topic: question.topic,
        choices: shuffle(choices),
      };
    });
  if (!questions.length) {
    state.view = "missed";
    render();
    return;
  }
  beginQuestionSet(
    { id: "missed-review", name: "Missed questions review", length: questions.length, passScore: Math.ceil(questions.length * 0.83) },
    questions,
    "review",
  );
}

function confirmReplaceUnfinished(message) {
  if (!testInProgress()) return true;
  return window.confirm(message);
}

function startFactPractice() {
  if (!requireName()) return;
  if (testInProgress() && state.mode !== "facts") {
    const replace = confirmReplaceUnfinished(
      "Start fact practice? This replaces your unfinished test. Tap Continue or Restart this test instead if you want to keep those remaining questions.",
    );
    if (!replace) {
      state.view = "home";
      render();
      return;
    }
  }
  const questions = toPracticeQuestions(shuffle(uniqueFactQuestions()));
  if (!questions.length) {
    state.view = "facts";
    render();
    return;
  }
  beginQuestionSet(
    {
      id: "fact-review",
      name: "Fact questions",
      length: questions.length,
      passScore: Math.ceil(questions.length * 0.8),
    },
    questions,
    "facts",
  );
}

function pageCount() {
  return Math.ceil(state.questions.length / QUESTIONS_PER_PAGE);
}

function pageQuestions() {
  const start = state.page * QUESTIONS_PER_PAGE;
  return state.questions.slice(start, start + QUESTIONS_PER_PAGE);
}

function questionNumber(indexOnPage) {
  return state.page * QUESTIONS_PER_PAGE + indexOnPage + 1;
}

function pageFullyAnswered() {
  return pageQuestions().every((question) => state.answers[question.id] !== undefined);
}

function scoreQuestion(question) {
  const selected = state.answers[question.id];
  return Boolean(question.choices[selected]?.correct);
}

function scoreRange(questions) {
  return questions.reduce((total, question) => total + (scoreQuestion(question) ? 1 : 0), 0);
}

function totalScore() {
  const gradedQuestions = state.questions.filter((_, index) => {
    const page = Math.floor(index / QUESTIONS_PER_PAGE);
    return state.gradedPages[page];
  });
  return scoreRange(gradedQuestions);
}

function passScore() {
  return state.test?.passScore ?? 30;
}

function pageResults(questions) {
  return questions.map((question) => ({
    id: question.id,
    topic: question.topic,
    correct: scoreQuestion(question),
    prompt: question.prompt,
    selected: question.choices[state.answers[question.id]]?.text ?? "",
    answer: question.choices.find((choice) => choice.correct)?.text ?? "",
  }));
}

function gradePage() {
  if (!pageFullyAnswered()) return;
  state.gradedPages[state.page] = true;
  rememberMissed(pageResults(pageQuestions()));
  persistInProgress();
  render();
}

function finishTest() {
  if (state.savedAttemptId) {
    state.view = "results";
    return;
  }
  const score = scoreRange(state.questions);
  const total = state.questions.length;
  const attempt = {
    id: crypto.randomUUID(),
    name: currentDisplayName(),
    testId: state.test?.id ?? "class-c-1",
    testName: state.test?.name ?? "Class C Practice Test 1",
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    score,
    total,
    passed: score >= passScore(),
    percent: total ? Math.round((score / total) * 100) : 0,
    results: pageResults(state.questions),
  };
  saveAttempt(attempt);
  rememberMissed(attempt.results);
  if (state.mode === "test") {
    const testId = attempt.testId;
    markCovered(testId, questionsForTest(getTest(testId)), state.questions.map((question) => question.id));
  }
  state.savedAttemptId = attempt.id;
  clearInProgress();
  state.view = "results";
}

function nextPage() {
  if (state.page + 1 >= pageCount()) {
    finishTest();
  } else {
    state.page += 1;
  }
  persistInProgress();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function selectAnswer(questionId, choiceIndex) {
  if (state.gradedPages[state.page]) return;
  state.answers[questionId] = choiceIndex;
  persistInProgress();
  const btn = document.getElementById("grade-btn");
  const hint = document.querySelector(".hint");
  if (btn) btn.disabled = !pageFullyAnswered();
  if (hint) {
    hint.textContent = pageFullyAnswered()
      ? "All questions on this page are answered."
      : "All questions must be answered before submitting.";
  }
}

function testInProgress() {
  return state.questions.length > 0 && !state.savedAttemptId;
}

function goHome() {
  state.view = "home";
  render();
}

function goMissed() {
  state.view = "missed";
  render();
}

function goFacts() {
  state.view = "facts";
  render();
}

function saveAuthFromForm(intent) {
  const email = document.getElementById("email-input")?.value ?? "";
  const password = document.getElementById("password-input")?.value ?? "";
  signupOrLogin(email, password, intent === "signup" ? "signup" : "login").then((result) => {
    render();
    if (!result) document.getElementById("email-input")?.focus();
  });
}

function goScores() {
  state.selectedAttemptId = null;
  state.view = "scores";
  render();
}

function showAttempt(attemptId) {
  state.selectedAttemptId = attemptId;
  state.view = "attempt";
  render();
}

function clearHistory() {
  if (!window.confirm("Clear all saved test scores for this account?")) return;
  saveHistory({ attempts: [] });
  state.selectedAttemptId = null;
  state.view = "scores";
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(iso) {
  if (!iso) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function percent(score, total) {
  return total ? Math.round((score / total) * 100) : 0;
}

function summarizeHistory(attempts) {
  const totalAttempts = attempts.length;
  const passes = attempts.filter((attempt) => attempt.passed).length;
  const points = attempts.reduce((sum, attempt) => sum + attempt.score, 0);
  const possible = attempts.reduce((sum, attempt) => sum + attempt.total, 0);
  const best = attempts.reduce((top, attempt) => Math.max(top, attempt.percent), 0);
  const latest = attempts[0] ?? null;
  const byTest = {};
  for (const attempt of attempts) {
    if (!byTest[attempt.testId]) {
      byTest[attempt.testId] = {
        testId: attempt.testId,
        testName: attempt.testName,
        attempts: 0,
        passes: 0,
        points: 0,
        possible: 0,
        best: 0,
      };
    }
    const group = byTest[attempt.testId];
    group.attempts += 1;
    group.passes += attempt.passed ? 1 : 0;
    group.points += attempt.score;
    group.possible += attempt.total;
    group.best = Math.max(group.best, attempt.percent);
  }
  const topics = {};
  for (const attempt of attempts) {
    for (const result of attempt.results ?? []) {
      if (!topics[result.topic]) topics[result.topic] = { topic: result.topic, correct: 0, total: 0 };
      topics[result.topic].total += 1;
      if (result.correct) topics[result.topic].correct += 1;
    }
  }
  const topicList = Object.values(topics)
    .map((topic) => ({ ...topic, percent: percent(topic.correct, topic.total) }))
    .sort((a, b) => a.percent - b.percent);
  return {
    totalAttempts,
    passes,
    passRate: percent(passes, totalAttempts),
    average: percent(points, possible),
    best,
    latest,
    byTest: Object.values(byTest),
    topics: topicList,
  };
}

function recentScoreBlurb() {
  const latest = loadHistory().attempts[0];
  const name = currentDisplayName();
  const missedCount = missedList().length;
  if (!name) return "";
  if (!latest) {
    const extras = [];
    if (missedCount) extras.push(`${missedCount} missed question${missedCount === 1 ? "" : "s"} saved`);
    if (unfinishedSummary()) extras.push("an unfinished test waiting");
    return `<p class="lede">Welcome${extras.length ? " back" : ""}, <strong>${escapeHtml(name)}</strong>. ${extras.length ? `We still have ${extras.join(" and ")} for you.` : "No completed tests yet."}</p>`;
  }
  return `<p class="lede">Welcome back, <strong>${escapeHtml(name)}</strong>. You've taken this test before. Last attempt: <strong>${latest.score} / ${latest.total}</strong> (${latest.percent}%) on ${escapeHtml(latest.testName)} — ${latest.passed ? "pass" : "did not pass"}${missedCount ? `. ${missedCount} missed question${missedCount === 1 ? "" : "s"} saved for review` : ""}.</p>`;
}

function renderAuthForm() {
  const email = currentDisplayName();
  const cloudLabel = state.cloud
    ? "Saved to the shared database, so you can log in on another phone or computer."
    : "The shared database isn't connected from this page, so this account stays on this device.";
  if (email) {
    return `
      <div class="name-form">
        <p class="lede" style="margin-bottom:0.6rem">Logged in as <strong>${escapeHtml(email)}</strong></p>
        <p class="hint">${cloudLabel}</p>
        <div class="actions">
          <button class="ghost js-logout" type="button">Log out</button>
        </div>
      </div>
    `;
  }
  return `
    <form class="name-form" id="auth-form">
      <label for="email-input">Email</label>
      <input id="email-input" name="email" type="email" autocomplete="email" placeholder="you@email.com" value="${escapeHtml(state.authEmail)}" />
      <label for="password-input">Password</label>
      <input id="password-input" name="password" type="password" autocomplete="current-password" placeholder="at least 6 characters" />
      ${state.nameError ? `<p class="feedback bad">${escapeHtml(state.nameError)}</p>` : ""}
      <p class="hint">Log in with your email to see your scores, unfinished tests, and missed questions. Create an account if this is your first time.</p>
      <div class="name-row">
        <button class="primary" name="intent" value="login" type="submit" ${state.authBusy ? "disabled" : ""}>Log in</button>
        <button class="ghost" name="intent" value="signup" type="submit" ${state.authBusy ? "disabled" : ""}>Create account</button>
      </div>
    </form>
  `;
}

function renderUnfinishedBanner() {
  const unfinished = unfinishedSummary();
  if (!unfinished) return "";
  return `
    <div class="unfinished">
      <p><strong>Unfinished ${unfinished.kind} saved</strong> — ${escapeHtml(unfinished.name)}. Page ${unfinished.page} of ${unfinished.pages}. ${unfinished.remaining} question${unfinished.remaining === 1 ? "" : "s"} still remaining.</p>
      <div class="actions">
        <button class="primary" id="resume-btn" type="button">Continue</button>
        <button class="ghost" id="restart-unfinished" type="button">Restart this test</button>
      </div>
    </div>
  `;
}

function renderHome() {
  const available = tests();
  const history = loadHistory();
  const bankSize = window.QUESTION_BANK.length;
  const testCards = available
    .map((test) => {
      const attempts = history.attempts.filter((attempt) => attempt.testId === test.id);
      const latest = attempts[0];
      const bank = questionsForTest(test);
      const coverage = coverageStats(test.id, bank);
      const latestLabel = latest
        ? `Last score ${latest.score} / ${latest.total} (${latest.percent}%)`
        : "No attempts yet";
      const coverageLabel = coverage.remaining
        ? `${coverage.remaining} of ${coverage.total} questions still unseen this cycle`
        : `Full bank covered${coverage.cycles ? ` · ${coverage.cycles} cycle${coverage.cycles === 1 ? "" : "s"} complete` : ""}`;
      return `
        <article class="test-card">
          <div>
            <h3>${escapeHtml(test.name)}</h3>
            <p>${escapeHtml(test.description ?? "36 shuffled questions, 6 per page.")}</p>
            <p class="hint">${escapeHtml(latestLabel)}. ${escapeHtml(coverageLabel)}.</p>
          </div>
          <button class="primary" data-start-test="${test.id}" ${currentDisplayName() ? "" : "disabled"} ${unfinishedSummary() ? "data-start-new=1" : ""}>${unfinishedSummary() ? "Start new test" : "Start test"}</button>
        </article>
      `;
    })
    .join("");

  return `
    <section class="hero">
      <div class="art">${illustration()}</div>
      <div>
        <h2 class="section-title">Practice Questions</h2>
        <div class="panel">
          <h2>Class C knowledge practice</h2>
          ${renderAuthForm()}
          <p class="lede">Each test uses 36 shuffled questions from a ${bankSize}-question bank, 6 per page. After you submit a page you see how many you got right and wrong, then continue. Unseen questions are drawn first so the whole set is covered before questions repeat.</p>
          ${recentScoreBlurb()}
          ${renderUnfinishedBanner()}
          <div class="stats">
            <div class="stat"><b>36</b><span>questions per test</span></div>
            <div class="stat"><b>6</b><span>questions per page</span></div>
            <div class="stat"><b>${bankSize}</b><span>questions in the bank</span></div>
          </div>
          <div class="test-list">${testCards}</div>
          <div class="actions">
            <button class="ghost js-scores" type="button">View my scores</button>
            <button class="ghost js-facts" type="button">Fact questions (${uniqueFactQuestions().length})</button>
            <button class="ghost js-missed" type="button">Missed questions (${missedList().length})</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderChoices(question, graded) {
  const selected = state.answers[question.id];
  return question.choices
    .map((choice, index) => {
      const checked = selected === index ? "checked" : "";
      const classes = ["choice"];
      if (graded && selected === index && choice.correct) classes.push("correct");
      if (graded && selected === index && !choice.correct) classes.push("incorrect");
      if (graded && choice.correct && selected !== index) classes.push("reveal-correct");
      return `
        <label class="${classes.join(" ")}">
          <input type="radio" name="q-${question.id}" value="${index}" ${checked} ${graded ? "disabled" : ""}>
          <span>${escapeHtml(choice.text)}</span>
        </label>
      `;
    })
    .join("");
}

function renderQuestionFeedback(question, graded) {
  if (!graded) return "";
  if (scoreQuestion(question)) {
    return `<p class="feedback ok">Correct</p>`;
  }
  const correctText = question.choices.find((choice) => choice.correct)?.text ?? "";
  return `<p class="feedback bad">Incorrect. Correct answer: ${escapeHtml(correctText)}</p>`;
}

function renderTest() {
  const questions = pageQuestions();
  const start = state.page * QUESTIONS_PER_PAGE + 1;
  const end = start + questions.length - 1;
  const total = state.questions.length;
  const rangeLabel = start === end ? `Question ${start} of ${total}` : `Questions ${start}–${end} of ${total}`;
  const graded = Boolean(state.gradedPages[state.page]);
  const pageScore = graded ? scoreRange(questions) : null;
  const running = graded ? totalScore() : scoreRange(state.questions.slice(0, start - 1));
  const answeredSoFar = graded ? end : start - 1;
  const lastPage = state.page + 1 >= pageCount();
  const barWidth = ((state.page + (graded ? 1 : 0)) / pageCount()) * 100;

  const questionMarkup = questions
    .map((question, index) => {
      const number = questionNumber(index);
      return `
        <article class="question" data-id="${question.id}">
          <p class="q-title">${number}. ${escapeHtml(question.prompt)} <span class="req">*</span></p>
          ${renderChoices(question, graded)}
          ${renderQuestionFeedback(question, graded)}
        </article>
      `;
    })
    .join("");

  const hint = graded
    ? ""
    : `<p class="hint">${pageFullyAnswered() ? "All questions on this page are answered." : "All questions must be answered before submitting."}</p>`;

  const wrongCount = graded ? questions.length - pageScore : 0;
  const scoreBox = graded
    ? `<div class="page-score">
         <div class="page-score-grid">
           <div class="stat"><b class="ok">${pageScore}</b><span>right</span></div>
           <div class="stat"><b class="bad">${wrongCount}</b><span>wrong</span></div>
           <div class="stat"><b>${running} / ${answeredSoFar}</b><span>running total</span></div>
         </div>
         <p>This page: ${pageScore} right, ${wrongCount} wrong out of ${questions.length}.</p>
       </div>`
    : "";

  const action = graded
    ? `<button class="primary" id="next-btn">${lastPage ? "See your score" : "Next questions"}</button>`
    : `<button class="primary" id="grade-btn" ${pageFullyAnswered() ? "" : "disabled"}>Submit page</button>`;

  return `
    <section>
      <h2 class="section-title">${escapeHtml(state.test?.name ?? "Practice Questions")} · Page ${state.page + 1} of ${pageCount()}</h2>
      <div class="panel">
          <div class="progress">
            <span>${rangeLabel}</span>
          </div>
          <div class="progress-bar"><span style="width:${barWidth}%"></span></div>
          ${questionMarkup}
          ${scoreBox}
          <div class="actions">
            ${action}
            ${testInProgress() ? `<button class="ghost" id="restart-unfinished" type="button">Restart this test</button>` : ""}
            ${hint}
          </div>
      </div>
    </section>
  `;
}

function renderResults() {
  const score = scoreRange(state.questions);
  const total = state.questions.length;
  const passed = score >= passScore();
  const pct = percent(score, total);
  const missed = state.questions.filter((question) => !scoreQuestion(question));
  const history = summarizeHistory(loadHistory().attempts);

  const missedMarkup = missed.length
    ? missed
        .map((question, index) => {
          const selected = question.choices[state.answers[question.id]]?.text ?? "No answer";
          const correct = question.choices.find((choice) => choice.correct)?.text ?? "";
          return `
            <div class="missed-item">
              <p><strong>${index + 1}. ${escapeHtml(question.prompt)}</strong></p>
              <p>Your answer: ${escapeHtml(selected)}</p>
              <p>Correct answer: ${escapeHtml(correct)}</p>
            </div>
          `;
        })
        .join("")
    : `<p>You missed none of the questions on this attempt.</p>`;

  return `
    <section class="hero">
      <div class="art">${illustration()}</div>
      <div>
        <h2 class="section-title">Your score</h2>
        <div class="panel">
          <div class="results-banner ${passed ? "pass" : "fail"}">
            <strong>${passed ? "Pass" : "Did not pass"}</strong> — ${score} / ${total} (${pct}%). Saved to your score history on this device.
          </div>
          <div class="stats">
            <div class="stat"><b>${history.totalAttempts}</b><span>tests recorded</span></div>
            <div class="stat"><b>${history.average}%</b><span>overall average</span></div>
            <div class="stat"><b>${history.passRate}%</b><span>pass rate</span></div>
          </div>
          <div class="missed">
            <h3>Review missed questions</h3>
            ${missedMarkup}
          </div>
          <div class="actions">
            <button class="primary" data-start-test="${state.test?.id ?? "class-c-1"}">Take another shuffled test</button>
            <button class="ghost js-missed" type="button">Review missed questions</button>
            <button class="ghost js-scores" type="button">View all scores</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderScores() {
  const attempts = loadHistory().attempts;
  const summary = summarizeHistory(attempts);
  if (!attempts.length) {
    return `
      <section>
        <h2 class="section-title">My scores</h2>
        <div class="panel">
          <p class="lede">No tests recorded yet. Finish a practice test and it will appear here, including later tests you add.</p>
          <div class="actions">
            <button class="primary js-home" type="button">Back to tests</button>
          </div>
        </div>
      </section>
    `;
  }

  const trend = [...attempts].slice(0, 12).reverse();
  const maxBar = Math.max(100, ...trend.map((attempt) => attempt.percent));
  const trendMarkup = trend
    .map(
      (attempt) => `
        <div class="trend-col" title="${escapeHtml(attempt.testName)}: ${attempt.percent}%">
          <span class="trend-bar ${attempt.passed ? "pass" : "fail"}" style="height:${Math.max(8, (attempt.percent / maxBar) * 100)}%"></span>
          <span>${attempt.percent}%</span>
        </div>
      `,
    )
    .join("");

  const testRows = summary.byTest
    .map(
      (group) => `
        <tr>
          <td>${escapeHtml(group.testName)}</td>
          <td>${group.attempts}</td>
          <td>${percent(group.points, group.possible)}%</td>
          <td>${percent(group.passes, group.attempts)}%</td>
          <td>${group.best}%</td>
        </tr>
      `,
    )
    .join("");

  const topicRows = summary.topics.length
    ? summary.topics
        .map(
          (topic) => `
            <div class="topic-row">
              <div class="topic-label">
                <span>${escapeHtml(topic.topic)}</span>
                <strong>${topic.correct} / ${topic.total} (${topic.percent}%)</strong>
              </div>
              <div class="progress-bar"><span style="width:${topic.percent}%"></span></div>
            </div>
          `,
        )
        .join("")
    : "<p class='hint'>Topic breakdown will appear after you complete a test.</p>";

  const attemptRows = attempts
    .map(
      (attempt) => `
        <tr>
          <td>${escapeHtml(formatDate(attempt.finishedAt))}</td>
          <td>${escapeHtml(attempt.testName)}</td>
          <td>${attempt.score} / ${attempt.total}</td>
          <td>${attempt.percent}%</td>
          <td><span class="pill ${attempt.passed ? "pass" : "fail"}">${attempt.passed ? "Pass" : "Did not pass"}</span></td>
          <td><button class="linkish" data-view-attempt="${attempt.id}">Details</button></td>
        </tr>
      `,
    )
    .join("");

  const coverageRows = tests()
    .map((test) => {
      const coverage = coverageStats(test.id, questionsForTest(test));
      return `
        <div class="topic-row">
          <div class="topic-label">
            <span>${escapeHtml(test.name)}</span>
            <strong>${coverage.seen} / ${coverage.total} seen (${coverage.remaining} left)</strong>
          </div>
          <div class="progress-bar"><span style="width:${coverage.percent}%"></span></div>
        </div>
      `;
    })
    .join("");

  return `
    <section>
      <h2 class="section-title">My scores</h2>
      <div class="panel">
        <p class="lede">${currentDisplayName() ? `Scores for <strong>${escapeHtml(currentDisplayName())}</strong>. ` : ""}All completed tests for this account are saved. Each new test prefers questions you have not seen yet so the full bank gets covered.</p>
        <div class="stats stats-4">
          <div class="stat"><b>${summary.totalAttempts}</b><span>tests taken</span></div>
          <div class="stat"><b>${summary.average}%</b><span>overall score</span></div>
          <div class="stat"><b>${summary.passRate}%</b><span>pass rate</span></div>
          <div class="stat"><b>${summary.best}%</b><span>best score</span></div>
        </div>
        <h3>Recent trend</h3>
        <div class="trend">${trendMarkup}</div>
        <h3>By test</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Attempts</th>
                <th>Average</th>
                <th>Pass rate</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>${testRows}</tbody>
          </table>
        </div>
        <h3>Question coverage</h3>
        ${coverageRows}
        <h3>Weakest topics</h3>
        ${topicRows}
        <h3>All attempts</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Test</th>
                <th>Score</th>
                <th>%</th>
                <th>Result</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${attemptRows}</tbody>
          </table>
        </div>
        <div class="actions">
          <button class="primary js-home" type="button">Back to tests</button>
          <button class="ghost js-missed" type="button">Missed questions</button>
          <button class="ghost" id="clear-history">Clear history</button>
        </div>
      </div>
    </section>
  `;
}

function renderAttempt() {
  const attempt = loadHistory().attempts.find((item) => item.id === state.selectedAttemptId);
  if (!attempt) {
    return renderScores();
  }
  const missed = (attempt.results ?? []).filter((result) => !result.correct);
  const missedMarkup = missed.length
    ? missed
        .map(
          (result, index) => `
            <div class="missed-item">
              <p><strong>${index + 1}. ${escapeHtml(result.prompt)}</strong></p>
              <p>Your answer: ${escapeHtml(result.selected || "No answer")}</p>
              <p>Correct answer: ${escapeHtml(result.answer)}</p>
            </div>
          `,
        )
        .join("")
    : "<p>You missed none of the questions on this attempt.</p>";

  return `
    <section>
      <h2 class="section-title">${escapeHtml(attempt.testName)}</h2>
      <div class="panel">
        <div class="results-banner ${attempt.passed ? "pass" : "fail"}">
          <strong>${attempt.passed ? "Pass" : "Did not pass"}</strong> — ${attempt.score} / ${attempt.total} (${attempt.percent}%) on ${escapeHtml(formatDate(attempt.finishedAt))}.
        </div>
        <div class="missed">
          <h3>Missed questions</h3>
          ${missedMarkup}
        </div>
        <div class="actions">
          <button class="primary js-scores" type="button">Back to scores</button>
          <button class="ghost" data-start-test="${attempt.testId}">Retake this test</button>
        </div>
      </div>
    </section>
  `;
}

function renderMissed() {
  const missed = missedList();
  if (!missed.length) {
    return `
      <section>
        <h2 class="section-title">Missed questions</h2>
        <div class="panel">
          <p class="lede">${currentDisplayName() ? `${escapeHtml(currentDisplayName())}, y` : "Y"}ou don't have any saved missed questions yet. Wrong answers from a finished test will appear here so you can read them or try them again.</p>
          <div class="actions">
            <button class="primary js-home" type="button">Back to tests</button>
          </div>
        </div>
      </section>
    `;
  }
  const items = missed
    .map(
      (item) => `
        <article class="missed-item">
          <p class="hint">${escapeHtml(item.topic ?? "")} · missed ${item.timesMissed ?? 1} time${(item.timesMissed ?? 1) === 1 ? "" : "s"}</p>
          <p><strong>${escapeHtml(item.prompt)}</strong></p>
          <p>Your last answer: ${escapeHtml(item.selected || "No answer")}</p>
          <p>Correct answer: ${escapeHtml(item.answer)}</p>
          <button class="linkish" data-dismiss-missed="${item.id}" type="button">Remove from list</button>
        </article>
      `,
    )
    .join("");
  return `
    <section>
      <h2 class="section-title">Missed questions</h2>
      <div class="panel">
        <p class="lede">${currentDisplayName() ? `Saved for <strong>${escapeHtml(currentDisplayName())}</strong>. ` : ""}Read the correct answers, or practice just these questions. Getting one right later removes it from this list.</p>
        <div class="actions">
          <button class="primary" id="practice-missed" type="button">Practice missed questions</button>
        </div>
        <div class="missed">${items}</div>
        <div class="actions">
          <button class="ghost js-home" type="button">Back to tests</button>
        </div>
      </div>
    </section>
  `;
}

function renderFacts() {
  const facts = uniqueFactQuestions();
  const groups = {};
  for (const question of facts) {
    const group = factGroup(question);
    if (!groups[group]) groups[group] = [];
    groups[group].push(question);
  }
  const groupOrder = [
    "Speed limits and conditions",
    "Distances",
    "Time and following distance",
    "Alcohol and BAC",
    "Fines, points, and other numbers",
    "Other numbers",
  ];
  const groupMarkup = groupOrder
    .filter((name) => groups[name]?.length)
    .map((name) => {
      const rows = groups[name]
        .map(
          (question) => `
            <div class="fact-row">
              <p>${escapeHtml(question.prompt)}</p>
              <p class="fact-answer">${escapeHtml(question.choices[question.answer])}</p>
            </div>
          `,
        )
        .join("");
      return `
        <div class="fact-group">
          <h3>${escapeHtml(name)} <span class="hint">${groups[name].length}</span></h3>
          ${rows}
        </div>
      `;
    })
    .join("");

  return `
    <section>
      <h2 class="section-title">Fact Questions</h2>
      <div class="panel">
        <p class="lede">Numbers that show up on the knowledge test: speed limits, distances, time limits, BAC, and similar facts. Read them here, or practice just this set.</p>
        <div class="stats">
          <div class="stat"><b>${facts.length}</b><span>number facts</span></div>
          <div class="stat"><b>${Object.keys(groups).length}</b><span>groups</span></div>
          <div class="stat"><b>6</b><span>per practice page</span></div>
        </div>
        <div class="actions">
          <button class="primary" id="practice-facts" type="button">Practice fact questions</button>
        </div>
        ${groupMarkup}
        <div class="actions">
          <button class="ghost js-home" type="button">Back to tests</button>
        </div>
      </div>
    </section>
  `;
}

function illustration() {
  return `
    <svg viewBox="0 0 280 250" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="38" y="168" width="204" height="12" rx="3" fill="#2a3344"/>
      <rect x="58" y="180" width="22" height="58" fill="#6ea8ff"/>
      <rect x="200" y="180" width="22" height="58" fill="#6ea8ff"/>
      <rect x="78" y="122" width="124" height="52" rx="8" fill="#3d7ad6"/>
      <circle cx="140" cy="78" r="26" fill="#f3c453"/>
      <path d="M118 68c10-18 34-16 44 4" stroke="#f4f6fb" stroke-width="9" stroke-linecap="round"/>
      <rect x="112" y="136" width="56" height="48" rx="8" fill="#f3c453"/>
      <rect x="96" y="148" width="88" height="40" rx="8" fill="#ffd56a"/>
      <rect x="118" y="158" width="44" height="26" rx="3" fill="#101218"/>
    </svg>
  `;
}

function render() {
  const root = document.getElementById("app");
  const logoutBtn = document.querySelector(".top-link.js-logout");
  if (logoutBtn) logoutBtn.hidden = !currentDisplayName();
  if (state.view === "home") root.innerHTML = renderHome();
  if (state.view === "test") root.innerHTML = renderTest();
  if (state.view === "results") root.innerHTML = renderResults();
  if (state.view === "scores") root.innerHTML = renderScores();
  if (state.view === "attempt") root.innerHTML = renderAttempt();
  if (state.view === "missed") root.innerHTML = renderMissed();
  if (state.view === "facts") root.innerHTML = renderFacts();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest("[data-go-home]") || target.closest(".js-home")) {
    event.preventDefault();
    goHome();
    return;
  }
  if (target.closest(".js-scores")) {
    event.preventDefault();
    goScores();
    return;
  }
  if (target.closest(".js-facts")) {
    event.preventDefault();
    goFacts();
    return;
  }
  if (target.closest(".js-missed")) {
    event.preventDefault();
    goMissed();
    return;
  }
  if (target.closest(".js-logout")) {
    event.preventDefault();
    logout();
    return;
  }
  if (target.id === "resume-btn") {
    resumeTest();
    return;
  }
  if (target.id === "restart-unfinished") {
    restartUnfinishedTest();
    return;
  }
  if (target.id === "practice-missed") {
    startMissedReview();
    return;
  }
  if (target.id === "practice-facts") {
    startFactPractice();
    return;
  }
  if (target.id === "grade-btn") gradePage();
  if (target.id === "next-btn") nextPage();
  if (target.id === "clear-history") clearHistory();
  const startId = target.getAttribute("data-start-test");
  if (startId) startTest(startId, { forceNew: target.hasAttribute("data-start-new") });
  const attemptId = target.getAttribute("data-view-attempt");
  if (attemptId) showAttempt(attemptId);
  const dismissId = target.getAttribute("data-dismiss-missed");
  if (dismissId) {
    dismissMissed(Number(dismissId));
    render();
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== "auth-form") return;
  event.preventDefault();
  const submitter = event.submitter;
  const intent = submitter instanceof HTMLButtonElement ? submitter.value : "login";
  saveAuthFromForm(intent);
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
  const questionId = Number(target.name.replace("q-", ""));
  selectAnswer(questionId, Number(target.value));
});

async function restoreSession() {
  await probeCloud();
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "");
  } catch {
    saved = null;
  }
  if (state.cloud && saved?.token) {
    state.token = saved.token;
    try {
      const data = await api("/profile");
      applyProfile(data.profile?.email || saved.email, data.profile);
      return;
    } catch {
      saveSession("", "");
    }
  }
  restoreInProgress();
}

restoreSession().finally(() => {
  restoreInProgress();
  render();
});
