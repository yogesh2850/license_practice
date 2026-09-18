const QUESTIONS_PER_PAGE = 6;
const STORAGE_KEY = "license_practice_history_v1";
const COVERAGE_KEY = "license_practice_coverage_v1";

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

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (parsed && Array.isArray(parsed.attempts)) return parsed;
  } catch {
    // Ignore malformed local data and start a fresh history.
  }
  return { attempts: [] };
}

function saveHistory(history) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function saveAttempt(attempt) {
  const history = loadHistory();
  history.attempts.unshift(attempt);
  saveHistory(history);
  return attempt;
}

function loadCoverageMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COVERAGE_KEY) ?? "");
    if (parsed && parsed.byTest && typeof parsed.byTest === "object") return parsed;
  } catch {
    // Ignore malformed coverage data.
  }
  return { byTest: {} };
}

function saveCoverageMap(map) {
  localStorage.setItem(COVERAGE_KEY, JSON.stringify(map));
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

function startTest(testId) {
  const test = getTest(testId);
  const length = test.length ?? 36;
  const bank = questionsForTest(test);
  state.test = test;
  state.questions = pickCoveringQuestions(bank, length, test.id).map((question) => {
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
  state.page = 0;
  state.answers = {};
  state.gradedPages = {};
  state.startedAt = new Date().toISOString();
  state.savedAttemptId = null;
  state.view = "test";
  render();
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

function gradePage() {
  if (!pageFullyAnswered()) return;
  state.gradedPages[state.page] = true;
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
    testId: state.test?.id ?? "class-c-1",
    testName: state.test?.name ?? "Class C Practice Test 1",
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    score,
    total,
    passed: score >= passScore(),
    percent: total ? Math.round((score / total) * 100) : 0,
    results: state.questions.map((question) => ({
      id: question.id,
      topic: question.topic,
      correct: scoreQuestion(question),
      prompt: question.prompt,
      selected: question.choices[state.answers[question.id]]?.text ?? "",
      answer: question.choices.find((choice) => choice.correct)?.text ?? "",
    })),
  };
  saveAttempt(attempt);
  const testId = attempt.testId;
  markCovered(testId, questionsForTest(getTest(testId)), state.questions.map((question) => question.id));
  state.savedAttemptId = attempt.id;
  state.view = "results";
}

function nextPage() {
  if (state.page + 1 >= pageCount()) {
    finishTest();
  } else {
    state.page += 1;
  }
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function selectAnswer(questionId, choiceIndex) {
  if (state.gradedPages[state.page]) return;
  state.answers[questionId] = choiceIndex;
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
  if (!window.confirm("Clear all saved test scores on this device?")) return;
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
  if (!latest) return "";
  return `<p class="lede">Last attempt: <strong>${latest.score} / ${latest.total}</strong> (${latest.percent}%) on ${escapeHtml(latest.testName)} — ${latest.passed ? "pass" : "did not pass"}.</p>`;
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
          <button class="primary" data-start-test="${test.id}">Start test</button>
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
          <p class="lede">Each test uses 36 shuffled questions from a ${bankSize}-question bank, 6 per page. After you submit a page you see how many you got right and wrong, then continue. Unseen questions are drawn first so the whole set is covered before questions repeat.</p>
          ${recentScoreBlurb()}
          <div class="stats">
            <div class="stat"><b>36</b><span>questions per test</span></div>
            <div class="stat"><b>6</b><span>questions per page</span></div>
            <div class="stat"><b>${bankSize}</b><span>questions in the bank</span></div>
          </div>
          <div class="test-list">${testCards}</div>
          <div class="actions">
            <button class="ghost js-scores" type="button">View my scores</button>
            ${testInProgress() ? `<button class="ghost" id="resume-btn">Resume current test</button>` : ""}
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
        <p class="lede">All completed tests on this browser are saved. Each new test prefers questions you have not seen yet so the full bank gets covered.</p>
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
  if (state.view === "home") root.innerHTML = renderHome();
  if (state.view === "test") root.innerHTML = renderTest();
  if (state.view === "results") root.innerHTML = renderResults();
  if (state.view === "scores") root.innerHTML = renderScores();
  if (state.view === "attempt") root.innerHTML = renderAttempt();
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
  if (target.id === "resume-btn") {
    state.view = "test";
    render();
    return;
  }
  if (target.id === "grade-btn") gradePage();
  if (target.id === "next-btn") nextPage();
  if (target.id === "clear-history") clearHistory();
  const startId = target.getAttribute("data-start-test");
  if (startId) startTest(startId);
  const attemptId = target.getAttribute("data-view-attempt");
  if (attemptId) showAttempt(attemptId);
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
  const questionId = Number(target.name.replace("q-", ""));
  selectAnswer(questionId, Number(target.value));
});

render();
