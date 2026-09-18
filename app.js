const QUESTIONS_PER_PAGE = 5;
const TEST_LENGTH = 36;
const PASS_SCORE = 30;

const state = {
  view: "home",
  questions: [],
  page: 0,
  answers: {},
  gradedPages: {},
};

function shuffle(list) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function startTest() {
  state.questions = shuffle(window.QUESTION_BANK)
    .slice(0, TEST_LENGTH)
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
  state.page = 0;
  state.answers = {};
  state.gradedPages = {};
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

function answeredCount() {
  return Object.keys(state.answers).length;
}

function gradePage() {
  if (!pageFullyAnswered()) return;
  state.gradedPages[state.page] = true;
  render();
}

function nextPage() {
  if (state.page + 1 >= pageCount()) {
    state.view = "results";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHome() {
  return `
    <section class="hero">
      <div class="art">${illustration()}</div>
      <div>
        <h2 class="lede-title" style="font-family:'Source Serif 4',Georgia,serif;font-size:2rem;font-weight:500;margin:0 0 0.8rem;">Practice Questions</h2>
        <div class="panel">
          <h2>Class C knowledge practice</h2>
          <p class="lede">This unofficial practice test uses the same rhythm as the California sample tests: answer a short set, check your work, then continue. Each attempt draws 36 shuffled questions from a ${window.QUESTION_BANK.length}-question bank.</p>
          <div class="stats">
            <div class="stat"><b>36</b><span>questions per test</span></div>
            <div class="stat"><b>5</b><span>questions per page</span></div>
            <div class="stat"><b>30</b><span>correct to pass</span></div>
          </div>
          <div class="actions">
            <button class="primary" id="start-btn">Start shuffled test</button>
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
  const rangeLabel = start === end ? `Question ${start} of ${TEST_LENGTH}` : `Questions ${start}–${end} of ${TEST_LENGTH}`;
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

  const scoreBox = graded
    ? `<div class="page-score">Page score: ${pageScore} / ${questions.length}. Running total: ${running} / ${answeredSoFar}.</div>`
    : "";

  const action = graded
    ? `<button class="primary" id="next-btn">${lastPage ? "See your score" : "Next questions"}</button>`
    : `<button class="primary" id="grade-btn" ${pageFullyAnswered() ? "" : "disabled"}>Submit page</button>`;

  return `
    <section>
      <h2 style="font-family:'Source Serif 4',Georgia,serif;font-size:2rem;font-weight:500;margin:0 0 0.8rem;">Practice Questions ${state.page + 1} of ${pageCount()}</h2>
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
  const passed = score >= PASS_SCORE;
  const percent = Math.round((score / TEST_LENGTH) * 100);
  const missed = state.questions.filter((question) => !scoreQuestion(question));

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
        <h2 style="font-family:'Source Serif 4',Georgia,serif;font-size:2rem;font-weight:500;margin:0 0 0.8rem;">Your score</h2>
        <div class="panel">
          <div class="results-banner ${passed ? "pass" : "fail"}">
            <strong>${passed ? "Pass" : "Did not pass"}</strong> — ${score} / ${TEST_LENGTH} (${percent}%). The official Class C knowledge test generally requires ${PASS_SCORE} correct answers.
          </div>
          <p class="lede">This was a shuffled 36-question practice test. Take another attempt to draw a new mix from the question bank.</p>
          <div class="missed">
            <h3>Review missed questions</h3>
            ${missedMarkup}
          </div>
          <div class="actions">
            <button class="primary" id="retry-btn">Take another shuffled test</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function illustration() {
  return `
    <svg viewBox="0 0 280 250" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="38" y="168" width="204" height="12" rx="3" fill="#d7e4f4"/>
      <rect x="58" y="180" width="22" height="58" fill="#8fb4d9"/>
      <rect x="200" y="180" width="22" height="58" fill="#8fb4d9"/>
      <rect x="78" y="122" width="124" height="52" rx="8" fill="#5b9bd4"/>
      <circle cx="140" cy="78" r="26" fill="#f0c090"/>
      <path d="M118 68c10-18 34-16 44 4" stroke="#2c3f5c" stroke-width="9" stroke-linecap="round"/>
      <rect x="112" y="136" width="56" height="48" rx="8" fill="#f0c090"/>
      <rect x="96" y="148" width="88" height="40" rx="8" fill="#efc56b"/>
      <rect x="118" y="158" width="44" height="26" rx="3" fill="#1b2a4a"/>
    </svg>
  `;
}

function render() {
  const root = document.getElementById("app");
  if (state.view === "home") root.innerHTML = renderHome();
  if (state.view === "test") root.innerHTML = renderTest();
  if (state.view === "results") root.innerHTML = renderResults();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === "start-btn" || target.id === "retry-btn") startTest();
  if (target.id === "grade-btn") gradePage();
  if (target.id === "next-btn") nextPage();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
  const questionId = Number(target.name.replace("q-", ""));
  selectAnswer(questionId, Number(target.value));
});

render();
