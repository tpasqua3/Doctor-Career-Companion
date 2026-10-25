# Doctor Career Companion: working rules

## One app, three places
The app runs as the **website** (Cloudflare Worker `doctor-career-companion`, deployed by every push to `main`), as the **Claude app**
(artifact "Doctor Career Companion", https://claude.ai/artifact/HCUTx5bthRAJo8V1QEEuv3, published from `app/companion.html`), and inside
the **Life OS hub**. All three must always agree. After changing `app/companion.html`: run `python3 tools/build.py`, commit
`public/index.html` with it, push to `main`, and in the same session republish `app/companion.html` to the artifact URL above (Artifact tool
with its `url`; leave its capabilities as they are, except to add a new connector tool the page calls). Then refresh the Life OS copy:
the Life OS artifact (repo tpasqua3/Life-OS, see its CLAUDE.md) publishes `doctor.html`, built from this artifact's published page with
its `build_embed.txt` script; rebuild and republish it, and add any new connector tool to `EMBED` in its `claude/page.html` and to its
capabilities. (The Life OS website frames this website, so it needs nothing.) Never add a feature to one place only. Nothing may break
existing functionality.

## MKOS is the universal educational operating system (owner mandate, 10/17/2026)
MKOS (`src/mkos`, `mkos/`, see `mkos/README.md`) is the educational system of record, routing, governance, recommendation, asset,
intelligence, confidence, blueprint, pronunciation, curriculum and competency layer, for every current and future feature.
- Any new educational feature integrates with MKOS by default and extends it; it must not create its own knowledge store, question,
  flashcard, competency, curriculum, recommendation, pronunciation, learner-state or board-review system when MKOS has one.
- Every educational path resolves through MKOS before AI: database, registries, knowledge objects, knowledge graph, educational assets,
  learner state, recommendation engine, curriculum engine, then AI. AI teaches, coaches, explains and personalizes; it is never the
  database, the knowledge repository, the blueprint interpreter or the question repository.
- Educational assets are governed MKOS assets, not disposable AI output (owner directive, 10/18/2026): retrieve first, generate only
  when needed. Every educational asset kind (lessons and audio lessons, questions, flashcards, board review content, cases, and any new
  kind) asks `asset_find` before writing and stores what it writes with `asset_put` after its accuracy review (`src/mkos/assets.js`,
  `mkos/ontology/assets.json`; app helpers `mkA`, `mkShare`, `mkStore`). Generate only when no asset exists, it was superseded, the
  guideline changed, the blueprint weighting changed materially, or the learner needs a personalized adaptation (stored as their own).
- Sources are decomposed into structured knowledge (`decompose.js`, `classify.js`, `mkos/ontology/decomposition.json`) and MKOS
  reconciles itself daily with the Life OS refresh (`reconcile.js`). New knowledge features extend these rather than parsing documents
  again; new object kinds get a classification and a place in the graph.
- Existing features that do not yet consume MKOS are migration candidates; migrate them progressively, without breaking them.
- In the app, the MKOS layer is the block headed "MKOS: the app's knowledge and learning operating system" in `app/companion.html`
  (`mk()`, `mkLoad()`, `mkTopic()`, `mkBlock()`, the MKOS cards and the Knowledge tab). Generation, the tutor, the planner weights,
  citation checks and the device voice read from it. Server operations for the app live in `src/mkos/bridge.js` and `routes.js`.
- Drive is MKOS's memory and D1 its working copy (directives in `mkos/directives/`): every durable change, configuration
  included, is queued and stays pending until Drive confirms it (`src/mkos/mirror.js`); restore and the drill bring it back. Shared
  knowledge is never kept in an account: the owner's pronunciation list, its log and the ABIM blueprint document are central records
  (`_central`, see `homeOf()` in `src/worker.js`). A new setting persists by default; never write credentials to Drive.
- Knowledge extracted from the library never goes into this repository (it is public; MKSAP and textbooks are licensed).

## The MKOS Constitution (owner, 10/24/2026)
`mkos/directives/mkos_constitution.md` binds all MKOS work. MKOS models medicine; exams, lessons and curricula are projections of
it. Knowledge objects are canonical and owned by no educational product. No specialty or source is primary. Nothing is mapped to
only one objective, and exam relevance is computed from the objective graph, never written into concepts. No knowledge asset may stop
at ingestion: every source passes through the Continuous Knowledge Lifecycle (`src/mkos/lifecycle.js`, `relevance.js`,
`mkos/ontology/lifecycle.json`, all rules, no AI). A future exam needs only its blueprint (`blueprints.json` family data).

## USAP Account-Level Data Framework (ADF, SR-42)
`src/usap_adf_v1.js` is a copy of the Brain's `domain-sdk/usap_adf_v1.js`: replace it, never edit it here. `src/adf.js` wires it into the
per-account folders only (never MKOS central storage or the library): once per account, from the five-minute timer when the copy job
was light, each existing `acct-<id>` folder gets the standard subfolders (its `backups/` reused) and a `metadata_registry.json`
registering `account.json` (profile) and the record files (app_specific) where they are; nothing is moved, renamed or deleted, and
`syncUser` writes `records/`, `backups/` and `account.json` as before. The once-per-account flag is `drive_accounts.adf`. The
`adf_conformance` metric is sent once a day (00:00 UTC run of `usapStatus`). Export (`GET /api/backup` and the page's Download a
backup) is the standard bundle `{usap_adf:"1", adf_version, app_id:"doctor_companion_app", exported_at, user_state, …, app_data}`
with the app's old bundle unchanged in `app_data`; the page's restore (`adfOpen`) accepts it and older files. Tests:
`node --test test/adf.test.mjs`.

## Activity events (Routine Rewards)
`src/activity.js` sends one activity event through the node kit (`usap.emitEvent`, flushed over `USAP_UGF`) when a completion
reaches the server; USAP routes it to Routine Rewards. Found where the save arrives (`actBefore`/`actAfter` in `src/worker.js`, both
`PUT /api/doc` and the connector's `save_doc`, by comparing the stored body with the new one), so the page has no code for it:
- `med/log`: a new sitting of a minute or more → **StudySessionCompleted** (`duration_min`, category `medical_study`).
- `med/state` `sets`: a new question set → **QuestionSetCompleted** (`quantity` = questions answered, unit `question`).
- `med/les_<id>`: `done` newly set → **LessonCompleted**.
- MKOS `deriveFromRecord` (learner job): a `blueprint_topic` state entering Mastery from an earlier recorded state →
  **ObjectiveCompleted** (`objective_id`), through `deps.objectivesMastered`.
`user_id` is the subject (`s1_` + sha256 of `lifeos-subject:v1:` + email), computed at emit time and never stored; no email, no
event. `idempotency_key` = `doctor_companion_app:<account tag>.<record>:<type>` (the tag is a hash of the account id). Metadata only
`duration_min`, `quantity`, `unit`, `category`, `label` (generic activity names), `objective_id`. Only completions within the last
3 days are reported (no backfill; restores report nothing). Tests: `node --test test/activity.test.mjs`.

## DADD-AI: confidence triage, owner review, reports and event procedures (owner decision 10/25/2026)
MKOS is the highest governance priority of DADD-AI, the Department of Advancing the Development of Deterministic AI (a USAP governance
agency; contract `specs/uepd_app_contract.md`, USAP `src/procedures.js`). "Monitor everything, review exceptions": AI-made content is not
queued for the owner wholesale. Rules only, no AI calls; the code is `src/mkos/dadd.js` (bound to the node kit in `src/worker.js`).
- **Triage** (`putAssets` in `src/mkos/assets.js`): every shared asset stored after generation (lessons, questions, flashcards, board
  review content) gets `triage` { kind, confidence 0..1, scores, band green|yellow|orange|red, action, failure_mode, contributing,
  severity, critical, sampled, queue held|monitor|null, hard_fail, policy, assessed_at, review, reported }. Domains (weights renormalized
  over what is measured): source .15 (cited sources current), evidence .20 (grounding recommendations and guideline families), objective_mapping
  .15 (two objectives or more score full: the Constitution), ontology .15 (concepts), extraction .10 (how the grounding recommendations were
  extracted; only when there are some), generation .10 (the accuracy review), review .15 (past owner decisions on the kind, 0.5 at first).
  Everything is the critical class. Bands come from USAP `GET /api/v1/governance/review/policy?kind=` over `USAP_UGF` (`x-usap-app`),
  cached an hour, defaults when USAP is down: >= 0.95 live, 0.90-0.95 live_flagged (monitored), 0.80-0.90 orange and < 0.80 red
  review_hold (red first in the queue). A superseded citation or a rewrite of an owner-reviewed asset that needs regenerating is a hard
  failure (review_hold); a live owner-reviewed asset is never replaced by a new AI version (`kept_owner_reviewed`). Held means needs
  `['review']`: `asset_find` serves it to no other learner; the owner's own `asset_find` sees it (`_owner`, nothing written back).
  Personalized adaptations (`ea.u…`) and the owner's retroactive import (`{ triage: false }`) are not triaged; existing assets keep
  their state (no backfill). Unchanged content keeps its assessment.
- **Owner review** (`asset_queue`, `asset_decide`; owner only, also through the connector's `mkos` tool; the page's Knowledge tab shows
  the queue to the owner): accept, edit (a new version superseding the AI one, `owner_edit` provenance, `confidence_after`) or reject
  (retired), stored as `triage.review` { decision, reviewer owner, reviewed_at, version }. `asset_review` ok/retire/regenerate maps onto
  accept/reject.
- **Reports** (`asset_report` {id, reason wrong|unsafe|duplicate|other}; `asset_flag` from a learner is the same with "other"): one per
  account and item in `mk_asset_reports` (item id, reason, time, a one-way hash of the account id; nothing else), counted on the asset
  (`triage.reported`), held from others until reviewed. The page offers it on library lessons and on answered library questions.
- **Events** (system scope, no user_id, central labels only): ContentAssessed (each new assessment), ReviewDecided (kind, decision,
  reported, sampled, band, asset_id, confidence_before, confidence_after on an edit), ContentReported (kind, reason), SourceIngested
  (`registerFile`, a new or changed source by md5; key kept as `trigger` on the lifecycle record), ProcedureCompleted
  (sop.source_ingestion, when the source's decomposition finishes (ok), its ingestion fails (failed) or a newer version replaces it
  (skipped); ai_calls = the extraction's AI calls on that source, setting `uepd_ai:<source>`), CoverageGapDetected/Closed (an objective
  with exam weight and no lesson: `mk_gaps` kind `lesson` opening or closing in `detectGaps`).
- **Daily health report** (`healthReport`, 00:00 UTC run of `usapStatus`, node kit metrics): dadd_ai_overall_confidence and
  dadd_ai_failure_rate (assets assessed in 30 days), dadd_ai_educational_coverage (blueprint topics with a current lesson, coverage
  rows), dadd_ai_objective_coverage (current blueprint objectives with a shared asset), dadd_ai_knowledge_population (canonical
  objectives with supporting knowledge), dadd_ai_evidence_linkage (current shared assets with a cites link), dadd_ai_ontology_integrity
  (concepts neither orphaned nor schema-stopped), dadd_ai_guideline_currency (sources current and not past their review date),
  dadd_ai_population_velocity (knowledge objects created in 7 days). A figure with no data is not sent.
Tests: `node --test test/dadd.test.mjs`.

## AI order of operations
The app's AI order of operations (`SERVICES`, `TIERS`, `JOBS`, `AI_ORDER` in `src/worker.js`) was deliberately worked out and is changed
only on a deliberate, specific request from the owner. MKOS calls only free services directly and never changes that hierarchy.
MKOS's background AI budget (owner directive 10/24/2026, `ingestion.extraction` in `mkos/ontology/ingestion.json`, `aiWindow` in
`src/mkos/extract.js`): up to 60 calls a day (Gemini quick, then Workers AI); in the last 2 hours before midnight UTC the cap lifts and
only the Gemini models are used until each reports its limit. Every AI call is timed for USAP with `usap.timeAI` (counts and timings
only, owner go-ahead 10/24/2026); the timing never changes which service answers.
Each timed call also carries its USAP AI governance label (node kit 1.3.0, `src/aigov.js`: catalog action
`doctor_companion_app.<action>`, feature, path ai or hybrid, user_initiated); rules answers in MKOS extraction call
`deps.recordDeterministic`. Labels only: no prompt text or user id, and nothing changes routing.

## Builds
- `python3 tools/build.py` after changing `app/companion.html`.
- `node tools/mkos/build.mjs` after changing `mkos/` or the curriculum in `app/companion.html` (must report 0 errors); commit `src/mkos/framework.js`.
- `node tools/mkos/dryrun.mjs --work <dir> [--budget 28]` runs the engine locally (library data stays outside the repo).
