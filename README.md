# California Driver License Practice Test

Unofficial Class C knowledge-test practice, styled after the [California DMV sample tests](https://www.dmv.ca.gov/portal/driver-education-and-safety/educational-materials/sample-driver-license-dl-knowledge-tests/).

Live: [https://yogesh2850.github.io/license_practice/](https://yogesh2850.github.io/license_practice/)

## How it works

- Each attempt shuffles **36 questions** from the current bank (300 questions).
- Unseen questions are drawn first so the full bank is covered before repeats.
- Questions appear **6 per page**. Each page shows how many you got right and wrong before you continue.
- Submit a page to see that page’s score, then continue.
- Passing target is **30 / 36**, matching the usual adult Class C knowledge test.
- Finished tests are saved in the browser. Open **My scores** for overall average, pass rate, weakest topics, coverage, and every attempt.

Add more questions in `questions.js` (or `scripts/build_extra_questions.py`), and extra tests in `window.TESTS`. Scores stay grouped by test name.
