# MKOS: the Medical Knowledge Operating System

The knowledge backend of Doctor Career Companion, built from the *MKOS V3 Canonical Architecture Specification*, the *Knowledge
Currency and Continuous Evolution Principle* and the *Universal Confidence, Uncertainty and Trust Model* (Medical Training App Push,
week of 10/17/2026), following the *MKOS Implementation Directive*.

**The MKOS Constitution** (`mkos/directives/mkos_constitution.md`) binds everything here. MKOS models medicine, and exams, lessons and
curricula are projections of it. Knowledge objects are canonical and owned by no educational product. No specialty or source is
primary. Nothing is mapped to only one objective. No knowledge asset may stop at ingestion: every source goes through the ten-stage
Continuous Knowledge Lifecycle (below).

MKOS turns the documents in the library (guidelines, MKSAP, textbooks, blueprints) into versioned, scored, provenance-carrying
knowledge objects in a graph. The app teaches from that structure. AI is the last layer: it may teach, explain and generate
educational assets, but it never creates authority.

## What lives where

| Tier | Where | What |
|---|---|---|
| Framework (this repo) | `mkos/ontology/*.json`, `mkos/schemas/*.json` | The ontology (21 concept types, 26 facet groups / 252 facets, 16 spec relationships + 19 structural ones, evidence levels, authority hierarchy, versioning, difficulty, competency, learner, confidence, routing, stop-the-line), the specialty taxonomy, source classes, scoring numbers, competencies, the ingestion pipeline, the Continuous Knowledge Lifecycle (`lifecycle.json`), and 26 JSON Schemas. `node tools/mkos/build.mjs` validates it and writes `src/mkos/framework.js`. |
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
| `impact.js` | Automatic impact analysis and learner-state reconciliation; rescoring of affected objects only; lesson and curriculum penetration (stage 5) |
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
| `genjobs.js` | The generation queue: lessons as jobs bound to one model, background and batch writing, objective seeding, ITE-to-objective mapping (`ite_map`: legacy wording match, or with `items` the per-discipline shortlist the app's AI chooses from) |
| `objmap.js` | Objective mapping: as many knowledge objects as possible mapped to the ABIM CERT and LKA objectives |
| `curstore.js` | The Dynamic Board Objective Curriculum in Drive: one file per objective, by exam and discipline |
| `lifecycle.js`, `lifecycle_state.js` | The Continuous Knowledge Lifecycle orchestrator and the per-source lifecycle record (below) |
| `relevance.js`, `dirty.js` | The weighted relevance graph, canonical objectives and the exam projection; the dirty-flag queue that keeps it current (below) |
| `enrich.js` | Dynamic lesson enrichment: enhancements instead of regeneration (stage 6) |
| `layers.js` | Lesson content weighting: required core, adjacent, advanced, frontier (stage 7) |
| `confidence.js` | The three confidence domains: evidence, relevance, lesson (stage 8) |
| `coverage.js` | The coverage engine and gap detection (stages 9-10) |
| `wording.js` | Prompt wording from the learner's or blueprint's family (specialty independence) |
| `ite.js`, `ite_marks.js` | ITE -> blueprint objective mapping v2: the central mapping library, the account's ITE performance records, the pipeline trace and its audit (below) |
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

Everyone: `status`, `lifecycle`, `relevance`, `exam_relevance`, `penetration`, `layers`, `confidence`, `coverage`, `gaps`, `enhancements`, `lesson_view`, `knowledge_map`, `specialty_proposals`, `search`, `object/<id>`, `context/<concept id>`, `route?q=`, `learner`, `plan`, `refresh_me`, `framework`,
`app_bundle`, `topic_context`, `check_citations`, `asset_flags`, `asset_find`, `asset_put`, `asset_flag`, `asset_stats`, `blueprints`,
`board-review`, `select_blueprint`, `pronunciation`.
Owner: `specialty_review {id, result: approve | merge | reject, into}`, `events`, `jobs`, `audit`, `review {id, result, note}`, `edit {object}`, `set_status`, `settings {path, value}` (for example
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

**Configuration and central records.** `config/configuration.json` holds every setting that is not run state: the AI order of
operations (as built and as the owner adjusted it, with the model variables), framework overrides (`fw:*`), engine, ingestion,
cutover and persistence settings, and the site's own pages. New settings persist by default; credentials (the Google connection,
API keys) never do. `central/` holds the central registry records that belong to no account (Data Domain Separation): the
pronunciation registry and its change log with their daily copies, and the ABIM blueprint document the curriculum was built from.
In the database they live under the reserved holder `_central`; the owner edits them in the app exactly as before (the worker
resolves his copy of `med/says`, `med/saylog` and `bak/says-*` to the central one), everyone else's list stays in their account, and
deleting an account never touches them. The shared sources registry reaches the app from MKOS (`app_bundle.registry`), so accounts
cache only entries for files MKOS does not know. Restore and the drill bring both back and compare them.

**Pending persistence (sync requirement).** A changed file is queued the first time its fingerprint moves and stays pending until
Drive itself confirms the write (the size and MD5 Drive reports for the upload must match what was sent). Refused or unconfirmed
writes are recorded and retried by every run; a configuration or central-record change is also persisted straight away
(`persistNow`). The ledger (`mk_persist_log`, and `governance/persistence_<month>.json` in Drive) records queued, persisted, failed,
retried and reconciled states; owner op `persistence` lists it, `durability` reports pending files and the oldest pending age.

**Daily verification.** The reconciliation's canonical step checks that Drive exists (every folder listed, every file the database
believes is there found, missing ones rewritten), is current (manifest read back, nothing pending over an hour, else a
`persistence_overdue` event) and matches the database (object files by row count, configuration and central records by content
hash); differing files are rewritten and logged as reconciled.

Governing directives are kept in `mkos/directives/`.

## Large sources (src/mkos/outline.js)

Size decides how a source is processed, never whether. A PDF or Office file over 25 MB, too large to convert to text in one piece
inside the Worker, is indexed from its embedded table of contents. The PDF outline is parsed from a few byte ranges of the file,
never the whole file. It covers classic and stream cross-references, compressed object streams and named destinations. Each item
becomes a `SourceSection` (chapter, section or subsection, with its page), `part_of` its parent. It is linked through the alias
index to the concepts, domains, blueprint topics and curriculum nodes its heading names. Only headings and page numbers are kept.
The source becomes `indexed` (method `pdf_outline`), or `title_only` with the reason when the file has no outline. Topic context
returns these as `knowledge.references`, which the prompt cites by source and chapter and the topic panel lists under "In the
library". Owner op `outline_probe {file_id, size}` reads a file's outline without indexing it.

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

## The Continuous Knowledge Lifecycle (src/mkos/lifecycle.js, relevance.js, mkos/ontology/lifecycle.json)

Every source has a lifecycle record (`mk_lifecycle`: `source_id`, `stage`, `stages_json`, `status`, `cycle`). A new or changed source
enters it from the scanner (`ingest.js registerFile`). Sources that existed before enter once, by backfill. A changed source starts a
new cycle, and earlier cycles are kept in the record's history. The orchestrator runs in each engine run after the queued jobs, within
the run's query budget (at most `orchestrator.budget_share_max` of it), and every unit is resumable. Status: `waiting` (not read
yet), `in_progress`, `blocked` (extraction failed), `pending_engine` (every built stage done; the rest wait for their engines),
`complete`, `retired`. The `status` operation shows the counts, `lifecycle {id}` shows one record, `relevance {id}` shows an object's
objectives and exam projections, and `exam_relevance {ids, family}` shows the projection for one exam. Variable `lifecycle=off` in
`mk_settings` pauses it.

| Stage | Engine (rules only) |
|---|---|
| `ingested` | The source has been read, indexed or mapped by title. Its Metadata Object is computed, a refined class is applied if one exists, and `cites` edges are added. |
| `knowledge_objects` | Counts of what it produced, once its extraction and decomposition jobs are finished. |
| `ontology_mapped` | Its concepts carry `classified_as` edges to the eleven ConceptClass nodes (`cls.*`). |
| `relevance_mapped` | Canonical objectives for its concepts; done once nothing it touches is still in the relevance dirty queue. |
| `exam_projected` | Projection edges, and its recommendations' relevance on every current blueprint. |
| `lesson_penetration` | `impact.js computePenetration`: the objectives, lessons, curricula, board curricula and exams it reaches, each scored; the change event's `impact` carries it. Lessons it reaches at `enrichment.min_penetration` are enhanced (`enrich.js`). |
| `curriculum_penetration` | The curriculum nodes and blueprint topics it reaches; the content layers of the objectives it reaches are recomputed. |
| `confidence` | Evidence and relevance confidence of its objects; lesson confidence of the lessons it reaches. |
| `gaps` | Done once a coverage and gap run has followed its confidence stage. A source then reaches `complete`. |

Global passes do the bulk for the existing corpus, and each restarts daily for what is new: concept classes, canonical objectives and
projection edges (every run, so a new blueprint projects at once).

**Relevance is event driven** (`src/mkos/dirty.js`, `relevance.js processDirty`; owner principle: determine once, store the result,
update only when reality changes). There is no periodic sweep. The write paths mark what changed in `mk_relevance_dirty` with one
small insert: `kb.js putObject` when a relevance object or source is created or changes status, type or excluded governance (a
canonical objective marks its anchor concept), `graph.js addEdges` for hop, attachment and `derived_from` edges, and `kb.js setStatus`
through putObject (a superseded or retired source, concept or recommendation). The table is also the frontier: a seed (`radius` >= 0)
marks its neighbours with one radius less (concepts over the hop relations, any edge status, up to `max_hops`; a hop edge marks both
ends with `max_hops - 1`; sources and recommendations mark what is derived from them) and becomes `-1` (recompute). Each run then
recomputes dirty concepts, marks the objects attached to concepts whose rows changed, and recomputes those objects once no concept is
dirty. Every recompute compares the rows it computes with the stored ones: new pairs are inserted, rows whose score, band or basis
differ are updated (the upsert repeats the check in its `WHERE`), pairs no longer produced are deleted, unchanged rows are not written,
and the flag is cleared. `computed_v` is `relevance.rules_version`, stamped when a row last changed. Bumping `rules_version`, a restore
(`lc_rel` is run state) or the first run marks every object once (a resumable backfill). A read-only audit pass runs every
`relevance.dirty.audit_hours` (720) when nothing is dirty: it recomputes rows in memory, compares, and marks only what drifted.

**Lesson and curriculum penetration** (stage 5, `impact.js`, `lifecycle.json penetration`). For a subject (a changed knowledge object,
or a source over its recommendations and what derives from them): an objective's score is the subject's best relevance to it; a
lesson's is the best over its objectives (the canonical objectives of the concepts it teaches, and those its blueprint objective
projects onto); a curriculum node's the best over the concepts it covers; a blueprint topic's the best over the objectives it projects
onto; an exam's the best over its topics of objective score x topic priority / 100. Below 0.25 is pruned; at most 200 per kind are
kept. Stored in `mk_penetration`, rewritten only where a score changed. It is computed from change events, never by scanning: the
relevance queue records each subject whose rows changed (`mk_penetration_queue`, a source aggregating its recommendations), the
lifecycle stage computes it for a source, and `analyzeImpact` computes it for the subject of every change event (`impact.penetration`).
Operation `penetration {id | target}`.

**Dynamic lesson enrichment** (stage 6, `enrich.js`). A lesson a subject reaches at 0.7 or more gets what is new since it was written:
recommendations on its concepts (created after it and not in its basis), the evidence and trial lineage supporting them, the citation of a
guideline family it did not have, and validated pearls. Each is recorded once in `mk_enhancements` with the asset version it produced; the
asset gets a new minor version (1.4.0 -> 1.5.0) and a content row in `mk_asset_store` carrying the enhancements (version history kept).
The basis fingerprint is never touched; an `enrichment` summary on the asset lets `judge()` count what was absorbed: a new guideline
family an enhancement cites, and recommendations added as enhancements towards `coverage_expanded`. Before regenerating for one of
those two reasons, the asset is enriched and judged again (`judgeLesson`). Every other reason (edition changed or superseded, a
recommendation changed, flagged, unvalidated, blueprint weighting, objectives, competencies or relationships) still regenerates. Nothing
is ever regenerated in bulk. Operations `enhancements {asset}`, `lesson_view {asset}`.

**Lesson content weighting** (stage 7, `layers.js`). Per canonical objective, each related object falls in one layer, first match:
advanced (evidence objects, landmark trials; objects of another specialty; high relevance with confidence below 0.5), core (relevance
0.85+, confidence 0.7+), adjacent (0.5+), frontier (down to 0.1). Plans are in `mk_layers` (written on change). Seeded lesson prompts
get the plan as a layered outline appended to their MKOS block (structure only; with no plan the prompt is exactly as before).
Operation `layers {asset | objective}`.

**Confidence engine** (stage 8, `confidence.js`). Three domains in `mk_confidence`, 0..1 to two decimals with their factors, written on
change: evidence (evidence level or study design 0.4, source class authority 0.3, agreement of distinct current sources on the same
concepts 0.15, recency 0.15), relevance (strongest relevance 0.5, strong paths 0.3, on an exam 0.2), lesson (source count 0.2,
coverage of current recommendations 0.25, evidence support 0.2, objective support 0.15, update recency 0.2). `mk_objects.conf` and
`trust` keep their meaning. Operation `confidence {id}`.

**Coverage and gaps** (stages 9-10, `coverage.js`). A daily snapshot (`mk_coverage`, 30 days kept; again, at most four runs a day, while
sources wait at the gaps stage) of specialty, objective, exam, evidence, source, lesson and knowledge-penetration coverage
(numerator, denominator, pct). `knowledge_penetration_pct` (current knowledge objects related at 0.7+ to an objective a lesson or
curriculum node reaches) is sent to USAP. Gap rules (`lifecycle.json gaps`): objective, exam and specialty gaps recommend an
acquisition (guideline class, the organizations that already publish in that specialty); lesson gaps a lesson; evidence gaps the trials;
update gaps a source past its review date, an old guideline or a superseded source still cited by lessons; confidence gaps a low lesson
confidence. Operations `coverage`, `gaps {kind}`, `knowledge_map` (the Knowledge tab).

A rotating write-on-diff pass over layers and confidence runs weekly (`derived.pass_hours`), so time-dependent factors age.

**Specialty independence.** The taxonomy includes Primary Care, Pediatrics and a separate Critical Care Medicine. An unknown top-level
library folder becomes a proposed specialty (status `modified`, `proposed`), listed with its sources and never assigned until the owner
approves, merges or rejects it (`specialty_review`); approved folders then resolve. Generation prompts take their wording from the
learner's or blueprint's family (`blueprints.json wording`, `wording.js`); the ABIM internal medicine families carry the earlier text, so
their prompts are byte-identical.

**Source Metadata Object.** `source_metadata` is a typed sub-object of the Source (`source.schema.json`). It holds the source
organization, publication date, version date, review date (from the owner registry or a "reaffirmed/reviewed" title), specialty
domain, source type and class, superseded-by, the evidence strength system (the grading system of most of its recommendations, with
the full list), and referenced sources. Referenced sources are the trial acronyms in its recommendations that MKOS already holds as
EvidenceObjects, also linked as `cites` edges. It is derived, so it is in `kb.js VOLATILE` like scores and classification. It is
written in place, makes no new version and no `mk_versions` row, and leaves the content hash unchanged. On Drive it rewrites only the
`registry_data/Source/*` files once, not the history files. A change to the source's content version recomputes it.

**Source classes.** `government_guidance`, `landmark_trial`, `systematic_review` and `meta_analysis` are recognised by the
`classification_rules` of `source_classes.json` (title and folder patterns). A rule applies only when it refines the base class: it
is more specific, as when a research article becomes a landmark trial, or a guideline becomes government guidance. An
already-classified source is reclassified only by such a refinement. Owner-registry sources are never reclassified. Every
reclassification is logged (audit `source_reclassified`).

**Stage 2 classes.** Disease, syndrome, procedure, diagnostic, medication, risk factor and biomarker come from the 21 concept types.
Four classes come from rules over the existing types and relations:

- complication: a name pattern, or the source of a `complicates` edge;
- preventive: a name pattern, or recommended by a preventive or immunization source;
- population: a name pattern;
- educational: an anatomical or physiologic concept, or the anchor of a curriculum node or blueprint topic.

Impact reach never follows `classified_as` (`non_propagating_relations`).

**Canonical objectives.** `obj.c.<concept id without "c.">` (type Objective, `objective_type: canonical`, `anchored_on` the concept).
There is one per objective-worthy concept: it anchors a blueprint topic or curriculum node, or has at least three current
recommendations. The id is derived from the concept, so it is stable and exam-independent, and any number of blueprints can project
onto the same objective. An exam-scoped id such as `bpt.<exam>.<code>` cannot do that. Each BlueprintTopic `projects_objective` onto
the canonical objectives of the concepts its blueprint concept mapping names. That gives the chain knowledge object → objective graph
→ exam graph.

**The relevance rule table** (`lifecycle.json` relevance; deterministic, no AI):

| Path from the object to an objective's anchor concept | Score |
|---|---|
| the concept itself | 1.00 foundational |
| attached directly: a recommendation (`recommended_by`), an objective or educational object that `teaches` or `assesses` it | x 0.95 |
| derived from such a recommendation (claims, objectives, teaching points: `derived_from`) | x 0.90 |
| `covers` (educational objects, source sections), `supported_by` (evidence) | x 0.85 |
| each hop between concepts: `is_a`, `part_of` | x 0.85 |
| `treats`, `diagnoses`, `causes`, `complicates`, `predisposes_to`, `contraindicates` | x 0.70 |
| `evaluates`, `measures`, `contributes_to`, `requires`, `prerequisite_of`, `associated_with` | x 0.50 |
| `related_to` | x 0.25 |

The score is the best path of at most two hops. The band is the spec band nearest the score. Scores below 0.10 are pruned. There is
no small fan-out cap; `max_per_object` (400) is only a safety ceiling for the run budget.

**Exam projection.** An exam's relevance for an object is max over the object's objectives of (relevance x topic priority / 100),
over the topics of that exam's current blueprint that project onto the objective. It is computed on read (`examProjection`, the view
`mk_exam_relevance`) and never stored per exam. Exam data comes from the blueprint registry data (`blueprints.json` families:
`exam_key`, `blueprint_name`, `registry_find`, `curriculum_folder`, `counterpart`). A registry for an exam not listed there names its
own `blueprint_family`, `board_name` and `board_type`. `importBlueprint`, `projectBlueprint`, the bootstrap and the board objective
curriculum read the family from that data, so a future exam needs only its blueprint and ABIM behaves exactly as before.
`importBlueprint` no longer writes `board.*` into concepts. Weights, tiers and task ratings stay on the BlueprintTopic and in the
blueprint tables, and `learner.js` and the concept context read them there, falling back to the old fields of concepts written
before.

**Durable or derived.** Durable, so mirrored (`registries/lifecycle.json`, `registries/enhancements.json`) and restored: `mk_lifecycle`,
`mk_enhancements` (lesson version history, not derivable), the canonical objectives,
the ConceptClass nodes, and the `classified_as`, `anchored_on`, `projects_objective` and `cites` edges (with the graph). Derived, so
not mirrored and rebuilt by the backfill after a restore: `mk_relevance`, `mk_relevance_dirty` and `mk_relevance_marks` (now only the
concept class marks), and `mk_penetration`, `mk_penetration_queue`, `mk_layers`, `mk_confidence`, `mk_coverage` and `mk_gaps`, rebuilt by
their passes. Gaps are derived on purpose: each is a function of objects, edges, blueprints, coverage and confidence; the owner acts by
adding or replacing a source, which closes the gap on the next run, and no owner state is kept on a gap. The lifecycle's cursors
(`lc_*` settings) are run state.

## ITE -> blueprint objective mapping v2 (src/mkos/ite.js, blueprints.json ite_mapping)

From the owner's *MKOS ITE -> ABIM Mapping Architecture v2* (roadmap Phase 3.2). Four layers, kept apart:

| Layer | Where | What |
|---|---|---|
| Knowledge (central) | `mk_ite_map` (D1), Drive `registries/ite_mapping.json` | ITE wording -> blueprint objective(s), per blueprint family: `mapping_id`, `blueprint` (family id from the blueprint data, e.g. `abim_im_cert`, `abim_im_lka`), `exam_key`, `source_text`, `norm` (normalized wording), `objective_id` and `objective_ids` (the BlueprintTopics; empty = "no blueprint objective"), `canonical_objective` and `canonical_ids` (the `obj.c.*` objectives the topic `projects_objective` onto), `discipline`, `confidence` (0..1), `method`, `verified`, `version`, `confirmations`, `last_confirmed` (a day). One row per wording, blueprint and objective set. No user id, report id or anything else about who confirmed it. |
| Performance (per account) | `med/iteperf` (the account's records, so its own Drive folder) | `user_ite_performance`: one record per confirmed missed item and objective: `report_id`, `item`, `objective_id`, `blueprint`, `exam_key`, `status` (missed, mastered), `source` ITE, `confirmed`, `archived`, `date`, and display fields. Written by the server only (`ite_confirm`, the migration). |
| Content | the shared lesson assets | An eligible objective reuses its lesson (`asset_find`, `objective_lesson`) or gets its pass-1 lesson queued once through the seed queue (`genjobs.js queueObjectiveSeeds`: shared, central, paced by `seed.reserve_calls` and `seed_paused`). |
| Observability (per account) | `med/itetrace`; `mk_ite_watch`, `mk_ite_dirty`, `mk_ite_audit` (D1) | `objective_trace`: every missed item's steps (mapped, confirmed, stored, eligible, queued, generated), its stage, the reason the next step has not happened, and since when. |

**Pipeline.** Extraction (the page): the raw report text (`med/iteraw`), content areas and missed items (`med/ite`), stored in the
account. Mapping, in order: the physician's own confirmed mapping (`med/itemap`) -> central exact match (normalized wording, same
blueprint) -> central fuzzy match (trigram similarity >= `fuzzy_min`, 0.90) -> the discipline shortlist (`shortlist_size`, 10, plus
`shortlist_extra` from other disciplines; the whole discipline only with `whole_discipline`) and one batched AI call for what is left,
through the page's own "report" job (label `doctor_companion_app.ite_objective_map`; the AI order is untouched; library answers are
recorded as deterministic) -> the physician's review (Confirm, change the objective, or None). Nothing reaches planning until it is
confirmed. A confirmation (`ite_confirm`) strengthens the central mapping (mapping only; a retried confirmation counts once) and
replaces that item's records for that blueprint in the account. A new report archives the older reports' records.

**Eligibility.** `isEligible(record) = confirmed && !archived` (status missed), and for a blueprint's board queue the record must belong
to that blueprint. It never depends on a lesson. The page's planner reads the same records (`itePerfView`, `iteMissed`, `missedMapped`;
`itePerfFor` in the page and `recordsForItem` here derive them by the same rules, and a test runs both). Records of another blueprint are
never used silently: the board card says where the mappings are and offers to map the report again.

**Trace and audit (change driven).** The trace is recomputed on each transition and written only when it changed: the page asks
(`ite_trace`, with its current report) after it maps, confirms or queues; a job queued, finished, failed or cancelled for an objective,
and a lesson stored for one, mark the accounts whose trace waits on it (`ite_marks.js`, `mk_ite_watch` -> `mk_ite_dirty`), and each engine
run recomputes up to `tick_users_per_run` of them. Audit invariant: every missed item must trace Report -> Item -> Mapping -> Confirmation
-> Weakness -> Eligibility -> Queue -> Lesson; an item waiting on one step longer than `stall_hours[step]` is an audit failure, shown on
the owner's ITE pipeline audit panel (Progress tab). `ite_audit` (owner) adds the cross-account counts (no account ids, no item text).
The app's USAP profile has no metric for this, so none is sent; wanted: `ite_pipeline_stalled_items`, `ite_pipeline_trace_complete_ratio`.

**Migration** (`ensureMigrated`, once per account, idempotent): the account's confirmed mappings (`med/itemap`) become central mappings
(method `migrated`) and its reviewed missed items become performance records derived exactly as the planner read them, in one batch with
the account's marker `med/itemig`. The page runs it on its first visit; the engine sweeps accounts nobody opens. Logged as audit
`ite_migrate` with counts only.

Operations: `ite_map {family, items, central: true}`, `ite_confirm {items}`, `ite_trace {family, snapshot}`, `ite_migrate`; owner `ite_audit`.

**Durable or derived.** Durable: `mk_ite_map` (mirrored and restored; never replacing a newer row), and the account records `med/iteperf`,
`med/itetrace`, `med/itemig`, `med/iteraw` (in the account's own Drive folder with its other records). Derived or run state:
`mk_ite_watch`, `mk_ite_dirty`, `mk_ite_audit` (rebuilt whenever a trace is computed) and `mk_ite_seen` (retry tokens, 30 days).

## Testing locally

`node tools/mkos/dryrun.mjs --work <dir>` runs the whole engine on node:sqlite (`tools/mkos/d1shim.mjs`) against a library listing
and the registries kept in `<dir>` (outside the repository), then prints the object counts, graph validation, all cutover gates,
families, recommendations, the learner plan, the routing result and the lifecycle counts. `node --test test/*.mjs` runs the unit
tests (`test/mkos_lifecycle.test.mjs` and `test/mkos_ite.test.mjs` use synthetic fixtures only).

## The generation queue (src/mkos/genjobs.js, assets.json generation_queue)

A lesson is a job bound to the writing model chosen when it is queued, from start to finish (runAI `strict`: no handoff part-way).
A model the server can run writes on the server (each 5-minute run, plus `gen_pump` while a page is open), so it keeps writing with the
page closed, waits for the next UTC day when the model's allowance is used, and continues from the step it reached. Claude without a
server key (`ANTHROPIC_API_KEY`) writes in the page: it checkpoints each part (`gen_page`), pauses when the page goes away and resumes on
return or with Resume. A finished server lesson is written to the account (`med/les_<id>`) for the app to file (`gen_filed`), and stored as
an MKOS asset with its generation metadata (model, model version, prompt and template versions, time, objective, blueprint, runner, job,
pass, reviewer). Operations: `gen_models`, `gen_add`, `gen_batch`, `gen_list`, `gen_get`, `gen_resume`, `gen_cancel`, `gen_page`,
`gen_filed`, `gen_pump`, `ite_map`; owner `seed_start`, `seed_pause`, `seed_retry`; everyone `seed_status`.

**Objective seeding**: one foundational pass-1 lesson (about 2,000 words) per ABIM blueprint objective (CERT, plus LKA-only), highest
priority first, leaving `seed.reserve_calls` of the writing model's daily allowance for the owner's own study until `seed.release_hours` before the daily reset (then the unused remainder goes to seeding); quality before speed;
the queue persists until every objective is seeded. Later passes deepen them (2: depth; 3: advanced material, pearls, edge cases, updates).

## Confidence tiers (assets.json confidence)

Every asset's `asset_confidence.overall` puts it in a tier: **durable** (85+, served first, retrieved with no AI), **provisional** (70-84,
served, marked, re-verified at each retrieval), **review** (50-69, not served to others, queued for the owner), **quarantine** (<50, never
served). Scores are recomputed when stored, at every retrieval and in the daily reconciliation. A topic with no current lesson is served a
servable objective lesson on one of its blueprint objectives instead of writing one (`objective_lesson`, `objective_lessons`).

## Objective mapping and the Dynamic Board Objective Curriculum (objmap.js, curstore.js)

Knowledge objects that map to a dynamic board exam objective are kept, durably, in Drive under Medical Knowledge Database / Dynamic Board
Objective Curriculum / ABIM CERT or LKA / <blueprint discipline> / <code> <objective>.json (an objective on both exams in both folders):
the objective, its knowledge objects and edges, and every lesson on it with content, tier and generation metadata. A file is rewritten
only when its content changes and counts only when Drive confirms it (`mk_curfiles`). Objects that do not map stay under the original
ontology (the MKOS folder). The mapping pass (daily, no AI) maps as many objects as possible: recommendations through the concepts they
recommend, claims, teaching points, objectives and pearls through the recommendation they derive from, educational objects and source
sections through the concepts they cover, concepts through mapped neighbours, then names. The library scan skips this folder.
Operations: `objective_mapping_status`, `curriculum_status`; owner `objective_mapping_run`, `curriculum_sync`.
