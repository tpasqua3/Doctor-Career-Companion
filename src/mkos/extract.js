// Extraction: source text -> structured knowledge (concepts, recommendations, claims, evidence, relations), deterministic first.
// 1. Text: deps.readText(fileId) (Google Doc export or Workers AI toMarkdown); held in mk_text only while the source is processed.
// 2. Rules: recommendation tables in ACC/AHA form (COR | LOE | Recommendation) and graded statements (KDIGO 1A-2D, USPSTF grade) are
//    parsed by pattern with no AI.
// 3. AI (Minimum Effective AI Dosage): only for chunks rules could not structure, within the daily MKOS budget, returning the
//    extraction contract (mkos/schemas/extraction_result.schema.json). AI output enters as pending_validation, confidence capped.
// 4. applyExtraction writes objects and edges through the object store (versioned, scored, audited) with provenance to the page.
import { FRAMEWORK } from './framework.js';
import { validate } from './validate.js';
import { J, nowIso, getSetting, setSetting, fwGet, overrides } from './db.js';
import { putObject, getObject, slug, norm, contentHash } from './kb.js';
import { addEdges, RELS } from './graph.js';
import { resolveName, AUTO } from './resolve.js';
import { normalizeEvidence, normalizeStrength } from './scoring.js';

const F = FRAMEWORK.frameworks, ING = F.ingestion, O = F.ontology;
const CTYPES = new Set(O.concept_types.map((c) => c.key));
const FACETKEYS = Object.fromEntries(O.facet_model.groups.map((g) => [g.group, new Set(g.facets.map((f) => f.key))]));

export function chunkText(text, { target = ING.extraction.chunking.target_chars, overlap = ING.extraction.chunking.overlap_chars } = {}) {
  const parts = [], t = String(text || '');
  let i = 0;
  while (i < t.length) {
    let end = Math.min(t.length, i + target);
    if (end < t.length) { const h = t.lastIndexOf('\n#', end); const p = t.lastIndexOf('\n\n', end); const cut = h > i + target * 0.5 ? h : p > i + target * 0.5 ? p : end; end = cut; }
    parts.push(t.slice(i, end)); if (end >= t.length) break; i = Math.max(end - overlap, i + 1);
  }
  return parts;
}
// Page markers left by the converters ("Page 12", "<!-- page 12 -->", form feeds) -> page of a character offset.
export function pageAt(text, offset) {
  const before = text.slice(0, offset); let m, page = null; const re = /(?:^|\n)\s*(?:<!--\s*page\s*(\d+)\s*-->|#+\s*page\s*(\d+)|page\s+(\d+)\s*$)/gim;
  while ((m = re.exec(before))) page = Number(m[1] || m[2] || m[3]);
  return page;
}

const COR = /^(1|2a|2b|3:\s*no\s*benefit|3:\s*harm|3\s*\(no benefit\)|3\s*\(harm\)|I|IIa|IIb|III)$/i;
const LOE = /^(A|B-?R|B-?NR|C-?LD|C-?EO|B|C)$/i;
// Deterministic pass over one chunk. Returns {recommendations, sections}.
export function parseRules(chunk) {
  const recs = [], sections = []; let section = '';
  for (const raw of chunk.split('\n')) {
    const line = raw.trim();
    const h = /^#{1,4}\s+(.{3,160})$/.exec(line); if (h) { section = h[1].replace(/\*+/g, '').trim(); sections.push({ title: section }); continue; }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.replace(/\*+/g, '').replace(/<br\s*\/?>/g, ' ').trim());
      if (cells.length >= 3 && COR.test(cells[0]) && LOE.test(cells[1]) && cells.slice(2).join(' ').length > 25) {
        recs.push({ statement: cells.slice(2).join(' ').replace(/\s+/g, ' ').replace(/^\d+\.\s*/, ''), strength_original: cells[0], loe_original: cells[1].toUpperCase().replace(/^B(R|NR)$/, 'B-$1').replace(/^C(LD|EO)$/, 'C-$1'), grading_system: 'ACC_AHA_COR', section, concepts: [] });
        continue;
      }
    }
    // Recommendation rows as plain text (PDF converters often drop table borders): "1 B-R 3. In adults with ...".
    const pl = /^(1|2a|2b|3:\s*(?:no benefit|harm))\s+(A|B-R|B-NR|C-LD|C-EO)\s+(?:\d+\.\s*)?(.{25,})$/i.exec(line);
    if (pl) { recs.push({ statement: pl[3].trim(), strength_original: pl[1], loe_original: pl[2].toUpperCase(), grading_system: 'ACC_AHA_COR', section, concepts: [] }); continue; }
    // KDIGO-style graded statements: "1.2.3: We recommend ... (1B)."
    const k = /^(?:[\d.]+:?\s*)?(We (?:recommend|suggest)[^]*?)\((1|2)([A-D])\)\.?$/.exec(line);
    if (k && k[1].length > 25) recs.push({ statement: k[1].trim(), strength_original: k[2], loe_original: k[2] + k[3], grading_system: 'KDIGO', section, concepts: [] });
  }
  return { recommendations: recs, sections };
}

export const EXTRACT_PROMPT = (src, chunkNo, chunk, known) => `You are the extraction engine of a medical knowledge base. Read this part of a source and return ONLY JSON matching:
{"concepts":[{"name","concept_type","aliases":[]}],"recommendations":[{"statement","strength_original","loe_original","section","page","population","intervention","setting","concepts":[names],"adult_scope":true}],
 "claims":[{"concept","facet_group","facet_key","statement","page"}],"evidence":[{"acronym","evidence_kind","design","result","concepts":[]}],"relations":[{"from","rel","to"}],"sections":[{"title","page","concepts":[]}]}
Rules:
- Paraphrase every statement in your own words (never copy more than 8 consecutive words). Keep numbers, thresholds and drug names exact.
- concept_type is one of: ${[...CTYPES].join(', ')}.
- facet_group/facet_key come from: ${O.facet_model.groups.map((g) => g.group + '[' + g.facets.slice(0, 6).map((f) => f.key).join(',') + (g.facets.length > 6 ? ',...' : '') + ']').join('; ')}.
- rel is one of: ${O.relationships.map((r) => r.key).join(', ')}.
- Copy strength_original and loe_original exactly as the source grades them (e.g. "1", "2a", "B-R", "1B", "Grade B"); empty if ungraded.
- Mark adult_scope false for pediatric-only recommendations.
- Prefer these existing concept names when they fit: ${known.slice(0, 80).join('; ')}.
- Return at most 40 recommendations, 60 claims and 40 concepts. If the text is front matter, references or acknowledgments, return empty lists.
Source: ${src.short_label || src.title} (${src.year || 'n.d.'}), ${src.source_class}${src.copyright === 'licensed_no_verbatim' ? ' — licensed text: index concepts and facts only, no wording' : ''}. Part ${chunkNo + 1}.
---
${chunk}`;

// Load the source's text into mk_text (chunks). deps.readText(fileId) -> string.
export async function loadText(env, deps, src) {
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_text WHERE source_id = ?').bind(src.id).first();
  if (have && have.n) return have.n;
  const text = await deps.readText(src.drive_file_id);
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i += 20) await env.DB.batch(chunks.slice(i, i + 20).map((c, j) => env.DB.prepare('INSERT OR REPLACE INTO mk_text (source_id, chunk, text, done) VALUES (?, ?, ?, 0)').bind(src.id, i + j, c)));
  return chunks.length;
}

async function aiBudgetLeft(env) {
  const day = nowIso().slice(0, 10), used = J(await getSetting(env, 'ai_budget'), {}), cap = Number(fwGet('ingestion.extraction.daily_ai_budget_default', await overrides(env)));
  return { left: cap - (used.day === day ? used.n : 0), spend: async () => setSetting(env, 'ai_budget', JSON.stringify({ day, n: (used.day === day ? used.n : 0) + 1 })) };
}

/* Process the next chunk of a source. Returns {done, chunk, used_ai}. Rules first; AI only when the chunk is substantive, rules found
   nothing, the source's depth calls for it, and budget remains. */
export async function extractStep(env, deps, src, { actor = 'extractor', event_id = null, allowAI = true } = {}) {
  const row = await env.DB.prepare('SELECT chunk, text FROM mk_text WHERE source_id = ? AND done = 0 ORDER BY chunk LIMIT 1').bind(src.id).first();
  if (!row) return { done: true };
  const rules = parseRules(row.text);
  let result = { source_id: src.id, chunk: row.chunk, concepts: [], recommendations: rules.recommendations, claims: [], evidence: [], relations: [], sections: rules.sections };
  let usedAI = false;
  const depth = (F.source_classes.classes.find((c) => c.key === src.source_class) || {}).extraction_depth || 'index_only';
  const pol = ING.extraction.ai_policy || {};
  // Minimum Effective AI Dosage: rules first; AI only where the depth calls for it and rules found nothing.
  const wantsAI = allowAI && deps.ai && depth !== 'none' && row.text.replace(/\s+/g, ' ').length > 1500
    && !(depth === 'recommendations' && rules.recommendations.length)
    && !(depth === 'index_only' && row.chunk >= (pol.index_only_parts || 3));
  // Rule-parsed recommendations get their concepts by alias matching against the ontology (no AI).
  for (const r of rules.recommendations) if (!r.concepts.length) r.concepts = await linkConcepts(env, r.statement);
  if (wantsAI) {
    const b = await aiBudgetLeft(env);
    if (b.left > 0) {
      const known = (await env.DB.prepare("SELECT name FROM mk_objects WHERE type = 'Concept' AND specialty = ? ORDER BY trust DESC LIMIT 80").bind((src.specialty || [])[0] || '').all()).results.map((r) => r.name);
      const reply = await deps.ai(EXTRACT_PROMPT(src, row.chunk, row.text, known));
      await b.spend(); usedAI = true;
      const j = J(String(reply || '').replace(/^```(?:json)?|```$/g, '').trim(), null);
      if (j && typeof j === 'object') {
        const ai = { ...result, ...j, source_id: src.id, chunk: row.chunk };
        // Rules win for recommendation tables; AI recommendations are added when rules found none in this chunk.
        ai.recommendations = rules.recommendations.length ? rules.recommendations : (j.recommendations || []).map((r) => ({ ...r, _ai: true }));
        result = ai; result._ai = true;
      }
    } else return { done: false, waiting: 'ai_budget' };
  }
  const errs = validate(result, FRAMEWORK.schemas['extraction_result.schema.json'], FRAMEWORK.schemas);
  const applied = errs.length ? { skipped: errs.slice(0, 3) } : await applyExtraction(env, src, result, { actor, event_id, method: usedAI ? 'ai_extraction' : 'deterministic_parse' });
  await env.DB.prepare('UPDATE mk_text SET done = 1 WHERE source_id = ? AND chunk = ?').bind(src.id, row.chunk).run();
  // An index-only source (textbook, question bank) is indexed from its first parts; the rest of its text is not mined.
  if (depth === 'index_only' && row.chunk + 1 >= (pol.index_only_parts || 3)) await env.DB.prepare('UPDATE mk_text SET done = 1 WHERE source_id = ?').bind(src.id).run();
  return { done: false, chunk: row.chunk, used_ai: usedAI, applied };
}

// Concepts named in a sentence: every 1-6 word span is looked up in the alias table (one query), longest spans win.
export async function linkConcepts(env, text, max = 6) {
  const w = norm(text).split(' ').filter(Boolean), spans = new Set();
  for (let n = Math.min(6, w.length); n >= 1; n--) for (let i = 0; i + n <= w.length; i++) { const sp = w.slice(i, i + n).join(' '); if (sp.length >= 4 || n > 1) spans.add(sp); }
  const list = [...spans].slice(0, 400); if (!list.length) return [];
  const { results } = await env.DB.prepare(`SELECT a.alias, a.id FROM mk_aliases a JOIN mk_objects o ON o.id = a.id WHERE o.type = 'Concept' AND o.status IN ('current','modified') AND a.alias IN (${list.map(() => '?').join(',')})`).bind(...list).all();
  results.sort((a, b) => b.alias.length - a.alias.length);
  const out = [], used = []; for (const r of results) { if (used.some((u) => u.includes(r.alias))) continue; used.push(r.alias); if (!out.includes(r.id)) out.push(r.id); if (out.length >= max) break; }
  return out;
}

// Resolve a concept name to an id, creating a pending concept when nothing confident matches.
export async function ensureConcept(env, name, type, src, prov, { actor, event_id, aliases = [] } = {}) {
  const ctype = CTYPES.has(type) ? type : 'clinical_finding';
  const r = await resolveName(env, name, { types: ['Concept'] });
  if (r.id && r.confidence >= AUTO) return r.id;
  const id = 'c.' + ctype + '.' + slug(name, 60);
  const old = await getObject(env, id);
  if (old) return id;
  await putObject(env, { id, type: 'Concept', name: String(name).slice(0, 200), canonical_name: String(name).slice(0, 200), concept_type: ctype, aliases: aliases.slice(0, 12),
    specialty: src.specialty || [], status: 'current', governance_status: 'pending_validation', facets: {}, provenance: [prov] }, { actor, event_id, summary: 'concept first seen in ' + (src.short_label || src.title) });
  return id;
}

export async function applyExtraction(env, src, x, { actor = 'extractor', event_id = null, method = 'deterministic_parse' } = {}) {
  const at = nowIso(), base = { source_id: src.id, method, at, agent: actor };
  const prov = (page, section) => ({ ...base, locator: { chunk: x.chunk, ...(page != null ? { page } : {}), ...(section ? { section } : {}) } });
  const ids = {}, edges = [], counts = { concepts: 0, recommendations: 0, claims: 0, evidence: 0, edges: 0 };
  const cid = async (name, type = 'clinical_finding', aliases = []) => {
    const k = norm(name); if (!k) return null;
    if (!ids[k]) { ids[k] = await ensureConcept(env, name, type, src, prov(null, null), { actor, event_id, aliases }); counts.concepts++; }
    return ids[k];
  };
  for (const c of x.concepts || []) await cid(c.name, c.concept_type, c.aliases || []);
  const adultOnly = src.population === 'pediatric';
  for (const r of x.recommendations || []) {
    const statement = String(r.statement || '').replace(/\s+/g, ' ').trim(); if (statement.length < 15) continue;
    const id = 'rec.' + src.id.slice(4, 20) + '.' + (await contentHash({ s: norm(statement) })).slice(0, 10);
    const concepts = []; for (const n of r.concepts || []) { const c = /^c\.[a-z_]+\./.test(n) ? n : await cid(n); if (c) concepts.push(c); }
    const rec = { id, type: 'Recommendation', name: statement.slice(0, 120), specialty: src.specialty || [], status: src.status === 'superseded' ? 'superseded' : 'current',
      governance_status: method === 'ai_extraction' || r._ai ? 'pending_validation' : 'validated', statement, guideline: src.guideline_family || null, source_id: src.id,
      section: r.section || '', page: r.page ?? null, strength_original: r.strength_original || '', strength: normalizeStrength(r.strength_original, r.grading_system),
      loe_original: r.loe_original || '', evidence_level: normalizeEvidence(r.loe_original, r.grading_system), grading_system: r.grading_system || '',
      population: r.population || '', intervention: r.intervention || '', setting: ['outpatient', 'inpatient', 'icu', 'emergency', 'any'].includes(r.setting) ? r.setting : 'unknown',
      adult_scope: r.adult_scope !== false && !adultOnly, concepts, provenance: [prov(r.page, r.section)] };
    await putObject(env, rec, { actor, event_id, srcScores: src.scores, summary: 'from ' + (src.short_label || src.title) });
    counts.recommendations++;
    edges.push({ src: id, rel: 'derived_from', dst: src.id, conf: 95, prov: prov(r.page, r.section) });
    if (src.guideline_family) edges.push({ src: id, rel: 'belongs_to_guideline', dst: src.guideline_family, conf: 90, prov: prov(r.page, r.section) });
    for (const c of concepts) edges.push({ src: c, rel: 'recommended_by', dst: id, conf: 70, prov: prov(r.page, r.section) });
  }
  for (const c of x.claims || []) {
    const g = c.facet_group, k = c.facet_key; if (!FACETKEYS[g] || !FACETKEYS[g].has(k)) continue;
    const id = await cid(c.concept); if (!id) continue;
    const con = await getObject(env, id); if (!con) continue;
    const facets = con.facets || {}; facets[g] = facets[g] || {}; const list = facets[g][k] || [];
    const value = String(c.statement || '').slice(0, 600); if (!value || list.some((it) => norm(it.value) === norm(value))) continue;
    list.push({ value, confidence: method === 'ai_extraction' ? 60 : 75, provenance: [prov(c.page, null)], version: '1', at });
    facets[g][k] = list.slice(-12);
    await putObject(env, { ...con, facets }, { actor, event_id, summary: `facet ${g}.${k} from ${src.short_label || src.title}`, audited: false });
    counts.claims++;
  }
  for (const e of x.evidence || []) {
    if (!e.acronym && !e.design) continue;
    const id = 'ev.' + slug(e.acronym || e.design, 50);
    const concepts = []; for (const n of e.concepts || []) { const c = await cid(n); if (c) concepts.push(c); }
    const old = (await getObject(env, id)) || {};
    await putObject(env, { ...old, id, type: 'EvidenceObject', name: e.acronym || e.design, status: 'current', governance_status: old.governance_status || 'pending_validation',
      evidence_kind: ['landmark_trial', 'supporting_trial', 'negative_trial', 'meta_analysis', 'systematic_review', 'observational', 'registry', 'expert_opinion'].includes(e.evidence_kind) ? e.evidence_kind : 'supporting_trial',
      acronym: e.acronym || '', design: e.design || '', result: e.result || '', concepts: [...new Set([...(old.concepts || []), ...concepts])], provenance: [...(old.provenance || []), prov(null, null)].slice(-10) },
      { actor, event_id, summary: 'evidence cited by ' + (src.short_label || src.title), audited: false });
    counts.evidence++;
    for (const c of concepts) edges.push({ src: c, rel: 'supported_by', dst: id, conf: 60, prov: prov(null, null) });
  }
  for (const r of x.relations || []) {
    if (!RELS[r.rel]) continue; const a = await cid(r.from), b = await cid(r.to);
    if (a && b) edges.push({ src: a, rel: r.rel, dst: b, conf: method === 'ai_extraction' ? 55 : 70, prov: prov(null, null) });
  }
  for (const s of x.sections || []) for (const n of s.concepts || []) { const c = await cid(n); if (c) edges.push({ src: src.id, rel: 'covers', dst: c, conf: 70, prov: prov(s.page, s.title) }); }
  for (const id of Object.values(ids)) edges.push({ src: src.id, rel: 'covers', dst: id, conf: 65, prov: prov(null, null) });
  const g = await addEdges(env, edges); counts.edges = g.added;
  return counts;
}

// When every chunk is done: drop the text (library text is not kept), mark the source extracted.
export async function finishSource(env, src, { actor = 'extractor', event_id = null } = {}) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_text WHERE source_id = ?').bind(src.id).first();
  await env.DB.prepare('DELETE FROM mk_text WHERE source_id = ?').bind(src.id).run();
  const cur = await getObject(env, src.id);
  await putObject(env, { ...cur, ingest_state: 'extracted', ingest_note: `${(n && n.n) || 0} parts processed ${nowIso().slice(0, 10)}` }, { actor, event_id, summary: 'extraction finished', audited: false });
}
