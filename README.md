# Doctor Career Companion

A continuing-education and career app for one physician, built to be listened to. It writes lessons and board-style questions with AI, reads them aloud, tracks what has been mastered and what is slipping, and decides what to study next.

- **The app** (`app/companion.html`) is published as an artifact in Claude. Claude writes the lessons, questions, tutor answers and career plans.
- **The server** (`src/worker.js`, a Cloudflare Worker with a D1 database) holds accounts and the study record. The app inside Claude reaches it through a connector at `/mcp/<token>`.
- **The website** runs the same app at `/` (`public/index.html`, built from `app/companion.html` by `python3 tools/build.py`). Its AI is `/api/ai`: Cloudflare Workers AI through the `AI` binding (reasoning models first), or Claude if an `ANTHROPIC_API_KEY` secret is set. `AI_DAILY` caps requests per account per day (default 200). With the key set, `AI_MODEL` and `AI_MODEL_QUICK` pick the Claude models (defaults `claude-sonnet-5-5` and `claude-haiku-4-5-20251001`).
- **The account page** (`public/account.html`): sign up, reset a password, make the connector link, download a backup.

After changing `app/companion.html`, run `python3 tools/build.py` before committing.

## What it does

- **Daily check-in.** Pick a commitment (8, 20, 40 or 60 minutes) and a practice setting (outpatient, mixed, inpatient). The planner picks topics from the record and lessons play back to back with the text following along on screen.
- **Audio first, text always.** Each lesson is written as a spoken script and shown as readable text. After a lesson the check questions can be read aloud with a pause before the answer, for hands-free use.
- **Boards.** A track built from the ABIM internal medicine blueprint: every content category with its share of the exam and every topic with its relevance rating by task. The planner weights topics by relevance and exam share, drops topics rated low, and reports a readiness score. Two outlines come with the app, so Boards works on the website and inside Claude with no setup: cert (the first-time Certification exam: every examinable topic with the exam share of its category and subsection, no ratings) and recert (the MOC exam and LKA: every topic rated by task). The physician picks one on the Boards tab; sessions, questions, cards and the plan follow it, and progress carries across by topic name. On the Boards tab a different edition can be uploaded as the ABIM's PDF (read in the browser by where the text sits on the page), or loaded from Google Drive inside Claude; it is kept in the physician's record and is offered as a third choice.
- **Companion and learning plan.** An Ask button in the corner of every screen opens one conversation that knows what is on screen, the study record, the blueprint relevance and the matching reference chapter. It builds a self-paced plan for the whole curriculum, laid out by the app in weekly pages so its length is not limited by one AI reply (the AI adds the roadmap and chooses what comes first): the blueprint sets the frame, and within it priority goes to demonstrated uncertainty (wrong answers, low self-ratings, cards rated low, topics asked about, named gaps).
- **Requests and academic half day.** Any topic can be requested by name and is taught, tested or carded on the spot, filed under the matching curriculum topic. A schedule of the residency program's teaching sessions moves each topic to the front of the plan in the week before.
- **Study log and feedback loop.** Lessons can be marked complete; every lesson, question set and deck is logged with the time spent. Questions put to the companion are kept as a short history and a running AI note on what the physician is trying to understand. All of it feeds one need figure per topic that orders sessions, shapes the plan and shortens flashcard intervals on weak topics; card ratings feed back into mastery.
- **Landscape and in-training exam.** Disciplines are scored in points and placed against the physician's own average. An in-training exam report (PDF, pictures or pasted text) is read into content-area scores and missed objectives, which are matched to topics and raised in the plan.
- **Curriculum.** Four tracks: internal medicine by body system, osteopathic manipulative medicine, procedures and regenerative medicine (office procedures, point-of-care ultrasound, shockwave, functional medicine), and practice (quality measures, coding, EHR optimization for Epic, Oracle Health/Cerner, MEDITECH and others).
- **Questions.** ABIM-style single best answer, written per topic or for a knowledge gap stated in the physician's own words. Each set passes a second AI review that drops any item with an arguable key before it is shown. Misses return in 1, 3, 7 and 21 days.
- **Cards.** Short high-yield flashcards per topic, written on request and added by every lesson. Flip, rate confidence on a five-point scale, and each card returns on a spaced schedule. Decks can be flipped, read as a list or listened to; views are counted per day.
- **Backup.** The History tab (and Settings) downloads a backup file of the whole record and restores one from an uploaded file.
- **Mastery.** Per topic: questions answered, percent correct, lessons, self-rating, last studied. A 0–100 score blends smoothed accuracy, the amount of evidence, the self-rating and time since review. Confidence that outruns accuracy is flagged.
- **Consistency.** Streaks, days active per week and month, minutes per day, week and month, listening share.
- **Reference library.** Inside Claude, clinical lessons, questions and cards are grounded in the user's own texts in Google Drive: a board review syllabus as the first source and optional textbook folders as a second, each with an edition year so time-sensitive content follows the most recent source. Figures in a chapter (a title, the image, its legend) can be shown beside the lesson section that covers exactly that finding. Text and images are read when needed and are never stored by the app or this repository; each user connects their own library.
- **Career.** Goals by area, each with an AI-reasoned plan: steps, measures, risks and the facts to look up.

## Accuracy

Content is generated, not hand-written. The prompts require named guidelines, forbid invented citations and numbers, and ask for an explicit list of anything to verify. The in-app AI has no live web access, so recent guideline changes can be missing. Flagging a question removes it from the statistics.

## Deploy

Cloudflare dashboard → Workers & Pages → Create → Import a repository → this repo. Every push to `main` deploys. The D1 database is created on the first deploy. Optional: a `SIGNUP_CODE` secret limits sign-up to people who are given that code (without it, anyone with the address can create an account and use the site's AI allowance). Optional: a `RESEND_API_KEY` secret (and `MAIL_FROM`) turns on password reset by email.

### Reference library on the website (optional)

Inside Claude the app reads the user's Google Drive through Claude's connector. The website reads Drive through a Google service account instead, and only the folders shared with it:

1. In Google Cloud, create a project, enable the Google Drive API, create a service account and download a JSON key for it.
2. In Cloudflare, add two secrets to this Worker: `GOOGLE_SERVICE_ACCOUNT` (the whole contents of the key file) and `LIBRARY_EMAILS` (the account emails allowed to use the library, comma separated; `*` for everyone).
3. In Google Drive, share each library folder with the service account's email address as a Viewer.

Google Docs are read as text and their figures shown; PDFs and other files are converted with Workers AI. Text is read when needed and never written to the database.

Then, on the site's account page, make a connector link and add it in Claude as a custom connector named **Doctor Career Companion**.
