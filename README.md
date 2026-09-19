# California Driver License Practice Test

Unofficial Class C knowledge-test practice, styled after the [California DMV sample tests](https://www.dmv.ca.gov/portal/driver-education-and-safety/educational-materials/sample-driver-license-dl-knowledge-tests/).

Live: [https://yogesh2850.github.io/license_practice/](https://yogesh2850.github.io/license_practice/)

## How it works

- Each attempt shuffles **36 questions** from the current bank (300 questions).
- Unseen questions are drawn first so the full bank is covered before repeats.
- Questions appear **6 per page**. Each page shows how many you got right and wrong before you continue.
- Submit a page to see that page’s score, then continue.
- Passing target is **30 / 36**, matching the usual adult Class C knowledge test.
- Log in with your **email** so scores, unfinished tests, and missed questions stay attached to you. Create an account the first time; after that you can log in on another device and see the same status.
- Accounts are stored in a **SQLite** database (`server/data/practice.db`) when you run the Node server, so more than 10 people can use the site at once.
- If you leave a test unfinished, **Continue** picks up the same remaining questions. **Restart this test** starts that same 36-question set over from page 1 instead of throwing the rest away.
- Wrong answers are kept on **Missed questions** so you can read the correct answer later or practice just those items.
- **Fact Questions** collects the number facts (speed limits, distances, BAC, time limits) so you can read them or practice that set.

Add more questions in `questions.js` (or `scripts/build_extra_questions.py`), and extra tests in `window.TESTS`. Scores stay grouped by test name.

## Run with the database

GitHub Pages can host the pages, but shared login needs the Node server:

```bash
npm start
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787). Accounts live in `server/data/practice.db`.

To use the same accounts on GitHub Pages, host that server and set `apiUrl` in `config.js` to its public URL.
