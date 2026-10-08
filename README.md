# Doctor Career Companion

A continuing-education and career app for one physician, built to be listened to. It writes lessons and board-style questions with AI, reads them aloud, tracks what has been mastered and what is slipping, and decides what to study next.

- **The app** (`app/companion.html`) is published as an artifact in Claude. Claude writes the lessons, questions, tutor answers and career plans.
- **The server** (`src/worker.js`, a Cloudflare Worker with a D1 database) holds accounts and the study record. The app inside Claude reaches it through a connector at `/mcp/<token>`.
- **The website** runs the same app at `/` (`public/index.html`, built from `app/companion.html` by `python3 tools/build.py`). Its AI is `/api/ai`: Cloudflare Workers AI through the `AI` binding (reasoning models first), or Claude if an `ANTHROPIC_API_KEY` secret is set. `AI_DAILY` caps requests per account per day (default 200).
- **The account page** (`public/account.html`): sign up, reset a password, make the connector link, download a backup.

After changing `app/companion.html`, run `python3 tools/build.py` before committing.

## What it does

- **Daily check-in.** Pick a commitment (8, 20, 40 or 60 minutes) and a practice setting (outpatient, mixed, inpatient). The planner picks topics from the record and lessons play back to back with the text following along on screen.
- **Audio first, text always.** Each lesson is written as a spoken script and shown as readable text. After a lesson the check questions can be read aloud with a pause before the answer, for hands-free use.
- **Curriculum.** Four tracks: internal medicine by body system, osteopathic manipulative medicine, procedures and regenerative medicine (office procedures, point-of-care ultrasound, shockwave, functional medicine), and practice (quality measures, coding, EHR optimization for Epic, Oracle Health/Cerner, MEDITECH and others).
- **Questions.** ABIM-style single best answer, written per topic or for a knowledge gap stated in the physician's own words. Each set passes a second AI review that drops any item with an arguable key before it is shown. Misses return in 1, 3, 7 and 21 days.
- **Cards.** Short high-yield flashcards per topic, written on request and added by every lesson. Flip, rate confidence on a five-point scale, and each card returns on a spaced schedule. Decks can be flipped, read as a list or listened to; views are counted per day.
- **Mastery.** Per topic: questions answered, percent correct, lessons, self-rating, last studied. A 0–100 score blends smoothed accuracy, the amount of evidence, the self-rating and time since review. Confidence that outruns accuracy is flagged.
- **Consistency.** Streaks, days active per week and month, minutes per day, week and month, listening share.
- **Reference library.** Inside Claude, clinical lessons and questions are grounded in the matching chapter of the physician's own board review text in Google Drive (a folder with one subfolder per subject). The text is read when needed and never stored by the app or this repository.
- **Career.** Goals by area, each with an AI-reasoned plan: steps, measures, risks and the facts to look up.

## Accuracy

Content is generated, not hand-written. The prompts require named guidelines, forbid invented citations and numbers, and ask for an explicit list of anything to verify. The in-app AI has no live web access, so recent guideline changes can be missing. Flagging a question removes it from the statistics.

## Deploy

Cloudflare dashboard → Workers & Pages → Create → Import a repository → this repo. Every push to `main` deploys. The D1 database is created on the first deploy. Optional: a `RESEND_API_KEY` secret (and `MAIL_FROM`) turns on password reset by email.

Then, on the site's account page, make a connector link and add it in Claude as a custom connector named **Doctor Career Companion**.
