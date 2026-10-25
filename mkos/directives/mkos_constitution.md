# The MKOS Constitution

Adopted 2026-10-24 from the owner's *MKOS Continuous Knowledge Lifecycle Specification* and its *Constitutional Addendum*
(roadmap Phase 3.1). These rules bind every current and future part of MKOS: the engine (`src/mkos`), the ontology and frameworks
(`mkos/ontology`), the schemas and every feature that reads or writes knowledge. A change that cannot meet them is redesigned before
it is built. The machine-readable form of the lifecycle is `mkos/ontology/lifecycle.json`. It is enforced by `src/mkos/lifecycle.js`
and `src/mkos/relevance.js`.

> **MKOS exists to model medicine as a living, evolving body of knowledge rather than to model any particular educational product,
> examination, specialty, institution, AI model, or curriculum.**

## Article 1. Corpus first

1. MKOS models medicine. It does not model exams, lessons or curricula. Everything else is generated from medicine.
2. The order of the system is **Medicine → Knowledge Graph → Objectives → Exams → Lessons → Mastery**. It is never Board Exam → Content.
3. When a design is weighed, ask whether it would still work if the corpus doubled, every specialty board were added, medical school
   curricula or patient education were added, or 20 years of guidelines arrived. If not, redesign it before building it.

## Article 2. Canonical objects

1. Every knowledge object exists independently of exams, objectives, lessons, questions, curricula and educational products.
2. Those systems may reference an object. None of them may own it.
3. Knowledge objects are permanent. Educational representations are temporary.
4. Nothing is deleted. Knowledge is superseded or retired, and its history is kept (`mk_versions`, the supersession model).

## Article 3. Projections

1. Every educational or clinical experience is a projection of the corpus. That includes ABIM certification, LKA, the subspecialty
   boards, resident and student curricula, pathways, clinician reference and patient education. None of them is the source of truth.
2. **Exam mappings are not ontology mappings.** An exam relates to knowledge only through objectives:
   knowledge object → objective graph → exam graph.
3. An exam's relevance for an object is computed from the objective graph and the exam's blueprint weights. It is never stored per
   exam, and it is never written into a knowledge object's body.
4. A future exam needs its blueprint and nothing else. The corpus is never remapped for it.

## Article 4. Infinite reuse

A knowledge object may take part, at the same time and without duplication, in many objectives, lessons, exams, curricula,
specialties and educational levels. Knowledge is stored once and rendered without limit.

## Article 5. Educational independence

Lessons, questions, curricula and mastery systems are generated views of knowledge. Knowledge is the primary asset. A future
educational innovation consumes the corpus without redesigning it.

## Article 6. Specialty independence

No specialty is primary. The framework supports Primary Care, Internal Medicine, Cardiology, Endocrinology, Nephrology, Pulmonary,
Critical Care, Neurology, Rheumatology, Infectious Disease, Hematology, Oncology, Pediatrics, OB/GYN, Psychiatry, Dermatology,
Ophthalmology, Urology and future specialties, without any change to the ontology framework. Specialty and exam facts live in
framework data (specialties, blueprints), never in code.

## Article 7. Source independence

Sources contribute evidence. They do not define architecture. MKSAP, ADA, KDIGO, ACC, ACP, ASH, IDSA, NCCN and every future source are
contributors, not foundational dependencies. MKOS must stay viable if any one source is removed. Not all sources weigh the same:
confidence emerges from the evidence and authority hierarchy (provenance-weighted truth).

## Article 8. No knowledge asset may stop at ingestion

Every source entering MKOS completes one workflow. The stages are not independent tasks. Each source carries a lifecycle record
(`mk_lifecycle`) of the stage it has reached:

| # | Stage (`lifecycle.json`) | Spec stage | What must hold |
|---|---|---|---|
| 1 | `ingested` | Source ingestion | The source is registered, classified and read (or indexed, or mapped by title). Its Metadata Object is complete: organization, publication and version dates, specialty domain, source type, review date, supersession, evidence strength system, and referenced sources. |
| 2 | `knowledge_objects` | Source ingestion | Its recommendations, evidence, claims, objectives, teaching points and sections exist, and its decomposition has finished. |
| 3 | `ontology_mapped` | Ontology mapping | Every concept it touches is mapped to the eleven classes (disease, syndrome, procedure, diagnostic, medication, risk factor, complication, biomarker, preventive, population, educational) as graph edges. |
| 4 | `relevance_mapped` | Objective graph | Its objects are in the weighted relevance graph: many exam-independent objectives, each with a score and band. |
| 5 | `exam_projected` | Exam mapping | Its objects are projected onto every current blueprint. |
| 6 | `lesson_penetration` | Lesson penetration | The affected objectives, lessons, curricula and exams are known, with a lesson penetration score. |
| 7 | `curriculum_penetration` | Lesson and curriculum penetration | The curricula it reaches are updated. |
| 8 | `confidence` | Confidence recalculation | Evidence confidence, relevance confidence and lesson confidence are recalculated as separate domains. |
| 9 | `gaps` | Coverage and gap analysis | The coverage and gap maps include it. |

Every stage has its engine (step 1, 2026-10-24: stages 1-5; step 2, 2026-10-25: stages 6-9 in `impact.js`, `enrich.js`, `layers.js`,
`confidence.js` and `coverage.js`), so a source that passes them all is `complete`. A stage added later whose engine does not exist yet
is recorded as `pending_engine`. It is never skipped. Storage is not success. Utilization
is success: knowledge must be extracted, mapped, linked, used and audited.

## Article 9. No binary mapping

1. Knowledge is never mapped to only one objective. Objectives are never mapped to only one exam. Lessons are never generated from
   only one source.
2. Relevance is graded: 0.00 not relevant, 0.10 remote, 0.25 peripheral, 0.50 supporting, 0.70 adjacent core, 0.85 high,
   0.95 directly tested, 1.00 foundational.
3. Scores come from deterministic rules over graph paths and relation types (`lifecycle.json` relevance). Thresholds prune what is
   irrelevant. A small fan-out cap never decides what is relevant.

## Article 10. Lessons are enriched, not rebuilt

New recommendations, evidence, citations, pearls, trial lineage, teaching points and cross-links are added to lessons as
enhancements. Lesson version history is preserved, and nothing is regenerated unnecessarily. A lesson is weighted into a required
core, adjacent knowledge, advanced expansion and a frontier layer, so board preparation and deep academic learning use the same corpus.

## Article 11. Lineage, verifiability, many perspectives

1. Every educational statement must be traceable as lesson → knowledge object → recommendation → guideline → evidence → source.
   Any statement can answer "why do you believe this?".
2. When authorities disagree (USPSTF, ACS and ACOG; ACC and ESC), all of their recommendations are kept. Disagreement is represented,
   not hidden.

## Article 12. Independence of layers, and of AI

1. Corpus, ontology, knowledge objects, objectives, lessons, questions, mastery, the interface and the AI models are each
   replaceable without redesigning the others.
2. AI output is never stored as truth. Knowledge persists. Lessons, questions, explanations and cases are presentations that a later
   model may regenerate.
3. Lifecycle stages are rules-based. They add no AI calls and never change the AI order of operations or MKOS's AI budget (`CLAUDE.md`).

## Article 13. Self-awareness and lifelong learning

1. MKOS knows what it knows, partly knows and does not know. It produces coverage, confidence, gap and freshness maps automatically,
   and it tracks utilization density (objects created against objects used).
2. It optimizes for medical school, residency, fellowship, attending practice, academic teaching and lifelong maintenance. Board
   objectives are one projection layer, not the mission.

## Operating rules that follow from it

- Drive is the system of record. Durable lifecycle state is mirrored and restored (`registries/lifecycle.json`). Derived state (the
  relevance graph) is rebuilt from objects, edges and the rule table.
- Derived state is updated only when reality changes: write paths mark what changed (relevance dirty flags), engines recompute only
  that and write only rows whose values differ. There is no periodic full rewrite.
- Lessons are enhanced, never regenerated in bulk; an asset's basis fingerprint changes only when it is regenerated.
- New scores live in new tables or volatile fields. They are never written into versioned object bodies, so no mass rewrite or
  regeneration happens.
- Nothing extracted from the library enters the repository. The repository holds code, the framework and synthetic test fixtures only.
