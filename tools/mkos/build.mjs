// MKOS build: validate the framework (ontology, frameworks, schemas) and bundle it for the Worker.
//
//   node tools/mkos/build.mjs          validate, then write src/mkos/framework.js and mkos/build/report.json
//   node tools/mkos/build.mjs --check  validate only (exit 1 on any error)
//
// The repository holds the framework only: ontology, frameworks and schemas. Knowledge itself (sources, concepts,
// recommendations, evidence, educational objects, learner state) is ingested continuously and lives in D1, mirrored to
// the owner's Drive MKOS folder. Nothing extracted from a licensed or copyrighted source is ever written to this repository.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../src/mkos/validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MK = join(ROOT, "mkos"), CHECK = process.argv.includes("--check");
const errors = [], warnings = [];
const err = (w, m) => errors.push(`${w}: ${m}`), warn = (w, m) => warnings.push(`${w}: ${m}`);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { err(f, "invalid JSON: " + e.message); return null; } };

const fw = {}; for (const f of readdirSync(join(MK, "ontology")).sort()) if (f.endsWith(".json")) fw[f.slice(0, -5)] = readJson(join(MK, "ontology", f));
const schemas = {}; for (const f of readdirSync(join(MK, "schemas")).sort()) if (f.endsWith(".json")) schemas[f] = readJson(join(MK, "schemas", f));
const O = fw.ontology;
for (const name of ["ontology", "specialties", "source_classes", "scoring", "competencies", "ingestion", "pronunciation", "blueprints", "assets", "decomposition"]) if (!fw[name]) err("mkos/ontology", `missing ${name}.json`);

// Every framework file carries the version envelope.
for (const [k, v] of Object.entries(fw)) for (const f of ["id", "version", "status", "created_date", "updated_date", "change_log"]) if (!(f in v)) err(`ontology/${k}.json`, `missing ${f}`);
// Schemas: every $ref resolves.
const refs = (s, out = []) => { if (s && typeof s === "object") { if (s.$ref) out.push(s.$ref); Object.values(s).forEach((v) => refs(v, out)); } return out; };
for (const [f, s] of Object.entries(schemas)) for (const r of refs(s)) if (!schemas[r.replace(/^.*\//, "")]) err(`schemas/${f}`, `$ref ${r} does not resolve`);
// Ontology internal consistency.
const uniq = (list, key, where) => { const seen = new Set(); for (const x of list) { if (seen.has(x[key])) err(where, `duplicate ${key} ${x[key]}`); seen.add(x[key]); } return seen; };
const relKeys = uniq([...O.relationships, ...O.structural_relationships], "key", "ontology.relationships");
for (const r of O.relationships) if (!relKeys.has(r.inverse) && !O.relationships.some((x) => x.inverse === r.key)) {/* inverse names are read-side labels */}
const ctypes = uniq(O.concept_types, "key", "ontology.concept_types");
for (const g of O.facet_model.groups) uniq(g.facets, "key", `facet group ${g.group}`);
const groups = new Set(O.facet_model.groups.map((g) => g.group));
for (const c of O.concept_types) for (const g of c.expected_facet_groups) if (!groups.has(g)) err("ontology.concept_types", `${c.key} expects unknown facet group ${g}`);
uniq(O.object_types, "type", "ontology.object_types"); uniq(O.object_types, "prefix", "ontology.object_types");
for (const t of O.object_types) if (!schemas[t.schema]) err("ontology.object_types", `${t.type} schema ${t.schema} missing`);
uniq(fw.specialties.specialties, "id", "specialties");
const aliases = new Map(); for (const s of fw.specialties.specialties) for (const a of s.folder_aliases) { const k = a.toLowerCase(); if (aliases.has(k) && aliases.get(k) !== s.id) err("specialties", `folder alias "${a}" maps to ${aliases.get(k)} and ${s.id}`); aliases.set(k, s.id); }
uniq(fw.source_classes.classes, "key", "source_classes");
for (const c of fw.source_classes.classes) {
  if (!O.authority_hierarchy.includes(c.authority_tier)) err("source_classes", `${c.key}: authority_tier ${c.authority_tier} not in ontology.authority_hierarchy`);
  if (!O.source_types.includes(c.spec_source_type)) err("source_classes", `${c.key}: ${c.spec_source_type} not in ontology.source_types`);
  if (!fw.source_classes.extraction_depths[c.extraction_depth]) err("source_classes", `${c.key}: unknown extraction_depth ${c.extraction_depth}`);
}
const tw = Object.values(fw.scoring.trust_weights).reduce((a, b) => a + b, 0); if (Math.abs(tw - 1) > 1e-9) err("scoring.trust_weights", `sum to ${tw}, expected 1`);
const cw = Object.values(fw.scoring.learner.curriculum_priority_weights).reduce((a, b) => a + b, 0); if (Math.abs(cw - 1) > 1e-9) err("scoring.learner.curriculum_priority_weights", `sum to ${cw}`);
const levels = new Set(O.evidence_model.levels.map((l) => l.key));
for (const [sys, map] of Object.entries(fw.scoring.evidence_crosswalk)) if (typeof map === "object") for (const [k, v] of Object.entries(map)) if (!levels.has(v)) err("scoring.evidence_crosswalk", `${sys}.${k} -> ${v} is not an evidence level`);
const comps = new Set(fw.competencies.competencies.map((c) => c.id));
for (const [k, v] of Object.entries(fw.competencies.facet_to_competency)) { if (!groups.has(k)) err("competencies.facet_to_competency", `unknown facet group ${k}`); if (!comps.has(v)) err("competencies.facet_to_competency", `unknown competency ${v}`); }
for (const [k, list] of Object.entries(fw.competencies.task_type_map)) for (const v of list) if (!comps.has(v)) err("competencies.task_type_map", `${k}: unknown ${v}`);

// The Continuous Knowledge Lifecycle (lifecycle.json): stages, classes, relevance rules and exam data refer only to declared things.
{
  const L = fw.lifecycle;
  if (!L) err("mkos/ontology", "missing lifecycle.json");
  else {
    uniq(L.stages, "key", "lifecycle.stages"); uniq(L.concept_classes, "key", "lifecycle.concept_classes");
    if (L.concept_classes.length !== 11) err("lifecycle.concept_classes", `the spec maps to 11 classes, found ${L.concept_classes.length}`);
    for (const c of L.concept_classes) { for (const t of c.concept_types || []) if (!ctypes.has(t)) err("lifecycle.concept_classes", `${c.key}: unknown concept type ${t}`);
      for (const r of c.as_source_of || []) if (!relKeys.has(r)) err("lifecycle.concept_classes", `${c.key}: undeclared relationship ${r}`);
      for (const p of c.name_patterns || []) { try { new RegExp(p, "i"); } catch (e) { err("lifecycle.concept_classes", `${c.key}: bad pattern ${p}`); } } }
    const typed = new Set(L.concept_classes.flatMap((c) => c.concept_types || []));
    for (const t of ctypes) if (!typed.has(t) && !["guideline", "recommendation", "evidence_object"].includes(t)) warn("lifecycle.concept_classes", `concept type ${t} has no class by type`);
    const R = L.relevance;
    for (const r of [...Object.keys(R.hops), ...R.attachments.map((a) => a.rel), R.via_recommendation.rel, L.objectives.anchor_relation, L.objectives.projection_relation, ...L.non_propagating_relations]) if (!relKeys.has(r)) err("lifecycle.relevance", `undeclared relationship ${r}`);
    if (Object.keys(R.hops).length > 15) err("lifecycle.relevance.hops", "at most 15 hop relations (D1 bound-parameter budget)");
    for (const w of [...Object.values(R.hops), ...R.attachments.map((a) => a.factor), R.via_recommendation.factor, R.min_score]) if (!(w > 0 && w <= 1)) err("lifecycle.relevance", `weight ${w} outside (0, 1]`);
    const bv = R.bands.map((b) => b.value); if (JSON.stringify(bv) !== JSON.stringify([0, 0.1, 0.25, 0.5, 0.7, 0.85, 0.95, 1])) err("lifecycle.relevance.bands", "bands must be the spec's 0, 0.10, 0.25, 0.50, 0.70, 0.85, 0.95, 1.00");
    for (const t of R.object_types) if (!O.object_types.some((x) => x.type === t) && t !== "SourceSection") err("lifecycle.relevance.object_types", `unknown type ${t}`);
  }
  const keys = new Set(fw.source_classes.classes.map((c) => c.key));
  for (const r of (fw.source_classes.classification_rules || {}).rules || []) {
    if (!keys.has(r.class)) err("source_classes.classification_rules", `unknown class ${r.class}`);
    for (const k of r.refines) if (!keys.has(k)) err("source_classes.classification_rules", `${r.class} refines unknown class ${k}`);
    for (const p of [...(r.title_patterns || []), ...(r.title_patterns_cs || []), ...(r.path_patterns || [])]) { try { new RegExp(p); } catch (e) { err("source_classes.classification_rules", `${r.class}: bad pattern ${p}`); } }
  }
  const ek = new Set(); for (const f of fw.blueprints.families) if (f.exam_key) { if (ek.has(f.exam_key)) err("blueprints.families", `duplicate exam_key ${f.exam_key}`); ek.add(f.exam_key); }
  for (const f of fw.blueprints.families) if (f.counterpart && !ek.has(f.counterpart.exam_key)) err("blueprints.families", `${f.id}: counterpart ${f.counterpart.exam_key} is no exam_key`);
}

// Self-test: a minimal object of each envelope-based schema validates; a broken one does not.
const now = new Date().toISOString(), prov = [{ source_id: "src.selftest", method: "derived", at: now }];
const base = { version: "1.0.0", status: "current", governance_status: "validated", created: now, updated: now, provenance: prov };
const samples = {
  "concept.schema.json": { ...base, id: "c.disease.heart_failure", type: "Concept", name: "Heart failure", concept_type: "disease", canonical_name: "Heart failure" },
  "recommendation.schema.json": { ...base, id: "rec.selftest.1", type: "Recommendation", name: "r", statement: "Use a statin in adults with established ASCVD.", source_id: "src.selftest", strength: "strong", evidence_level: "A" },
  "source.schema.json": { ...base, id: "src.selftest", type: "Source", name: "s", source_class: "clinical_practice_guideline", drive_file_id: "x", title: "t", population: "adult", copyright: "publisher_copyright_paraphrase", ingest_state: "registered" },
};
for (const [f, obj] of Object.entries(samples)) { const e = validate(obj, schemas[f], schemas); if (e.length) err(`selftest ${f}`, JSON.stringify(e)); }
if (!validate({ ...samples["recommendation.schema.json"], strength: "maybe" }, schemas["recommendation.schema.json"], schemas).length) err("selftest", "invalid recommendation passed validation");

// The app's curriculum tracks, read from app/companion.html so curriculum nodes keep the app's own topic ids.
let appCurriculum = [];
{
  const html = readFileSync(join(ROOT, "app/companion.html"), "utf8"), m = /const TRACKS=(\[[\s\S]*?\]\}\]\}\]);\nconst SEC=/.exec(html);
  if (!m) err("app/companion.html", "TRACKS not found (curriculum nodes need it)");
  else { try { appCurriculum = Function('"use strict";return (' + m[1] + ');')().map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, sections: t.sections.map((s) => ({ id: s.id, name: s.name, w: s.w, lib: s.lib || [], src: s.src || "", topics: s.topics })) })); }
    catch (e) { err("app/companion.html", "TRACKS could not be read: " + e.message); } }
}

const report = { built: now, errors: errors.length, warnings, counts: {
  app_curriculum_topics: appCurriculum.reduce((a, t) => a + t.sections.reduce((b, s) => b + s.topics.length, 0), 0),
  facet_groups: O.facet_model.groups.length, facets: O.facet_model.groups.reduce((a, g) => a + g.facets.length, 0), concept_types: O.concept_types.length,
  relationships: O.relationships.length, structural_relationships: O.structural_relationships.length, object_types: O.object_types.length, schemas: Object.keys(schemas).length,
  specialties: fw.specialties.specialties.length, source_classes: fw.source_classes.classes.length, competencies: fw.competencies.competencies.length,
  layers: O.layers.length, stop_the_line_conditions: O.stop_the_line_conditions.length } };
for (const e of errors) console.error("ERROR " + e);
for (const w of warnings) console.warn("warn  " + w);
console.log(`MKOS framework: ${errors.length} errors, ${warnings.length} warnings`, report.counts);
if (errors.length) process.exit(1);
if (!CHECK) {
  const versions = Object.fromEntries(Object.entries(fw).map(([k, v]) => [k, v.version]));
  const payload = JSON.stringify({ frameworks: fw, schemas, versions, app_curriculum: appCurriculum });
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  writeFileSync(join(ROOT, "src/mkos/framework.js"), `// Generated by tools/mkos/build.mjs. Do not edit: change mkos/ontology or mkos/schemas and rebuild.\nexport const FRAMEWORK_HASH = ${JSON.stringify(hash)};\nexport const FRAMEWORK = ${payload};\n`);
  mkdirSync(join(MK, "build"), { recursive: true });
  writeFileSync(join(MK, "build/report.json"), JSON.stringify({ ...report, framework_hash: hash, versions }, null, 2) + "\n");
  console.log("wrote src/mkos/framework.js", hash);
}
