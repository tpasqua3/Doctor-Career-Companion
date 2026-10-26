// The Knowledge Layer object store: put/get with versioning, supersession, aliases and audit.
// Every write goes through putObject, so every object is schema-checked, scored, versioned and audited the same way.
import { FRAMEWORK } from './framework.js';
import { validate } from './validate.js';
import { J, nowIso, audit, overrides } from './db.js';
import { scoreSource, scoreDerived, knowledgeConfidence } from './scoring.js';
import { seedsForObject, dirtyStmts } from './dirty.js';

const O = FRAMEWORK.frameworks.ontology, SCHEMAS = FRAMEWORK.schemas;
export const TYPE = Object.fromEntries(O.object_types.map((t) => [t.type, t]));
export const PREFIX = Object.fromEntries(O.object_types.map((t) => [t.prefix, t.type]));
const TRANSITIONS = O.versioning_model.transitions;

export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const slug = (s, n = 60) => norm(s).replace(/ /g, '_').slice(0, n).replace(/_+$/, '') || 'x';
const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
// Content hash: everything except the envelope fields that change on every write.
// classification and decomposition bookkeeping are derived values too (decomposition.json), like the scores.
// source_metadata is a Source's derived Metadata Object (lifecycle.js, lifecycle stage 1): recomputed by rules, never a new version.
const VOLATILE = new Set(['version', 'updated', 'change_log', 'scores', 'confidence', 'created', 'classification', 'decomposition', 'source_metadata']);
// Timestamps inside provenance steps and facet items ('at') are not content: a rewrite that changes only them is not a new version.
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).filter((k) => k !== 'at').sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
export const contentHash = (o) => sha(canon(Object.fromEntries(Object.entries(o).filter(([k]) => !VOLATILE.has(k)))));
const bump = (v, part) => { const [a, b, c] = String(v || '0.0.0').split('.').map(Number); return part === 'major' ? `${a + 1}.0.0` : part === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`; };

export async function getObject(env, id) { const r = await env.DB.prepare('SELECT body FROM mk_objects WHERE id = ?').bind(id).first(); return r ? J(r.body) : null; }
export async function getObjects(env, ids) {
  const out = {}, list = [...new Set(ids)].filter(Boolean), parts = [];
  for (let i = 0; i < list.length; i += 90) parts.push(list.slice(i, i + 90));
  // The chunks are independent reads: asked for up to six at a time (one wait per six chunks instead of one per chunk), merged in
  // chunk order as before.
  for (let i = 0; i < parts.length; i += 6) {
    const got = await Promise.all(parts.slice(i, i + 6).map((part) => env.DB.prepare(`SELECT id, body FROM mk_objects WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all()));
    for (const { results } of got) for (const r of results) out[r.id] = J(r.body);
  }
  return out;
}
export async function history(env, id) {
  const { results } = await env.DB.prepare('SELECT version, hash, at, event_id, actor FROM mk_versions WHERE id = ? ORDER BY at').bind(id).all();
  return results;
}

export function schemaErrors(o) {
  const t = TYPE[o.type]; if (!t) return [{ path: 'type', message: `unknown object type ${o.type}` }];
  return validate(o, SCHEMAS[t.schema], SCHEMAS);
}

// Score an object from its own fields (and its source's scores, for derived objects).
export async function scoreObject(env, o, srcScores) {
  const ovr = await overrides(env);
  const scores = o.type === 'Source' ? scoreSource(o, ovr) : scoreDerived(o, srcScores, ovr);
  return { scores, confidence: knowledgeConfidence(o, scores, ovr) };
}

/* Create or update one object. `o` is the full object (envelope + type fields). Returns {id, version, changed, errors}.
   - Unchanged content (same hash) is a no-op: Generate Once, Store Once.
   - Changed content gets a new version (patch by default; `part` minor/major), a change_log line, a mk_versions row and an audit row.
   - Schema errors are returned; with `strict` the write is refused (stop-the-line), otherwise the object is stored with
     governance_status 'stopped' so it is never served as authoritative until fixed. */
export async function putObject(env, input, { actor = 'system', event_id = null, summary = '', part = 'patch', strict = false, srcScores = null, audited = true, rescore = false, aliases = true } = {}) {
  const now = nowIso(), prev = await getObject(env, input.id);
  const o = { ...input };
  o.version = prev ? prev.version : (o.version || '1.0.0');
  o.created = prev ? prev.created : (o.created || now);
  o.status = o.status || prev?.status || 'current';
  o.governance_status = o.governance_status || prev?.governance_status || 'pending_validation';
  o.provenance = Array.isArray(o.provenance) && o.provenance.length ? o.provenance : prev?.provenance || [];
  o.change_log = prev?.change_log || o.change_log || [];
  const errors = schemaErrors({ ...o, updated: now, version: o.version });
  if (errors.length && strict) return { id: o.id, changed: false, errors };
  if (errors.length) o.governance_status = 'stopped';
  const hash = await contentHash(o);
  const prevHash = prev ? await contentHash(prev) : null;
  if (prev && prevHash === hash) {
    // Same content. Scores are derived values: refresh them in place (no new version) when an upstream input moved them.
    if (rescore) {
      const sc = await scoreObject(env, prev, srcScores);
      if (JSON.stringify(sc.scores) !== JSON.stringify(prev.scores)) {
        const nb = { ...prev, scores: sc.scores, confidence: sc.confidence };
        await env.DB.prepare('UPDATE mk_objects SET body = ?, trust = ?, conf = ? WHERE id = ?').bind(JSON.stringify(nb), sc.scores.trust_score, sc.confidence.confidence_score, o.id).run();
        return { id: o.id, version: prev.version, changed: false, rescored: true, errors };
      }
    }
    return { id: o.id, version: prev.version, changed: false, errors };
  }
  if (prev) o.version = bump(prev.version, part);
  o.updated = now;
  o.change_log = [...o.change_log, { version: o.version, at: now, summary: summary || (prev ? 'updated' : 'created'), ...(event_id ? { event_id } : {}) }].slice(-50);
  const sc = await scoreObject(env, o, srcScores); o.scores = sc.scores; o.confidence = sc.confidence;
  const body = JSON.stringify(o);
  const spec = Array.isArray(o.specialty) ? o.specialty[0] || null : o.specialty || null;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO mk_objects (id, type, name, norm, specialty, status, gov, version, trust, conf, hash, body, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET type=excluded.type, name=excluded.name, norm=excluded.norm, specialty=excluded.specialty, status=excluded.status, gov=excluded.gov, version=excluded.version,
      trust=excluded.trust, conf=excluded.conf, hash=excluded.hash, body=excluded.body, updated=excluded.updated`)
      .bind(o.id, o.type, String(o.name).slice(0, 300), norm(o.name).slice(0, 300), spec, o.status, o.governance_status, o.version, o.scores.trust_score, o.confidence.confidence_score, hash, body, o.created, now),
    env.DB.prepare('INSERT OR REPLACE INTO mk_versions (id, version, hash, body, at, event_id, actor) VALUES (?,?,?,?,?,?,?)').bind(o.id, o.version, hash, body, now, event_id, actor),
    // Relevance dirty flag (dirty.js): only a creation or a status, type or governance change alters relevance; one small insert.
    ...dirtyStmts(env, seedsForObject(prev, o)),
  ]);
  // Derived objects (objectives, teaching points, criteria) are not names a concept can be found by.
  if (aliases) await indexAliases(env, o);
  if (audited) await audit(env, actor, prev ? 'update' : 'create', o.id, prev?.version, o.version, errors.length ? { errors: errors.slice(0, 5) } : summary ? { summary } : null);
  return { id: o.id, version: o.version, changed: true, created: !prev, errors };
}

// Names a concept or object can be found by (Identity facets: Canonical Name, Aliases, Synonyms, Abbreviations, Historical Terminology).
export async function indexAliases(env, o) {
  const names = new Map();
  const add = (s, kind) => { const n = norm(s); if (n && n.length <= 160) names.set(n, names.get(n) || kind); };
  add(o.name, 'name'); add(o.canonical_name, 'name'); add(o.short_label, 'label');
  for (const a of o.aliases || []) add(a, 'alias');
  for (const a of o.abbreviations || []) add(a, 'abbreviation');
  if (o.registry_ref_id) add(o.registry_ref_id, 'ref_id');
  if (o.doi) add(o.doi, 'doi');
  if (!names.size) return;
  await env.DB.batch([...names].map(([a, k]) => env.DB.prepare('INSERT OR IGNORE INTO mk_aliases (alias, id, kind) VALUES (?, ?, ?)').bind(a, o.id, k)));
}

// VERSIONING MODEL transitions. Nothing is deleted: superseded/retired objects stay readable with include_history.
export async function setStatus(env, id, status, { actor = 'system', replaced_by = null, reason = '', event_id = null, force = false } = {}) {
  const o = await getObject(env, id); if (!o) return { ok: false, error: 'not found' };
  if (o.status === status && (!replaced_by || o.replaced_by === replaced_by)) return { ok: true, unchanged: true };
  // force: a recomputation (guideline family, a file back in the library) or an owner correction may restore an earlier state.
  if (o.status !== status && !force && !(TRANSITIONS[o.status] || []).includes(status)) return { ok: false, error: `cannot move ${o.status} -> ${status}` };
  const r = await putObject(env, { ...o, status, replaced_by: replaced_by || o.replaced_by || null }, { actor, event_id, summary: `status ${o.status} -> ${status}${reason ? ': ' + reason : ''}`, part: 'minor' });
  await env.DB.prepare('UPDATE mk_edges SET status = ?, updated = ? WHERE src = ? OR dst = ?').bind(status === 'retired' ? 'retired' : status === 'superseded' ? 'superseded' : 'current', nowIso(), id, id).run();
  return { ok: true, ...r };
}
export async function supersede(env, oldId, newId, opts = {}) {
  const n = await getObject(env, newId); if (!n) return { ok: false, error: 'replacement not found' };
  if (n.supersedes !== oldId) await putObject(env, { ...n, supersedes: oldId }, { ...opts, summary: 'supersedes ' + oldId });
  return setStatus(env, oldId, 'superseded', { ...opts, replaced_by: newId });
}

/* Query with CURRENT STATE PRIORITIZATION: current first, then highest trust (authority, evidence, freshness folded in),
   unless include_history asks for superseded and retired versions too. */
export async function query(env, { type, types, specialty, q, status, include_history = false, limit = 50, offset = 0, gov, include_user_assets = false } = {}) {
  const where = [], args = [];
  // Assets mapped from a learner's own record (ids ea.u<account>.*) are that learner's, never part of shared search.
  if (!include_user_assets) where.push("id NOT LIKE 'ea.u%'");
  const ts = types || (type ? [type] : null);
  if (ts) { where.push(`type IN (${ts.map(() => '?').join(',')})`); args.push(...ts); }
  if (specialty) { where.push('specialty = ?'); args.push(specialty); }
  if (status) { where.push('status = ?'); args.push(status); } else if (!include_history) where.push("status IN ('current','modified')");
  if (gov) { where.push('gov = ?'); args.push(gov); } else where.push("gov != 'rejected'");
  if (q) {
    const n = norm(q);
    where.push('(norm LIKE ? OR id IN (SELECT id FROM mk_aliases WHERE alias = ? OR alias LIKE ?))'); args.push('%' + n + '%', n, n + '%');
  }
  const sql = `SELECT body FROM mk_objects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'current' THEN 0 WHEN 'modified' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END, trust DESC, name LIMIT ? OFFSET ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, Math.min(500, limit), offset).all();
  return results.map((r) => J(r.body));
}
export async function counts(env) {
  const { results } = await env.DB.prepare('SELECT type, status, gov, COUNT(*) AS n FROM mk_objects GROUP BY type, status, gov').all();
  return results;
}
