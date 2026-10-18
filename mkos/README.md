# MKOS: the Medical Knowledge Operating System

The knowledge backend of Doctor Career Companion, built from the *MKOS V3 Canonical Architecture Specification*, the *Knowledge
Currency and Continuous Evolution Principle* and the *Universal Confidence, Uncertainty and Trust Model* (Medical Training App Push,
week of 10/17/2026), following the *MKOS Implementation Directive*.

MKOS turns the documents in the library (guidelines, MKSAP, textbooks, blueprints) into versioned, scored, provenance-carrying
knowledge objects in a graph. The app teaches from that structure. AI is the last layer: it may teach, explain and generate
educational assets, but it never creates authority.

## What lives where

| Tier | Where | What |
|---|---|---|
| Framework (this repo) | `mkos/ontology/*.json`, `mkos/schemas/*.json` | The ontology (21 concept types, 26 facet groups / 252 facets, 16 spec relationships + 15 structural ones, evidence levels, authority hierarchy, versioning, difficulty, competency, learner, confidence, routing, stop-the-line), the specialty taxonomy, source classes, scoring numbers, competencies, the ingestion pipeline, and 25 JSON Schemas. `node tools/mkos/build.mjs` validates it and writes `src/mkos/framework.js`. |
| Live store | Cloudflare D1, tables `mk_*` | Every knowledge object (`mk_objects`) and every version of it (`mk_versions`), the graph (`mk_edges`), aliases, the library as last scanned (`mk_files`), change events, jobs, audit, reviews, owner settings, asset links, learner state, misconceptions, reconciliation items, routing decisions, mirror state. |
| Durable central record | Google Drive: Side Gigs › App Backends › Doctor Companion App › Doctor Companion App Central Registry Data › **MKOS** (`MKOS_DRIVE_FOLDER`) | One file per object type and specialty, the graph, a readable sources registry, the staged compatibility registry, governance reports and a daily snapshot. Written by the server; not read back. |
| Per account | `mk_learner*`, `mk_misconceptions`, `mk_reconcile` (D1, keyed by account) | The learner's digital twin. Never written to the central folder. |

**Nothing extracted from the library is ever committed to this repository** (the repository is public; MKSAP and textbooks are
licensed). The server reads the library from Drive itself.

## The engine (src/mkos)

| Module | Layer |
|---|---|
| `db.js` | D1 tables, settings (owner overrides of any framework number: `fw:<path>`), audit |
| `kb.js` | Knowledge Layer object store: schema check, scoring, versioning (patch/minor/major), supersession, aliases, current-state-first queries |
| `scoring.js` | The six knowledge scores (authority, evidence, citation, freshness, supersession, trust), confidence objects, evidence/strength crosswalks |
| `graph.js` | Knowledge Graph Layer: typed edges, neighbors with inverse labels, reach |
| `resolve.js` | Ontology protection: name -> concept (alias, variants, trigram), free-text citation -> guideline family and edition |
| `ingest.js` | Library scanner (change detection by md5 / modified time / path), classification, source registration, guideline families and supersession, owner registry import |
| `extract.js` | Extraction: text -> chunks -> rules first (ACC/AHA COR/LOE rows, KDIGO grades) -> AI only where needed -> recommendations, concepts, facet claims, evidence, relations |
| `impact.js` | Automatic impact analysis and learner-state reconciliation; rescoring of affected objects only |
| `education.js` | Framework seeding, blueprint import (Blueprint, Domain, BlueprintTopic, concepts), curriculum tree with the app's own topic ids, mapping of existing lessons/questions/cards |
| `learner.js` | Learner Intelligence: mastery, confidence, retention, calibration and priority per concept, blueprint topic, curriculum node, domain, specialty and competency; misconceptions |
| `adaptive.js` | Adaptive curriculum (teach, review, assess, reinforce, remediate, prioritize, delay); the governed concept context package; deterministic-first routing |
| `governance.js` | Reviews and approvals, stop-the-line checks, knowledge graph validation, status |
| `cutover.js` | The eight-gate retirement of the legacy guideline registry (below) |
| `mirror.js` | The Drive MKOS folder |
| `tick.js` | The engine loop on the 5-minute cron, with a self-tuning query budget so it works on free and paid plans |
| `blueprint.js` | Board Blueprint Governance and the Blueprint Execution Engine: blueprint registries, domains, objectives, concept and asset mappings, the learner's selected blueprint, board scores and the board plan |
| `pronounce.js` | The pronunciation registry and its governance (below) |
| `bridge.js` | The app bridge: one call per screen (`app_bundle`), the governed topic package handed to the app's AI (`topic_context`), citation checks, asset flags |
| `assets.js` | Educational assets as governed MKOS objects: retrieve first, generate only when needed (below) |
| `decompose.js` | Knowledge decomposition: criteria, objectives, competencies, teaching points, targets, pathways, pearls (below) |
| `classify.js` | Classification and subclassification of every object (below) |
| `reconcile.js` | The daily reconciliation engine (below) |
| `routes.js` | `/api/mkos/<op>` and the connector tool `mkos` |

The cron gives MKOS its turn in each 5-minute run in which no account records were waiting to be copied to Drive. Each run:
bootstrap imports (framework, legacy registry, both blueprints, curriculum) -> one page of the library scan -> up to six jobs (family,
impact, rescore, extract, assets, learner) -> two mirror shards. Everything is resumable and idempotent.

## Dynamic updating

Add, replace or remove a document anywhere in **Medical Knowledge Database** and the next sweep (within about 30 minutes of the last
one) sees it: a change event is created, the source is registered and classified, its guideline family is recomputed (the newest
edition becomes current; older ones are superseded, or *modified* when the newer one is a focused update), its text is extracted,
and an impact analysis flags exactly the recommendations, concepts, lessons, questions, cards, curriculum nodes and learner states it
touches. A new blueprint registry (`ABIM_IM_<CERT|LKA>_blueprint_registry_vN_CURRENT.json`) supersedes the previous edition.

Files over 25 MB cannot be read by the server; split them into chapters or keep them as Google Docs.

## Operations (`/api/mkos/<op>` or the connector tool `mkos` with `{op, args}`)

Everyone: `status`, `search`, `object/<id>`, `context/<concept id>`, `route?q=`, `learner`, `plan`, `refresh_me`, `framework`,
`app_bundle`, `topic_context`, `check_citations`, `asset_flags`, `asset_find`, `asset_put`, `asset_flag`, `asset_stats`, `blueprints`,
`board-review`, `select_blueprint`, `pronunciation`.
Owner: `events`, `jobs`, `audit`, `review {id, result, note}`, `edit {object}`, `set_status`, `settings {path, value}` (for example
`ingestion.extraction.daily_ai_budget_default`), `rescan`, `requeue`, `tick`, `graph_validation`, `compat_registry`,
`cutover_validate`, `cutover_retire {confirm: true}`, `cutover_rollback`, `asset_review`, the `pron_*` operations.

AI extraction calls only free services (Gemini's quick model on the free tier, then Cloudflare Workers AI), directly and under its own
usage account `mkos`: a paid service is never reached, the app's AI hierarchy is unchanged and no learner's allowance is spent. Variables: `MKOS=off` pauses the engine; `MKOS_AI=off` keeps extraction to rules only.

## Pronunciation registry (src/mkos/pronounce.js, mkos/ontology/pronunciation.json)

Pronunciation is a governed knowledge object: one `Pronunciation` record per term (display name, simplified respelling, IPA, SSML,
alternatives, confidence fields, band, validation status, management, correction and review history), linked to its concept by
`has_pronunciation` and carried as the `pronunciation` facet. The owner's central list (med/says, the app's Pronunciation test) stays
the admin store: each entry is mirrored as an admin-locked, approved record and words confirmed "right as written" likewise; anything
approved through MKOS is written back into that list. Free-AI candidates (taught by the owner's confirmed respellings, calibrated by
his acceptance rate) are generated daily for likely-misread terms and for anything flagged; they enter as unvalidated and are never
spoken until confirmed (`pronunciation.tts_use.min_overall_confidence`, default 95). Every voice on the server reads the account's
list, then the owner's, then the MKOS records cleared for speech, so a correction made once is heard everywhere.
Owner operations: `pron_dashboard`, `pron_flag {term}` (Mark Pronunciation Incorrect), `pron_approve {term, index | simplified, lock}`,
`pron_reject`, `pron_sync`; everyone: `pronunciation {term}`.

## Board blueprint governance (src/mkos/blueprint.js, mkos/ontology/blueprints.json)

Board review is a weighting over MKOS, not a separate system. Each blueprint registry in the library (ABIM Certification, ABIM MOC/LKA,
and any later board) is projected into `mk_blueprint_registries`, `mk_blueprint_domains`, `mk_blueprint_objectives` and concept and asset
mappings with frequency, importance, relevance and priority scores; a newer registry supersedes the previous edition. Each learner has a
selected blueprint (`select_blueprint`; the app sets it from the Boards choice), and every board score (question, flashcard, lesson,
recommendation priority) is computed from that blueprint and the learner's state. Operations: `blueprints [id]`, `learners/me/board-plan`,
`board-review`, `select_blueprint {family | app_kind}`.

## The app bridge (src/mkos/bridge.js, the MKOS block in app/companion.html)

Every educational screen reads MKOS before any AI is asked. `app_bundle` gives Today, Boards, Progress, Questions, Cards and Knowledge
the learner model, the plan, the board plan, per-topic board priorities (which also weight the app's planner), flags and the governed
pronunciations. `topic_context` gives a lesson, question set, card set or tutor answer the topic's current guideline editions, graded
recommendations with citations, board weighting and the learner's state, as a prompt block: the AI teaches from MKOS instead of memory.
`check_citations` marks citations naming an older edition. On the website the app calls `/api/mkos/<op>`; inside Claude and in the
Life OS copy it calls the connector tool `mkos`; a local copy without either simply hides the MKOS panels.

## Educational assets: retrieve first, generate only when needed (src/mkos/assets.js, mkos/ontology/assets.json)

Lessons (which are also the audio lessons: the device voice reads the lesson text with the governed pronunciations), questions,
flashcards and the board review content built from them are first-class MKOS objects: `EducationalAsset` records with their content
per version in `mk_asset_store`, linked to the concepts they teach and to the guideline editions and recommendations they were built on
(`mk_asset_links`), so impact analysis flags them the moment that knowledge changes.

    Knowledge Objects -> Educational Assets -> asset exists?  yes: reuse
                                                              no:  generate -> validate -> store

- **Retrieve first.** Before writing, the app asks `asset_find`. A lesson is served when MKOS holds one for the topic, length and board
  weighting band that is current, validated and guideline-current. Questions and flashcards come from a pool: the items this learner
  has not been served (`mk_asset_usage`), at the requested difficulty; only the shortfall is written.
- **Generate only when** there is no asset; it was superseded or flagged for regeneration; a guideline family it relied on has a new
  current edition, a guideline family now covers the topic that did not when it was written (the library was indexed later), a recommendation or its evidence level changed, the topic's coverage expanded, or its objectives, competencies or clinical relationships changed; the board weighting moved materially (`blueprint_material_delta`, default
  20; lessons are kept per weighting band so two blueprints never overwrite each other); or the request is a personalized adaptation
  (a focus, a knowledge gap, a basis lesson, a lesson being finished).
- **Validate, then store.** `asset_put` stores what was written. *Validated* means the app's independent accuracy review ran over the
  whole asset; an asset citing an older guideline edition is stored as `citation_outdated` and never served; unreviewed material is
  stored but not served (`validation.reuse_unreviewed`, default false), and never replaces a validated asset. A lesson's check
  questions and cards travel inside the lesson's asset.
- **Shared vs. personal.** Shared assets (`ea.s.*`) are written from MKOS's knowledge without any one learner's state
  (`prompt_block_shared`) and serve every account. Personalized ones are stored as the learner's own (`ea.u<account>.g.*`) and are never
  shared or mirrored.
- **Governance.** Anyone can report a problem (`asset_flag`); one report stops reuse until the owner reviews it (`asset_review {id,
  result: ok | regenerate | retire}`), or until a fresh validated version replaces it. `asset_stats` shows the library, reuse and the
  review queue. In the app: a reused lesson says it came from the MKOS library (with "Write a fresh version" and "Report a problem"),
  question sets say how many came from the bank, and the Knowledge tab shows the library.

## Knowledge decomposition and classification (src/mkos/decompose.js, classify.js, mkos/ontology/decomposition.json)

Documents are source material; structured knowledge is the operational layer. After a source is extracted, each recommendation is
decomposed by rules (no AI) into Claims (eligibility, contraindication, not recommended, exception, monitoring, threshold), a learning
and an assessment Objective (difficulty from class and evidence, competencies and subcompetencies, blueprint topics), a teaching
point carrying its targets (question, flashcard, case, review), and high-yield and common-error objects where the class of
recommendation calls for them; each concept gets lesson and review targets, each guideline section a clinical pathway, and concepts
with enough recommendations get clinical pearls from the free AI (pending validation, never authoritative until reviewed). Everything
is linked in the graph (derived_from, teaches, assesses, develops, mapped_to_blueprint, covers, precedes). Delta processing: each
recommendation records the version it was decomposed at, so only new or changed ones are reprocessed, and objects a changed
recommendation no longer yields are retired. Every object carries a classification (domain, subdomain, specialty, topic, subtopic,
object type, difficulty, board and educational relevance, evidence strength, authority, confidence, version, status, supersession,
validation, governance), derived like the scores and recomputed only when the object changes. The decomposed knowledge reaches the
app through `topic_context` (prompt blocks and the topic panel) and the Knowledge tab. Operation: `decomposition` (progress and counts).

Extraction never waits on the AI budget: when the day's free AI budget is spent, parts are processed by rules and recorded for later
AI enrichment (`enrich` jobs); guideline parts without recommendation language get rules only; parts done by rules alone continue
while the run's query budget has room, and each run takes jobs until its budget is nearly used.

## Canonical storage: Drive is the system of record (src/mkos/mirror.js, restore.js)

Google Drive (the MKOS folder) holds the truth; D1 is the execution layer (graph, search, query, cache, learner state, curriculum,
blueprint and asset retrieval) and is rebuildable from Drive. Every run persists the files whose content changed: every knowledge object
(including criteria, objectives, teaching points, targets, pearls and asset records, with confidence, classification, governance and
provenance), every version, the graph in stable buckets, shared educational assets with their content, the blueprint execution tables,
the sources and compatibility registries, change events, audit records, reviews and the reconciliation report, plus `manifest.json`
(every file's id, hash, row count and time) and a daily bundled snapshot. Change detection costs a few grouped queries; a changed
object rewrites only its own files and the manifest. `durability` reports how far Drive is behind; the daily reconciliation records
it. Owner: `restore {mode: verify}` compares the Drive manifest with the database; `restore {mode: restore, confirm: true}` rebuilds
the database from Drive (resumable; never replaces newer data). Learner state and a learner's own material live in that account's
own Drive folder.

## Clinical pearls (decompose.js, decomposition.json "pearls")

Pearls are durable governed assets in the pearl registry (`eo.pe.<concept>.<n>`): generated once by the free AI, pending validation
until the owner validates them (`asset_review ok`) or rejects them (`asset_review regenerate`), classified, versioned, persisted to
Drive and linked to their recommendations, concept, competencies and blueprint topics, then reused by every lesson, question, card,
case, review and tutor answer on the concept. Each pearl keeps the basis it was written from; the daily reconciliation regenerates a
concept's pearls only when that basis moved materially (recommendation, guideline edition, evidence level, objectives, competencies,
relationships), and a learner's flag withholds a pearl until the owner reviews it. Pearls a regeneration no longer yields are superseded.

## Daily reconciliation (src/mkos/reconcile.js)

Once a day, at the Life OS refresh hour (`reconciliation.utc_hour`, 04:00 UTC = midnight New York), MKOS checks and repairs: new and
updated sources (a full library sweep if none finished in a day), guideline families whose supersession contradicts itself, blueprint
registries without mappings, recommendations not yet decomposed and objects not yet classified, relationship drift (edges touching
superseded, retired or missing objects), sources whose extraction went missing, failed jobs (one fresh attempt a day, except those
needing the owner), orphaned derived knowledge, outdated educational assets (flagged for regeneration with the reason), change
events never carried through to impact analysis, and version integrity. A full pass also runs once when MKOS first boots, and
retroactively MKOS decomposes, classifies and imports the owner's reviewed lessons and questions once per decomposition version.
Owner: `reconcile {run: true}` queues a pass now and returns the last report.

## Retiring the legacy guideline registry (`guidelines_registry_v6_CURRENT.json`)

1. **Import everything**: every legacy entry, every field kept verbatim (`data.legacy`), ref_ids unchanged.
2. **Publish the compatibility registry**: same shape the app reads, staged in the MKOS folder as `..._MKOS_STAGED.json`.
3. **Structural parity**: every key and every entry, field for field.
4. **Functional application validation**: the app's own registry reader run on both files, and against the app's cached map.
5. **Citation resolution**: every file id and ref_id in use resolves; AI-written citations are matched to guideline families and
   those naming an older edition are reported for regeneration.
6. **Knowledge graph validation**: no dangling or undeclared edges, no supersession cycles, provenance everywhere.
7. **Historical rollback validation**: the legacy registry is rebuilt from MKOS history and must equal the original exactly.
8. **Retire**: only after 3-7 pass within 24 hours and the owner confirms; the new registry is published as `_CURRENT`, the old one
   moves to Old versions, and `cutover_rollback` reverses it.

## Testing locally

`node tools/mkos/dryrun.mjs --work <dir>` runs the whole engine on node:sqlite (`tools/mkos/d1shim.mjs`) against a library listing
and the registries kept in `<dir>` (outside the repository), then prints the object counts, graph validation, all cutover gates,
families, recommendations, the learner plan and the routing result.
