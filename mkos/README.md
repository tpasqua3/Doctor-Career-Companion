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

Everyone: `status`, `search`, `object/<id>`, `context/<concept id>`, `route?q=`, `learner`, `plan`, `refresh_me`, `framework`.
Owner: `events`, `jobs`, `audit`, `review {id, result, note}`, `edit {object}`, `set_status`, `settings {path, value}` (for example
`ingestion.extraction.daily_ai_budget_default`), `rescan`, `requeue`, `tick`, `graph_validation`, `compat_registry`,
`cutover_validate`, `cutover_retire {confirm: true}`, `cutover_rollback`.

AI extraction calls only free services (Gemini's quick model on the free tier, then Cloudflare Workers AI), directly and under its own
usage account `mkos`: a paid service is never reached, the app's AI hierarchy is unchanged and no learner's allowance is spent. Variables: `MKOS=off` pauses the engine; `MKOS_AI=off` keeps extraction to rules only.

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
