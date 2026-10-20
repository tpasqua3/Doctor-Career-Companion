// THE DYNAMIC BOARD OBJECTIVE CURRICULUM in Google Drive (owner directive, 10/20/2026): the durable home of the board objective
// curriculum's knowledge elements, one readable JSON file per blueprint objective:
//
//   Medical Knowledge Database / Dynamic Board Objective Curriculum / ABIM CERT / <discipline> / <code> <objective>.json
//                                                                     / LKA       / <discipline> / <code> <objective>.json
//
// <discipline> is the blueprint's own content category. An objective on both examinations (a CERT objective with an LKA counterpart)
// is written into both exam folders. Each file carries the objective (blueprint metadata and weighting), the knowledge objects tied to it
// (concepts, learning and assessment objectives, competencies), and every lesson stored for it with its content, confidence tier and
// generation metadata. Writes follow canonical storage: a file changes only when its content does, and a write counts only when
// Drive confirms it (MD5 or size); refused or unconfirmed writes stay pending and are retried by the next run (mk_curfiles).
// The library scan skips this folder (ingestion.json skip_folder_patterns), so generated material is never ingested as a source.
import { J, nowIso, getSetting, setSetting } from './db.js';

const FOLDER = 'application/vnd.google-apps.folder';
const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
async function md5hex(text) { try { return [...new Uint8Array(await crypto.subtle.digest('MD5', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; } }
const safe = (s, n = 110) => String(s || '').replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) || 'Untitled';
const EXAMS = { cert: 'ABIM CERT', lka: 'LKA' };

let READY = false;
async function init(env) {
  if (READY) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS mk_curfiles (key TEXT PRIMARY KEY, file_id TEXT, folder TEXT, name TEXT, hash TEXT, synced TEXT, state TEXT NOT NULL, detail TEXT)').run();
  READY = true;
}

/* The three folders by name under the library root (or MKOS_CURRICULUM_FOLDER), found once and remembered; discipline folders are made as needed. */
async function folders(env, deps) {
  const F = J(await getSetting(env, 'cur_folders'), null) || { disc: {} };
  if (!F.root) {
    const root = deps.curriculumFolder || null;
    if (root) F.root = root;
    else {
      if (!deps.libraryRoot) throw new Error('The library folder is not set on the server.');
      const kids = await listAll(deps, deps.libraryRoot);
      const hit = kids.find((f) => f.mimeType === FOLDER && /^dynamic board objective curriculum$/i.test(f.title.trim()));
      if (!hit) throw new Error('No "Dynamic Board Objective Curriculum" folder in Medical Knowledge Database.');
      F.root = hit.id;
    }
  }
  if (!F.cert || !F.lka) {
    const kids = await listAll(deps, F.root);
    const find = (re) => (kids.find((f) => f.mimeType === FOLDER && re.test(f.title.trim())) || {}).id;
    F.cert = F.cert || find(/^abim\s*cert(ification)?$/i) || await deps.mkdir(EXAMS.cert, F.root);
    F.lka = F.lka || find(/^lka$/i) || await deps.mkdir(EXAMS.lka, F.root);
  }
  await setSetting(env, 'cur_folders', JSON.stringify(F));
  return F;
}
async function listAll(deps, id) { const out = []; let tok = ''; for (let i = 0; i < 20; i++) { const p = await deps.list(id, tok); out.push(...p.files); if (!p.next) break; tok = p.next; } return out; }
async function discFolder(env, deps, F, exam, name) {
  const k = exam + ':' + safe(name, 80); if (F.disc[k]) return F.disc[k];
  const parent = F[exam], kids = await listAll(deps, parent);
  const hit = kids.find((f) => f.mimeType === FOLDER && f.title.trim().toLowerCase() === safe(name, 80).toLowerCase());
  F.disc[k] = hit ? hit.id : await deps.mkdir(safe(name, 80), parent);
  await setSetting(env, 'cur_folders', JSON.stringify(F));
  return F.disc[k];
}

/* Everything one objective file holds. */
async function payload(env, bt, exam, counterpart) {
  const bp = await env.DB.prepare('SELECT priority_score, frequency_score, importance_score, confidence_score FROM mk_blueprint_objectives WHERE objective_id = ?').bind(bt.id).first().catch(() => null);
  const edges = (await env.DB.prepare("SELECT src, rel, dst FROM mk_edges WHERE status = 'current' AND ((dst = ? AND rel = 'mapped_to_blueprint') OR (src = ? AND rel IN ('develops','in_domain')))").bind(bt.id, bt.id).all()).results;
  const ids = [...new Set([...(bt.concepts || []), ...edges.map((e) => (e.dst === bt.id ? e.src : e.dst))])].slice(0, 90);
  const objs = ids.length ? (await env.DB.prepare(`SELECT id, type, name, status, body FROM mk_objects WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results : [];
  const ko = objs.map((o) => { const b = J(o.body, {}) || {}; return { id: o.id, type: o.type, name: o.name, status: o.status, statement: b.statement || null, kind: b.objective_type || b.edu_kind || b.concept_type || null, confidence: b.confidence ? b.confidence.confidence_score ?? null : null }; });
  const lessonIds = [bt.id, ...(counterpart ? [counterpart.id] : [])];
  const lessons = (await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND id LIKE 'ea.s.%' AND json_extract(body, '$.objective') IN (${lessonIds.map(() => '?').join(',')})`).bind(...lessonIds).all()).results.map((r) => J(r.body, {}));
  const out = [];
  for (const o of lessons) {
    const c = await env.DB.prepare('SELECT content FROM mk_asset_store WHERE asset_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(o.id).first();
    out.push({ asset_id: o.id, version: o.version, pass: o.generation ? o.generation.pass : null, review_status: o.review_status, needs: o.needs || [], confidence: o.asset_confidence || null,
      tier: o.confidence_tier || (o.asset_confidence && o.asset_confidence.tier) || null, generation: o.generation || null, cites: o.cites || [], updated: o.updated, content: c ? J(c.content, null) : null });
  }
  return {
    schema: 'mkos.board_objective/1', exam: EXAMS[exam], blueprint_id: bt.blueprint || null,
    objective: { id: bt.id, code: bt.code || null, name: bt.name, category: bt.category || null, subcategory: bt.subcategory || null, domain: bt.domain || null, importance: bt.importance || null,
      est_pct: bt.est_pct ?? null, low_frequency: !!bt.low_frequency, priority_score: bp ? bp.priority_score : null, frequency_score: bp ? bp.frequency_score : null, importance_score: bp ? bp.importance_score : null },
    counterpart: counterpart ? { exam: EXAMS[exam === 'cert' ? 'lka' : 'cert'], id: counterpart.id, code: counterpart.code || null } : null,
    knowledge_objects: ko, edges: edges.map((e) => [e.src, e.rel, e.dst]), lessons: out,
    coverage: { lessons: out.length, best_tier: out.map((l) => l.tier).find((t) => t === 'durable') || out.map((l) => l.tier).find((t) => t === 'provisional') || out.map((l) => l.tier)[0] || null },
    note: 'Generated and maintained by MKOS (Doctor Career Companion). Lessons are AI-written teaching material checked by an independent accuracy review; they are not source documents and are not ingested as such.',
  };
}

/* One run: up to `max` objective files whose content changed (objectives with lessons first). */
export async function curSync(env, deps, { max = 10 } = {}) {
  await init(env);
  if (!deps.upload || !deps.list || !deps.mkdir) return { skipped: 'Drive is not connected' };
  const F = await folders(env, deps);
  const cert = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'BlueprintTopic' AND status = 'current' AND (id LIKE 'bpt.cert.%' OR id LIKE 'bpt.lka.%')").all()).results.map((r) => J(r.body, {}));
  const byCode = { cert: {}, lka: {} }; for (const b of cert) byCode[b.id.startsWith('bpt.cert.') ? 'cert' : 'lka'][b.code] = b;
  const withLessons = new Set((await env.DB.prepare("SELECT DISTINCT json_extract(body, '$.objective') AS o FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND id LIKE 'ea.s.%' AND json_extract(body, '$.objective') IS NOT NULL").all()).results.map((r) => r.o));
  const known = Object.fromEntries((await env.DB.prepare('SELECT key, file_id, hash, state, folder FROM mk_curfiles').all()).results.map((r) => [r.key, r]));
  // Order: pending retries, then objectives with lessons, then the rest (so the curriculum's skeleton fills in as runs allow).
  const items = cert.map((b) => { const exam = b.id.startsWith('bpt.cert.') ? 'cert' : 'lka'; const cp = exam === 'cert' ? (b.data && b.data.lka_ref ? byCode.lka[b.data.lka_ref] : null) : Object.values(byCode.cert).find((c) => c.data && c.data.lka_ref === b.code) || null;
    const key = exam + ':' + b.id, k = known[key]; return { b, exam, cp, key, k, rank: k && k.state !== 'synced' ? 0 : withLessons.has(b.id) || (cp && withLessons.has(cp.id)) ? 1 : k ? 3 : 2 }; })
    .sort((x, y) => x.rank - y.rank);
  let written = 0, same = 0, failed = 0, checked = 0;
  for (const it of items) {
    if (written + failed >= max || checked >= max * 12) break; checked++;
    const body = await payload(env, it.b, it.exam, it.cp);
    const text = JSON.stringify(body, null, 1), hash = (await sha(text)).slice(0, 24);
    if (it.k && it.k.hash === hash && it.k.state === 'synced') { same++; continue; }
    try {
      const parent = await discFolder(env, deps, F, it.exam, it.b.category || 'Other');
      const name = safe((it.b.code ? it.b.code + ' ' : '') + it.b.name) + '.json';
      let r; try { r = await deps.upload({ id: it.k && it.k.folder === parent ? it.k.file_id : null, name, parent, text, mime: 'application/json' }); }
      catch (e) { if (e && e.gone && it.k) r = await deps.upload({ id: null, name, parent, text, mime: 'application/json' }); else throw e; }
      const md5 = r && r.md5 ? await md5hex(text) : null;
      if (r && r.md5 && md5 && md5 !== r.md5) throw new Error('Drive reports a different MD5 than what was sent');
      await env.DB.prepare('INSERT OR REPLACE INTO mk_curfiles (key, file_id, folder, name, hash, synced, state, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(it.key, r.id, parent, name, hash, nowIso(), 'synced', r.md5 ? 'md5' : 'size').run();
      written++;
    } catch (e) {
      failed++;
      await env.DB.prepare('INSERT OR REPLACE INTO mk_curfiles (key, file_id, folder, name, hash, synced, state, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(it.key, it.k ? it.k.file_id : null, it.k ? it.k.folder : null, it.k ? it.k.name : null, it.k ? it.k.hash : null, it.k ? it.k.synced : null, 'pending', String(e.message || e).slice(0, 300)).run();
    }
  }
  return { written, unchanged: same, failed, checked };
}
/* curriculum_status: how much of the curriculum is in Drive. */
export async function curStatus(env) {
  await init(env);
  const by = (await env.DB.prepare("SELECT substr(key, 1, instr(key, ':') - 1) AS exam, state, COUNT(*) AS n FROM mk_curfiles GROUP BY exam, state").all()).results;
  const total = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'BlueprintTopic' AND status = 'current' AND (id LIKE 'bpt.cert.%' OR id LIKE 'bpt.lka.%')").first()) || {}).n || 0;
  const errs = (await env.DB.prepare("SELECT key, detail FROM mk_curfiles WHERE state != 'synced' LIMIT 10").all()).results;
  return { objectives: total, files: by, pending: errs, folders: J(await getSetting(env, 'cur_folders'), null) };
}
