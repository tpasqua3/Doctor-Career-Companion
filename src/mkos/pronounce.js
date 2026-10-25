// The MKOS Pronunciation Registry: one governed, versioned, confidence-scored record per term, inherited by every voice.
//
// Authority: the owner's central list (med/says, edited in the app's Pronunciation test) stays the admin store. Every entry in it is
// mirrored here as an admin-locked, approved record; words confirmed "right as written" (med/saylog asis) likewise. Approving or
// writing a pronunciation through MKOS writes it into that same list, so there is one admin source and the app keeps working as is.
// System-generated candidates (free AI services, taught by the owner's confirmed respellings) enter as unvalidated, low-confidence
// records: they feed the review queue and are never spoken until confirmed (pronunciation.tts_use.min_overall_confidence).
// Propagation: the server's single respelling step reads the account's list, then the owner's list, then ttsList() below.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, fwGet, overrides, audit } from './db.js';
import { getObject, putObject, slug, norm } from './kb.js';
import { addEdges } from './graph.js';
import { event } from './ingest.js';

const P = FRAMEWORK.frameworks.pronunciation;
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));
export const pronId = (term) => 'pron.' + slug(term, 70);
const keyOf = (w) => String(w || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function band(score) { for (const t of P.thresholds) if (score >= t.min) return t.band; return 'very_low'; }
export function overall(c) { let t = 0; for (const [k, w] of Object.entries(P.overall_weights)) t += (c[k] ?? 0) * w; return clamp(t); }

// Confidence for a record from its source, the owner's acceptance history and its validation state.
function confidence(source, { aiConf = null, calib = 0.8, validated = false, ageDays = 0 } = {}) {
  const s = P.sources[source] || P.sources.ai_generated;
  const c = { pronunciation_confidence: aiConf == null ? s.pronunciation_confidence : clamp(Math.min(aiConf, 90) * calib), source_confidence: s.source_confidence,
    tts_confidence: source === 'owner_asis' ? 95 : 85, validation_confidence: validated ? 100 : s.validation_confidence, admin_confidence: s.admin_confidence,
    freshness_score: clamp(100 * Math.pow(0.5, ageDays / 730)) };
  c.trust_score = clamp((c.source_confidence + c.validation_confidence + c.admin_confidence) / 3);
  c.overall_pronunciation_confidence = overall(c);
  return c;
}

async function speakMin(env) { return Number(fwGet('pronunciation.tts_use.min_overall_confidence', await overrides(env))) || 95; }

async function linkConcept(env, term) {
  const r = await env.DB.prepare("SELECT a.id FROM mk_aliases a JOIN mk_objects o ON o.id = a.id WHERE a.alias = ? AND o.type = 'Concept' LIMIT 1").bind(norm(term)).first();
  return r ? r.id : null;
}

// Create or update one record. Admin-locked records are never overwritten by a system source (candidates are attached instead).
export async function upsertPron(env, { term, simplified, source, ipa = '', aiConf = null, calib = 0.8, actor = 'pronunciation', event_id = null, candidates = null, history = null, stats = null, status = null }) {
  const id = pronId(term), old = (await getObject(env, id)) || null, min = await speakMin(env);
  const systemSource = source === 'ai_generated' || source === 'owner_unconfirmed';
  if (old && old.management === 'admin_locked' && systemSource) {
    const cands = [...(old.candidates || []), ...(candidates || [{ simplified, ipa, confidence: aiConf, source, at: nowIso() }])].slice(-10);
    return putObject(env, { ...old, candidates: cands }, { actor, event_id, summary: 'candidate attached (record is admin locked)', audited: false });
  }
  const s = P.sources[source] || P.sources.ai_generated, conf = confidence(source, { aiConf, calib });
  const b = band(conf.overall_pronunciation_confidence), locked = s.management === 'admin_locked';
  const validation = status || (locked ? 'approved' : b === 'high' ? 'approved' : b === 'medium' ? 'monitoring' : b === 'low' ? 'flagged' : 'unvalidated');
  const rec = {
    ...(old || {}), id, type: 'Pronunciation', name: term, term: keyOf(term), display_name: old?.display_name || term, concept: old?.concept ?? (await linkConcept(env, term)),
    simplified, standardized: simplified, ipa: ipa || old?.ipa || '',
    ssml: ipa ? `<phoneme alphabet="ipa" ph="${esc(ipa)}">${esc(term)}</phoneme>` : `<sub alias="${esc(simplified)}">${esc(term)}</sub>`,
    alternatives: old?.alternatives || [], audio_ref: old?.audio_ref || '', source, management: s.management, validation_status: validation, band: b,
    speak: validation !== 'rejected' && (locked || conf.overall_pronunciation_confidence >= min), pron_confidence: conf,
    candidates: candidates || old?.candidates || [], correction_history: [...(old?.correction_history || []), ...(history ? [history] : [])].slice(-30),
    review_history: old?.review_history || [], stats: { ...(old?.stats || {}), ...(stats || {}) }, last_validated: locked ? nowIso().slice(0, 10) : old?.last_validated || '',
    specialty: old?.specialty || [], status: 'current', governance_status: locked ? 'approved' : 'pending_validation',
    provenance: [{ source_id: source.startsWith('owner') || source === 'admin_custom' ? 'src.owner_pronunciation_list' : 'src.ai_pronunciation', method: source.startsWith('owner') ? 'legacy_app_data' : source === 'admin_custom' ? 'owner_edit' : 'ai_extraction', at: nowIso(), note: (s.note || '').slice(0, 120) }],
  };
  const r = await putObject(env, rec, { actor, event_id, summary: old ? `pronunciation ${old.simplified !== simplified ? 'changed' : 'updated'} (${source})` : `pronunciation added (${source})`, audited: false });
  if (rec.concept && !old?.concept) await addEdges(env, [{ src: rec.concept, rel: 'has_pronunciation', dst: id, conf: 90, prov: rec.provenance[0] }]);
  if (old && old.simplified !== simplified) ttsCache = { t: 0, v: [] };
  return r;
}

/* Mirror the owner's list and confirmations into the registry. Only words whose entry changed since the last sync are written
   (diffed against mk_settings 'pron_sync'), so a long list costs nothing when unchanged. prog makes it resumable. */
export async function syncOwner(env, deps, { prog = {} } = {}) {
  const docs = await deps.ownerDocs(['med/says', 'med/saylog']);
  const list = (docs['med/says'] && docs['med/says'].list) || [], log = docs['med/saylog'] || {};
  const learn = Array.isArray(log.learn) ? log.learn : [], asis = new Set((log.asis || []).map(keyOf));
  const ok = learn.filter((x) => x.r === 'ok').length, calib = learn.length >= 20 ? Math.max(0.5, Math.min(0.98, ok / learn.length)) : 0.8;
  const stat = {}; for (const x of learn) { const k = keyOf(x.w); stat[k] = stat[k] || { suggestions: 0, accepted_suggestion: 0, overridden: 0, as_written: 0 }; stat[k].suggestions++; if (x.r === 'ok') stat[k].accepted_suggestion++; else if (x.r === 'edit') stat[k].overridden++; else stat[k].as_written++; }
  const want = {};
  for (const x of list) { const w = keyOf(x && x.w); if (!w || !x.s) continue; if (!want[w]) want[w] = { s: String(x.s).trim().slice(0, 120), src: x.on === false ? 'owner_unconfirmed' : 'owner_list' }; }
  for (const w of asis) if (!want[w]) want[w] = { s: w, src: 'owner_asis' };
  const last = J(await getSetting(env, 'pron_sync'), {}) || {}, sig = (v) => v.src + '|' + v.s;
  const changed = Object.keys(want).filter((w) => last[w] !== sig(want[w])), removed = Object.keys(last).filter((w) => !want[w]);
  const out = { changed: changed.length, removed: removed.length, written: 0, calibration: calib };
  await setSetting(env, 'pron_learning', JSON.stringify({ calibration: calib, suggestions: learn.length, accepted: ok, overridden: learn.filter((x) => x.r === 'edit').length, as_written: learn.filter((x) => x.r === 'asis').length, owner_entries: list.length, confirmed_as_written: asis.size, at: nowIso() }));
  try {
    for (const w of changed) {
      const prev = last[w] ? last[w].split('|').slice(1).join('|') : null;
      await upsertPron(env, { term: w, simplified: want[w].s, source: want[w].src, calib, stats: stat[w] || null, history: prev && prev !== want[w].s ? { from: prev, to: want[w].s, at: nowIso(), by: 'owner (app list)' } : null });
      last[w] = sig(want[w]); out.written++;
    }
    for (const w of removed) {
      const rec = await getObject(env, pronId(w));
      if (rec && rec.source !== 'ai_generated') await putObject(env, { ...rec, validation_status: 'rejected', speak: false, management: 'system_managed', correction_history: [...(rec.correction_history || []), { from: rec.simplified, to: null, at: nowIso(), by: 'owner removed it from the list' }].slice(-30) }, { actor: 'pronunciation', summary: 'removed from the owner list', audited: false });
      delete last[w]; ttsCache = { t: 0, v: [] };
    }
  } finally { await setSetting(env, 'pron_sync', JSON.stringify(last)); }
  return out;
}

// The entries every voice inherits from MKOS (after the account's and the owner's lists). Cached for a minute.
let ttsCache = { t: 0, v: [] };
export async function ttsList(env) {
  if (Date.now() - ttsCache.t < 60000) return ttsCache.v;
  try {
    const { results } = await env.DB.prepare("SELECT json_extract(body, '$.term') AS w, json_extract(body, '$.simplified') AS s FROM mk_objects WHERE type = 'Pronunciation' AND status = 'current' AND json_extract(body, '$.speak') = 1 AND json_extract(body, '$.source') NOT IN ('owner_list', 'owner_asis') LIMIT 20000").all();
    ttsCache = { t: Date.now(), v: results.filter((r) => r.w && r.s && r.w !== r.s).map((r) => ({ w: r.w, s: r.s })) };
  } catch { ttsCache = { t: Date.now(), v: [] }; }
  return ttsCache.v;
}

// Candidate generation (Minimum Effective AI Dosage: the owner's list answers first; AI only for terms it does not cover).
export const CANDIDATE_PROMPT = (terms, examples) => `You write pronunciation respellings that a plain-text speech engine reads correctly. For each medical term give up to 3 candidates, best first.
A respelling is hyphenated syllables with the stressed syllable in capitals (like "sak-YOO-bi-tril"); also give IPA and your confidence 0-100.
Learn the style from these respellings the listener confirmed:
${examples.map((e) => `${e.w} -> ${e.s}`).join('\n')}
Return ONLY JSON: {"terms":[{"term":"...","candidates":[{"simplified":"...","ipa":"...","confidence":0}]}]}
Terms: ${terms.join('; ')}`;

async function examplesFor(env, deps, terms) {
  const docs = await deps.ownerDocs(['med/says']), list = ((docs['med/says'] || {}).list || []).filter((x) => x && x.on !== false && x.s && x.w);
  const score = (x) => Math.max(...terms.map((t) => { const a = keyOf(t), b = keyOf(x.w); let p = 0; while (p < a.length && a[p] === b[p]) p++; let q = 0; while (q < a.length && a[a.length - 1 - q] === b[b.length - 1 - q]) q++; return Math.max(p, q); }));
  return list.map((x) => ({ x, n: score(x) })).sort((a, b) => b.n - a.n).slice(0, P.generation.examples).map((e) => ({ w: e.x.w, s: e.x.s }));
}

export async function generateCandidates(env, deps, terms, { actor = 'pronunciation', event_id = null, flagged = false } = {}) {
  if (!deps.ai || !terms.length) return { generated: 0 };
  const L = J(await getSetting(env, 'pron_learning'), {}) || {}, calib = L.calibration || 0.8;
  const reply = await deps.ai(CANDIDATE_PROMPT(terms, await examplesFor(env, deps, terms)), { action: 'mkos_pronounce' });
  const j = J(String(reply || '').replace(/^```(?:json)?|```$/g, '').trim(), null); let n = 0;
  for (const t of (j && j.terms) || []) {
    const cands = (t.candidates || []).filter((c) => c && c.simplified).slice(0, 3).map((c) => ({ simplified: String(c.simplified).slice(0, 120), ipa: String(c.ipa || '').slice(0, 160), confidence: clamp(Number(c.confidence) || 50) * calib, source: 'ai_generated', at: nowIso() }));
    if (!cands.length || !t.term) continue;
    const best = cands[0];
    await upsertPron(env, { term: t.term, simplified: best.simplified, ipa: best.ipa, source: 'ai_generated', aiConf: Number(best.confidence) / calib, calib, candidates: cands, actor, event_id, status: flagged ? 'flagged' : null });
    n++;
  }
  return { generated: n };
}

// Terms worth a pronunciation: medications, eponyms and long technical names among current concepts that have no record yet.
export async function termsNeedingPronunciation(env, limit = 10) {
  const { results } = await env.DB.prepare(`SELECT o.name FROM mk_objects o WHERE o.type = 'Concept' AND o.status = 'current'
    AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = o.id AND e.rel = 'has_pronunciation')
    AND (json_extract(o.body, '$.concept_type') = 'medication' OR length(o.name) >= 12) ORDER BY o.trust DESC LIMIT ?`).bind(limit * 4).all();
  // One word per term: the longest technical word (respellings are per word or short phrase).
  const words = new Set();
  // Words a speech engine is likely to misread: drug stems, Greek/Latin roots and eponym-like spellings, not ordinary English.
  const LIKELY = /(mab|nib|pril|sartan|olol|statin|azole|cillin|mycin|floxacin|tide|gliptin|flozin|parin|xaban|gatran|tidine|prazole|dronate|caine|vir|thiazide|semide|dipine|osis|itis|emia|ectomy|plasia|trophy|pathy|algia|ph|rrh|ae|oe|y[a-z]{2}|x[aeiou]|ch[aeiou]|ps|pn|gn)/i;
  for (const r of results) for (const w of String(r.name).split(/[\s,/()-]+/)) if (w.length >= 7 && /^[a-z]+$/i.test(w) && LIKELY.test(w) && !/^(syndrome|disease|disorders?|infections?|insufficiency|management|pregnancy|including|occupational|chronic|physical|hypertension|diabetes)$/i.test(w)) words.add(w.toLowerCase());
  const out = [];
  for (const w of words) { if (out.length >= limit) break; if (!(await getObject(env, pronId(w)))) out.push(w); }
  return out;
}

// ---- Admin workflow (Mark Pronunciation Incorrect -> candidates -> approve / custom / lock)
export async function flag(env, deps, term, { user = 'owner', source_system = 'app' } = {}) {
  const id = pronId(term), rec = await getObject(env, id);
  const ev = await event(env, 'pronunciation_review', id, { term, previous: rec ? rec.simplified : null, confidence: rec ? rec.pron_confidence?.overall_pronunciation_confidence : null, tts: rec ? rec.ssml : null, validation: rec ? rec.validation_status : null, source_system, user });
  const review = { at: nowIso(), by: user, action: 'marked incorrect', previous: rec ? rec.simplified : null, source_system, event_id: ev };
  if (rec) await putObject(env, { ...rec, validation_status: 'flagged', review_history: [...(rec.review_history || []), review].slice(-30), stats: { ...(rec.stats || {}), flags: ((rec.stats || {}).flags || 0) + 1 } }, { actor: user, event_id: ev, summary: 'marked incorrect', audited: false });
  let gen = { generated: 0 };
  try { gen = await generateCandidates(env, deps, [term], { actor: user, event_id: ev, flagged: true }); } catch (e) { gen = { error: String(e.message || e) }; }
  const after = await getObject(env, id);
  await audit(env, user, 'pronunciation_flag', id, rec?.version, after?.version, { term, source_system });
  return { event_id: ev, record: after, candidates: (after && after.candidates) || [], generation: gen };
}

/* Approve a candidate (index) or a custom pronunciation; lock (default) makes it authoritative. Writes the owner's list, which is the
   admin store, so the app shows it and every voice uses it on the next request. */
export async function approve(env, deps, term, { index = null, simplified = null, ipa = '', lock = true, user = 'owner' } = {}) {
  const id = pronId(term), rec = await getObject(env, id);
  const cand = index != null && rec && rec.candidates ? rec.candidates[Number(index)] : null;
  const s = String(simplified || (cand && cand.simplified) || '').trim(); if (!s) return { ok: false, error: 'Give a candidate index or a pronunciation.' };
  if (lock) await deps.ownerSay([{ o: 'put', x: { w: keyOf(term), s, on: true } }]);
  const stats = { ...(rec?.stats || {}), corrections: ((rec?.stats || {}).corrections || 0) + 1, ...(cand ? { accepted_suggestion: ((rec?.stats || {}).accepted_suggestion || 0) + 1 } : { overrides: ((rec?.stats || {}).overrides || 0) + 1 }) };
  const r = await upsertPron(env, { term, simplified: s, ipa: ipa || (cand && cand.ipa) || '', source: lock ? 'admin_custom' : 'ai_generated', aiConf: lock ? null : 90, user, stats, candidates: [],
    history: { from: rec ? rec.simplified : null, to: s, at: nowIso(), by: user, how: cand ? 'approved candidate ' + index : 'custom' }, status: lock ? 'approved' : 'monitoring' });
  const last = J(await getSetting(env, 'pron_sync'), {}) || {}; if (lock) { last[keyOf(term)] = 'owner_list|' + s; await setSetting(env, 'pron_sync', JSON.stringify(last)); }
  ttsCache = { t: 0, v: [] };
  await audit(env, user, 'pronunciation_approve', id, rec?.version, r.version, { term, simplified: s, locked: lock });
  return { ok: true, record: await getObject(env, id) };
}
export async function rejectCandidate(env, term, index, { user = 'owner' } = {}) {
  const rec = await getObject(env, pronId(term)); if (!rec) return { ok: false, error: 'not found' };
  const cands = (rec.candidates || []).filter((_, i) => i !== Number(index));
  return putObject(env, { ...rec, candidates: cands, stats: { ...(rec.stats || {}), rejections: ((rec.stats || {}).rejections || 0) + 1 } }, { actor: user, summary: 'candidate rejected', audited: false });
}

// PRONUNCIATION GOVERNANCE DASHBOARD.
export async function dashboard(env, { limit = 25 } = {}) {
  const q = async (where, order = 'updated DESC') => (await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'Pronunciation' AND ${where} ORDER BY ${order} LIMIT ?`).bind(limit).all()).results.map((r) => { const o = J(r.body); return { term: o.term, simplified: o.simplified, ipa: o.ipa, confidence: o.pron_confidence?.overall_pronunciation_confidence, band: o.band, status: o.validation_status, management: o.management, source: o.source, speak: o.speak, candidates: (o.candidates || []).length, flags: o.stats?.flags || 0, corrections: o.stats?.corrections || 0 }; });
  const counts = (await env.DB.prepare("SELECT json_extract(body, '$.band') AS band, json_extract(body, '$.validation_status') AS vstatus, json_extract(body, '$.management') AS mgmt, COUNT(*) AS n FROM mk_objects WHERE type = 'Pronunciation' GROUP BY band, vstatus, mgmt").all()).results;
  return {
    counts, learning: J(await getSetting(env, 'pron_learning'), {}), tts_min_confidence: await speakMin(env),
    high_confidence: await q("json_extract(body, '$.band') = 'high'"), medium_confidence: await q("json_extract(body, '$.band') = 'medium'"), low_confidence: await q("json_extract(body, '$.band') IN ('low','very_low')"),
    recently_corrected: await q("json_array_length(json_extract(body, '$.correction_history')) > 0"),
    frequently_corrected: await q("COALESCE(json_extract(body, '$.stats.corrections'), 0) + COALESCE(json_extract(body, '$.stats.overridden'), 0) > 1", "COALESCE(json_extract(body, '$.stats.corrections'), 0) + COALESCE(json_extract(body, '$.stats.overridden'), 0) DESC"),
    unvalidated: await q("json_extract(body, '$.validation_status') = 'unvalidated'"), flagged: await q("json_extract(body, '$.validation_status') = 'flagged'"),
    admin_locked: await q("json_extract(body, '$.management') = 'admin_locked'"),
    requiring_review: await q("json_extract(body, '$.validation_status') IN ('flagged','unvalidated') OR (json_extract(body, '$.management') = 'admin_locked' AND json_array_length(json_extract(body, '$.candidates')) > 0)"),
  };
}
