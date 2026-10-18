# Doctor Career Companion: working rules

## One app, three places
The app runs as the **website** (Cloudflare Worker `doctor-career-companion`, deployed by every push to `main`), as the **Claude app**
(artifact "Doctor Career Companion", https://claude.ai/artifact/HCUTx5bthRAJo8V1QEEuv3, published from `app/companion.html`), and inside
the **Life OS hub**. All three must always agree. After changing `app/companion.html`: run `python3 tools/build.py`, commit
`public/index.html` with it, push to `main`, and in the same session republish `app/companion.html` to the artifact URL above (Artifact tool
with its `url`; leave its capabilities as they are). Never add a feature to one place only. Nothing may break existing functionality.

## MKOS is the universal educational operating system (owner mandate, 10/17/2026)
MKOS (`src/mkos`, `mkos/`, see `mkos/README.md`) is the educational system of record, routing, governance, recommendation, asset,
intelligence, confidence, blueprint, pronunciation, curriculum and competency layer, for every current and future feature.
- Any new educational feature integrates with MKOS by default and extends it; it must not create its own knowledge store, question,
  flashcard, competency, curriculum, recommendation, pronunciation, learner-state or board-review system when MKOS has one.
- Every educational path resolves through MKOS before AI: database, registries, knowledge objects, knowledge graph, educational assets,
  learner state, recommendation engine, curriculum engine, then AI. AI teaches, coaches, explains and personalizes; it is never the
  database, the knowledge repository, the blueprint interpreter or the question repository.
- Existing features that do not yet consume MKOS are migration candidates; migrate them progressively, without breaking them.
- In the app, the MKOS layer is the block headed "MKOS: the app's knowledge and learning operating system" in `app/companion.html`
  (`mk()`, `mkLoad()`, `mkTopic()`, `mkBlock()`, the MKOS cards and the Knowledge tab). Generation, the tutor, the planner weights,
  citation checks and the device voice read from it. Server operations for the app live in `src/mkos/bridge.js` and `routes.js`.
- Knowledge extracted from the library never goes into this repository (it is public; MKSAP and textbooks are licensed).

## AI order of operations
The app's AI order of operations (`SERVICES`, `TIERS`, `JOBS`, `AI_ORDER` in `src/worker.js`) was deliberately worked out and is changed
only on a deliberate, specific request from the owner. MKOS calls only free services directly and never changes that hierarchy.

## Builds
- `python3 tools/build.py` after changing `app/companion.html`.
- `node tools/mkos/build.mjs` after changing `mkos/` or the curriculum in `app/companion.html` (must report 0 errors); commit `src/mkos/framework.js`.
- `node tools/mkos/dryrun.mjs --work <dir> [--budget 28]` runs the engine locally (library data stays outside the repo).
