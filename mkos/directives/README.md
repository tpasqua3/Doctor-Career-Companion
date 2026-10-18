# MKOS directives

These are the owner's governing directives, kept verbatim. They run in this order, and each starts only when the one before has
done its job.

| # | Directive | Status |
| --- | --- | --- |
| 1 | Persistence correction, data domain separation, canonical vs operational storage | Done: Drive is the system of record; configuration and central records persist; confirmed queue, ledger and daily check; restore drill passed |
| 2 | Ingestion phase (`2026-10-18-ingestion-phase.txt`) | Running: startup complete 14:07 UTC; library walk and registration complete 16:07 UTC (544 sources: 173 guidelines, 195 MKSAP, 133 textbooks); extraction under way (30.4% overall at 17:43) |
| 2a | Large source governance, confidence scoring, ontology expansion (`2026-10-18-large-source-governance.txt`) | Size routing done: size decides how a source is processed, never whether. Files too large to convert in one piece are indexed from their embedded table of contents (`src/mkos/outline.js`: chapter, section and subsection records with pages, linked to concepts, domains, blueprint topics and curriculum nodes); files with no outline are registered and mapped by title. Chapter references reach topic context, prompts and the topic panel. Still to do, in step 3: MKSAP educational extraction, the deterministic confidence components, and nested graph generation |
| 3 | Knowledge asset optimization (`2026-10-18-knowledge-asset-optimization.txt`) | After 2 has registered and extracted the sources: per-category source audit, educational sources layer (MKSAP mapped, textbooks index-only), object and graph expansion |
| 4 | Backend-to-frontend penetration audit (`2026-10-18-penetration-audit.txt`) | After ingestion, indexing, mapping and curriculum generation: inventory, frontend, retrieval, source, object, curriculum and AI utilization audits, plus a stress test |
| 5 | Audit remediation (`2026-10-18-audit-remediation.txt`) | After 4: fix what it found, validate, then set up recurring regression audits |

None of these may change the AI order of operations (`CLAUDE.md`). Textbooks stay index-only, and no library content goes into
this repository.
