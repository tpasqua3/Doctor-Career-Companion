// Ingestion: the library scanner, source registration and classification, guideline families and supersession, and the owner
// registry import. Every change found becomes a change event (Dynamic Knowledge Refresh Engine) and, where needed, a queued job.
// Nothing here calls an AI. `deps` supplies Drive access from the Worker: deps.list(folderId, pageToken) -> {files, next}.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { putObject, getObject, setStatus, norm, slug } from './kb.js';
import { addEdges } from './graph.js';
import { sourceClass } from './scoring.js';

const F = FRAMEWORK.frameworks, ING = F.ingestion;
const SPEC_BY_ALIAS = new Map(); for (const s of F.specialties.specialties) for (const a of s.folder_aliases) SPEC_BY_ALIAS.set(a.toLowerCase(), s.id);
const FOLDER = 'application/vnd.google-apps.folder';
const rx = (list) => list.map((p) => new RegExp(p, 'i'));
const SKIP_FOLDERS = rx(ING.watch.skip_folder_patterns), SKIP_TITLES = rx(ING.watch.skip_title_patterns);
const READABLE = /pdf|document|text\/|msword|officedocument\.wordprocessing|epub/i;

export const newId = (p) => p + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export async function event(env, kind, subject, detail = {}, stage = 'created') {
  const id = newId('evt'), now = nowIso();
  await env.DB.prepare('INSERT INTO mk_events (id, kind, subject, stage, detail, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, kind, subject, stage, JSON.stringify(detail).slice(0, 20000), now, now).run();
  return id;
}
export async function queue(env, kind, subject, payload = {}, priority = 5, delayMs = 0) {
  const now = nowIso();
  const r = await env.DB.prepare('INSERT OR IGNORE INTO mk_jobs (kind, subject, payload, state, priority, not_before, created, updated) VALUES (?, ?, ?, \'queued\', ?, ?, ?, ?)')
    .bind(kind, subject, JSON.stringify(payload), priority, Date.now() + delayMs, now, now).run();
  // A job for the same subject is already open: restart it with the new event, so a file changed again is never read from stale text.
  if (!(r.meta && r.meta.changes)) {
    await env.DB.prepare("UPDATE mk_jobs SET payload = ?, state = 'queued', not_before = 0, updated = ? WHERE kind = ? AND subject = ? AND state IN ('queued','running')").bind(JSON.stringify(payload), now, kind, subject).run();
    if (kind === 'extract') await env.DB.prepare('DELETE FROM mk_text WHERE source_id = ?').bind(subject).run();
  }
}

// ---------- Classification (deterministic) ----------
export function specialtyOf(pathParts) {
  for (let i = pathParts.length - 1; i >= 0; i--) { const s = SPEC_BY_ALIAS.get(String(pathParts[i]).toLowerCase().trim()); if (s) return s; }
  return null;
}
const YEAR = /\b(19[89]\d|20[0-4]\d)\b/g;
export const yearOf = (...xs) => { for (const x of xs) { const m = String(x || '').match(YEAR); if (m) return Math.max(...m.map(Number)); } return null; };
export function classify(title, pathParts, mime) {
  const t = String(title || ''), p = pathParts.join('/').toLowerCase();
  if (SKIP_TITLES.some((r) => r.test(t)) && /json|spreadsheet|csv/i.test(mime || '')) return 'registry_or_backend';
  if (/blueprint/.test(p) || /blueprint/i.test(t)) return 'board_blueprint';
  if (/mksap/.test(p)) return 'mksap';
  if (/textbook/.test(p)) return 'textbook';
  if (/question bank|qbank/.test(p)) return 'question_bank';
  if (/^(cover|contents|table of contents|index|copyright|front matter|title page|editorial board|masthead|information for (authors|readers)|erratum|correction)\b/i.test(t) || /\b(editorial board|table of contents|masthead)\b/i.test(t)) return 'front_matter';
  if (/^(reply|letter|correspondence|in reply|response to)(\b|_)/i.test(t)) return 'research_article';
  if (/immunization schedule|vaccine schedule|acip/i.test(t)) return 'immunization_schedule';
  if (/uspstf|preventive services task force|recommendation statement/i.test(t)) return 'preventive_recommendations';
  if (/executive summary/i.test(t)) return 'guideline_executive_summary';
  if (/expert consensus decision pathway|ecdp/i.test(t)) return 'expert_consensus_document';
  if (/clinical practice update/i.test(t)) return 'clinical_practice_update';
  if (/scientific statement/i.test(t)) return 'scientific_statement';
  if (/consensus/i.test(t)) return 'consensus_statement';
  if (/\b(gold|gina)\b|global strategy|strategy report/i.test(t)) return 'strategy_report';
  if (/policy|protocol|procedure manual|infection control|isolation precautions/i.test(t)) return 'protocol';
  if (/\b(trial|randomi[sz]ed|cohort|case report|case series|retrospective|prospective)\b/i.test(t)) return 'research_article';
  if (/\breview\b/i.test(t) && !/guideline/i.test(t)) return 'review_article';
  if (/guideline/.test(p) || /guideline|recommendation|standards of care|kdigo|statement/i.test(t)) return 'clinical_practice_guideline';
  return 'unclassified';
}
export function populationOf(title, path) {
  const s = (title + ' ' + path).toLowerCase();
  const ped = /\b(pediatric|paediatric|children|child|infant|neonat|adolescent|newborn|youth)\b/.test(s), adult = /\badult/.test(s);
  return ped && adult ? 'mixed' : ped ? 'pediatric' : adult ? 'adult' : 'unknown';
}
// Organizations named in a title (for guideline families). Order kept; up to 6.
const ORG = /\b(ACC|AHA|ACP|ACG|AGA|AASLD|ACR|EULAR|ADA|AACE|ATA|IDSA|ATS|ERS|CHEST|KDIGO|USPSTF|ASH|ISTH|AAN|ASA|ESC|HFSA|HRS|SCAI|ASE|SVS|ACOG|AUA|ACIP|CDC|NCCN|ASCO|ACS|GOLD|GINA|AASM|SCCM|ESMO|AAD|APA|AGS|NLA|ESH|ISH|WHO|NICE|SHEA|APIC|AAFP|AMDA|NKF|ASN|ACCP|AAOS|AMSSM|ACEP|SHM|EASL|BTS|ACOEM|NAMS|ES|AAAAI|ACAAI|ACMT|AACN)\b/g;
const ORG_NAMES = [[/american college of physicians/i, 'ACP'], [/american heart association/i, 'AHA'], [/american college of cardiology/i, 'ACC'], [/infectious diseases society of america/i, 'IDSA'],
  [/american thoracic society/i, 'ATS'], [/american college of rheumatology/i, 'ACR'], [/american gastroenterological association/i, 'AGA'], [/american college of gastroenterology/i, 'ACG'],
  [/kidney disease:? improving global outcomes/i, 'KDIGO'], [/american diabetes association/i, 'ADA'], [/american society of hematology/i, 'ASH'], [/american academy of neurology/i, 'AAN'],
  [/american stroke association/i, 'ASA'], [/surviving sepsis/i, 'SCCM'], [/american association for the study of liver diseases/i, 'AASLD'], [/preventive services task force/i, 'USPSTF'],
  [/centers for disease control/i, 'CDC'], [/european society of cardiology/i, 'ESC'], [/american academy of dermatology/i, 'AAD'], [/endocrine society/i, 'ES'], [/american geriatrics society/i, 'AGS'],
  [/american college of chest physicians/i, 'CHEST'], [/american urological association/i, 'AUA'], [/american college of obstetricians/i, 'ACOG'], [/world health organization/i, 'WHO']];
// Organizations named in a title or its folder (for guideline families). Order kept; up to 6.
export const orgsOf = (t, pathParts = []) => {
  const s = String(t || ''), found = [...(s.toUpperCase().replace(/[,/_]/g, ' ').match(ORG) || [])];
  for (const [re, ab] of ORG_NAMES) if (re.test(s)) found.push(ab);
  for (const p of pathParts) { const m = String(p).toUpperCase().match(ORG); if (m && String(p).trim().length <= 8) found.push(...m); }
  return [...new Set(found)].slice(0, 6);
};
const BOILER = /\b(19|20)\d\d\b|\b(guidelines?|for the|management|of|and|the|in|on|a|an|adults?|patients?|with|report|joint committee|clinical practice|focused update|update|executive summary|american|college|association|society|heart|cardiology|statement|recommendations?|evaluation|diagnosis|treatment|prevention|detection|summary|pdf|docx?)\b/gi;
// Topic of a document title: drop years, organization names and acronyms (all-caps 2-6 letters), boilerplate and file noise.
const NOISE = /\b(update alerts?|alert \d*|version \d+|living|rapid|practice points?|annals of internal medicine|pdf|reply|\d+)\b|_/gi;
export const topicKey = (title) => topicWords(title).slice(0, 6).sort().join('_');
export const topicWords = (title) => {
  let t = String(title || '').replace(/\.(pdf|docx?|epub)$/i, '');
  for (const [re] of ORG_NAMES) t = t.replace(re, ' ');
  t = t.replace(/\b[A-Z]{2,6}\b/g, ' ').replace(ORG, ' ').replace(NOISE, ' ').replace(BOILER, ' ');
  const stop = new Set(['for', 'from', 'with', 'the', 'and', 'into', 'after', 'among', 'versus', 'without', 'during']);
  return [...new Set(norm(t).split(' ').filter((w) => w.length > 2 && !stop.has(w)))];
};
export const cleanTitle = (title) => String(title || '').replace(/\.(pdf|docx?|epub)$/i, '').replace(/^[\s\d\-–—_~.]+(?=[A-Za-z])/, '').replace(/\s*_\s*Annals of Internal Medicine.*$/i, '').replace(/_/g, ':').replace(/\s+/g, ' ').trim();
export const familyId = (orgs, title) => 'gl.' + slug((orgs.slice(0, 2).join('_') || 'misc') + '_' + topicKey(title), 70);

// ---------- Source registration ----------
export const sourceIdFor = (fileId) => 'src.' + String(fileId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
export async function registerFile(env, f, pathParts, { actor = 'scanner', sweep = 0 } = {}) {
  const now = nowIso(), prev = await env.DB.prepare('SELECT * FROM mk_files WHERE drive_file_id = ?').bind(f.id).first();
  const path = pathParts.join('/'), cls = classify(f.title, pathParts, f.mimeType);
  const changed = !prev ? 'source_added' : (prev.md5 && f.md5 && prev.md5 !== f.md5) || (!f.md5 && prev.modified !== f.modifiedTime) ? 'source_modified'
    : prev.path !== path ? 'source_moved' : prev.title !== f.title ? 'source_renamed' : prev.state === 'removed' ? 'source_added' : null;
  const touch = async () => {
    await env.DB.prepare(`INSERT INTO mk_files (drive_file_id, source_id, title, path, parent, mime, bytes, md5, modified, sweep, state, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (drive_file_id) DO UPDATE SET title=excluded.title, path=excluded.path, parent=excluded.parent, mime=excluded.mime, bytes=excluded.bytes, md5=excluded.md5,
    modified=excluded.modified, sweep=excluded.sweep, state=CASE WHEN mk_files.state='removed' THEN 'seen' ELSE mk_files.state END, updated=excluded.updated`)
    .bind(f.id, sourceIdFor(f.id), f.title, path, f.parentId || '', f.mimeType || '', Number(f.fileSize) || 0, f.md5 || '', f.modifiedTime || '', sweep, 'seen', now).run();
  };
  if (!changed) { await touch(); return null; }
  const id = sourceIdFor(f.id), old = await getObject(env, id), c = sourceClass(old?.registry_ref_id ? old.source_class : cls);
  const orgs = old?.responsible_orgs?.length ? old.responsible_orgs : orgsOf(f.title, pathParts);
  const src = {
    ...(old || {}), id, type: 'Source', name: old?.short_label || cleanTitle(f.title).slice(0, 200) || f.title,
    specialty: old?.specialty?.length ? old.specialty : [specialtyOf(pathParts)].filter(Boolean),
    status: old?.status && old.status !== 'retired' ? old.status : 'current', governance_status: old?.governance_status || 'pending_validation',   // a file back in the library is current again
    source_class: old?.registry_ref_id ? old.source_class : cls, spec_source_type: c.spec_source_type, drive_file_id: f.id, drive_path: path, mime_type: f.mimeType || '',
    bytes: Number(f.fileSize) || 0, md5: f.md5 || '', drive_modified: f.modifiedTime || '', title: old?.title || f.title,
    responsible_orgs: orgs, year: old?.year || yearOf(f.title, path), population: old?.population || populationOf(f.title, path), copyright: c.copyright,
    // Every source with an extraction depth is processed: a readable file is read; any other (images, media, other formats) is mapped
    // by its title (Large Source Governance: never skip, always register, always map).
    ingest_state: changed === 'source_moved' || changed === 'source_renamed' ? (old?.ingest_state || 'registered') : c.extraction_depth !== 'none' ? 'queued' : 'skipped',
    provenance: old?.provenance?.length ? old.provenance : [{ source_id: id, method: 'derived', at: now, agent: actor, note: 'registered from the library scan' }],
  };
  const ev = await event(env, changed, id, { title: f.title, path, md5: f.md5 || '', prev: prev ? { md5: prev.md5, path: prev.path, title: prev.title } : null });
  await putObject(env, src, { actor, event_id: ev, summary: changed.replace('source_', 'source ') });
  if (old && old.status === 'retired') await setStatus(env, id, 'current', { actor, event_id: ev, force: true, reason: 'back in the library' });
  if (src.ingest_state === 'queued' && (changed === 'source_added' || changed === 'source_modified')) await queue(env, 'extract', id, { event_id: ev }, src.copyright === 'licensed_no_verbatim' ? 7 : 4);
  if (changed === 'source_added' || changed === 'source_modified') await queue(env, 'family', id, { event_id: ev }, 3);
  if (changed === 'source_modified') await queue(env, 'impact', id, { event_id: ev }, 2);
  if (src.source_class === 'board_blueprint' && (changed === 'source_added' || changed === 'source_modified') && !/json/i.test(f.mimeType || '')) {
    await event(env, 'blueprint_detected', id, { title: f.title, path, chain: ['BlueprintDetected', 'BlueprintClassified'] }, 'classified');
    await queue(env, 'bp_extract', id, { event_id: ev }, 4);
  }
  await touch();   // last, so an interrupted run sees the change again next time
  return { id, changed, event_id: ev };
}

// ---------- The scanner: one page of the library per call ----------
// Cursor in mk_settings 'scan': {sweep, queue: [{id, path}], cur: {id, path, token}}. A sweep walks the whole tree; at its end, files
// not seen in the sweep are marked removed (their sources are retired, never deleted).
export async function scanStep(env, deps, rootId, { pages = 1, actor = 'scanner' } = {}) {
  let cur = J(await getSetting(env, 'scan'), null);
  if (!cur || !cur.queue) { const last = J(await getSetting(env, 'scan_last_complete'), null); cur = { sweep: ((last && last.sweep) || 0) + 1, queue: [{ id: rootId, path: [] }], cur: null, started: nowIso() }; }
  const out = { files: 0, changes: [], folders: 0, sweep: cur.sweep };
  // The cursor (folder, page token, and the index of the next file on that page) is saved however the run ends, so a run that
  // stops mid-page resumes at the next file instead of starting the page again.
  try {
    for (let p = 0; p < pages; p++) {
      if (!cur.cur) { const next = cur.queue.shift(); if (!next) break; cur.cur = { ...next, token: '', index: 0 }; }
      const page = await deps.list(cur.cur.id, cur.cur.token), files = page.files || [];
      for (let i = cur.cur.index || 0; i < files.length; i++) {
        const f = files[i];
        if (f.mimeType === FOLDER) { if (!SKIP_FOLDERS.some((r) => r.test(f.title)) && !cur.queue.some((q) => q.id === f.id)) { cur.queue.push({ id: f.id, path: [...cur.cur.path, f.title] }); out.folders++; } }
        else { out.files++; const r = await registerFile(env, f, cur.cur.path, { actor, sweep: cur.sweep }); if (r) out.changes.push(r); }
        cur.cur.index = i + 1;
      }
      if (!page.next) cur.done_folders = (cur.done_folders || 0) + 1;   // for the progress display (progress.js)
      cur.cur = page.next ? { ...cur.cur, token: page.next, index: 0 } : null;
    }
    if (!cur.cur && !cur.queue.length) {
      // Sweep finished: anything not seen this sweep left the library.
      const { results } = await env.DB.prepare("SELECT drive_file_id, source_id FROM mk_files WHERE sweep < ? AND state != 'removed' LIMIT 50").bind(cur.sweep).all();
      for (const r of results) {
        const ev = await event(env, 'source_removed', r.source_id, { drive_file_id: r.drive_file_id });
        await queue(env, 'impact', r.source_id, { event_id: ev }, 2);           // impact first, while its edges still say what it touched
        await setStatus(env, r.source_id, 'retired', { actor, reason: 'no longer in the library', event_id: ev });
        await queue(env, 'family', r.source_id, { event_id: ev }, 3);           // a family may need a new current edition
        await env.DB.prepare("UPDATE mk_files SET state = 'removed', updated = ? WHERE drive_file_id = ?").bind(nowIso(), r.drive_file_id).run();
        out.changes.push({ id: r.source_id, changed: 'source_removed' });
      }
      if (results.length < 50) {
        await setSetting(env, 'scan_last_complete', JSON.stringify({ sweep: cur.sweep, finished: nowIso(), started: cur.started }));
        cur = { sweep: cur.sweep + 1, queue: [{ id: rootId, path: [] }], cur: null, started: nowIso() };
      }
    }
  } finally {
    await setSetting(env, 'scan', JSON.stringify(cur));
  }
  return out;
}

// ---------- Guideline families and supersession ----------
// Within a family the newest edition is current; older full editions are superseded; an older edition that a focused update only
// partly replaces is 'modified' (still cited for what the update does not cover). The owner's registry status always wins.
export async function refreshFamily(env, sourceId, { actor = 'system', event_id = null } = {}) {
  const src = await getObject(env, sourceId); if (!src) return null;
  const cls = sourceClass(src.source_class);
  if (!['Guidelines', 'Consensus Statements'].includes(cls.spec_source_type)) return null;
  // A family needs a real topic (two or more words); a document whose title says nothing (e.g. a truncated file name) stands alone.
  if (!src.guideline_family && topicKey(src.title).split('_').filter(Boolean).length < 2) return { family: null, reason: 'title too short to place in a family' };
  const fid = src.guideline_family || familyId(src.responsible_orgs || [], src.title);
  if (src.guideline_family !== fid) await putObject(env, { ...src, guideline_family: fid }, { actor, event_id, summary: 'assigned to guideline family ' + fid });
  const { results } = await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' AND status != 'retired' AND json_extract(body, '$.guideline_family') = ?").bind(fid).all();
  if (!results.length) return { family: fid, editions: 0 };
  const eds = results.map((r) => J(r.body)).filter(Boolean);
  const when = (s) => String(s.published_online || s.issue_date || s.year || '0');
  eds.sort((a, b) => when(b).localeCompare(when(a)));
  const focused = (s) => ING.supersession_detection.focused_update_keywords.some((k) => (s.title || '').toLowerCase().includes(k));
  const newest = eds[0], newestFull = eds.find((s) => !focused(s)) || newest;
  await addEdges(env, eds.map((s) => ({ src: s.id, rel: 'edition_of', dst: fid, conf: 90, prov: { source_id: s.id, method: 'derived', at: nowIso() } })));
  const willSupersede = eds.filter((s) => s.id !== newest.id && !(focused(newest) && s.id === newestFull.id) && !s.data?.legacy?.status);
  if (willSupersede.length) await addEdges(env, willSupersede.map((s) => ({ src: newest.id, rel: 'supersedes', dst: s.id, conf: 85, prov: { source_id: newest.id, method: 'derived', at: nowIso() } })));
  for (const s of eds) {
    if (s.data?.legacy?.status) continue;                // owner registry decides this one
    let want = 'current', role = eds.length === 1 ? 'sole' : 'current';
    if (s.id !== newest.id) {
      if (focused(newest) && s.id === newestFull.id) { want = 'modified'; role = 'current'; }
      else { want = 'superseded'; role = 'superseded'; }
    } else if (focused(s) && eds.length > 1) role = 'focused_update';
    if (s.status !== want) {
      await setStatus(env, s.id, want, { actor, event_id, replaced_by: want === 'superseded' ? newest.id : null, reason: 'guideline family ' + fid, force: true });
      await queue(env, 'impact', s.id, { event_id }, 2);      // what cites or teaches this edition is flagged
    }
    if (s.edition_role !== role) { const cur = await getObject(env, s.id); await putObject(env, { ...cur, edition_role: role }, { actor, event_id, summary: 'edition role ' + role, audited: false }); }
  }
  const gl = (await getObject(env, fid)) || {};
  await putObject(env, {
    ...gl, id: fid, type: 'Guideline', name: gl.name || (newest.short_label ? newest.short_label.replace(/\s*\d{4}$/, '') : ((newest.responsible_orgs || []).slice(0, 2).join('/') + ' ' + cleanTitle(newest.title)).trim()).slice(0, 200),
    specialty: newest.specialty || [], status: 'current', governance_status: gl.governance_status || 'pending_validation', responsible_orgs: newest.responsible_orgs || [],
    topic_key: topicKey(newest.title), editions: eds.map((s) => s.id), current_edition: newestFull.id, focused_updates: eds.filter(focused).map((s) => s.id), covers: gl.covers || [],
    provenance: [{ source_id: newest.id, method: 'derived', at: nowIso(), note: 'guideline family from edition titles and organizations' }],
  }, { actor, event_id, summary: 'family refreshed (' + eds.length + ' editions)' });

  return { family: fid, editions: eds.length };
}

// ---------- Owner registry import (guidelines_registry_vN_CURRENT.json and the sources index) ----------
// Every field of every legacy entry is kept verbatim in data.legacy so the legacy registry can be rebuilt exactly (rollback).
const LEGACY_STATUS = { active: 'current', updated: 'modified', superseded: 'superseded', retired: 'retired', check_edition: 'current', review_relevance: 'current' };
export async function importLegacyRegistry(env, reg, { actor = 'owner_registry', registryFileId = '', prog = { at: 0 } } = {}) {
  const ev = prog.ev || (prog.ev = await event(env, 'registry_import', 'registry.legacy', { version: reg.registry_version, sources: (reg.sources || []).length, file: registryFileId }));
  const out = prog.out || (prog.out = { imported: 0 });
  const list = reg.sources || [];
  for (let i = prog.at || 0; i < list.length; i++) {
    const e = list[i]; prog.at = i;
    if (!e.drive_file_id) continue;
    const id = sourceIdFor(e.drive_file_id), old = (await getObject(env, id)) || {}, cls = sourceClass(e.type);
    const pathParts = String(e.folder_path || '').split('/').filter(Boolean);
    const src = {
      ...old, id, type: 'Source', name: e.short_label || e.title, specialty: [specialtyOf([e.specialty, ...pathParts])].filter(Boolean),
      status: LEGACY_STATUS[e.status] || 'current', governance_status: 'approved', source_class: cls.key === 'unclassified' ? 'clinical_practice_guideline' : cls.key,
      spec_source_type: cls.spec_source_type, drive_file_id: e.drive_file_id, drive_path: old.drive_path || e.folder_path || '', title: e.title, short_label: e.short_label,
      responsible_orgs: e.responsible_orgs || [], collaborating_orgs: e.collaborating_orgs || [], authors: e.authors || '', journal: e.journal || '', citation: e.citation || '',
      doi: e.doi || '', published_online: e.published_online || '', issue_date: e.issue_date || '', year: yearOf(e.published_online, e.issue_date, e.short_label),
      population: /pediatric|child/i.test(e.title + ' ' + (e.notes || '')) ? (/adult/i.test(e.title) ? 'mixed' : 'pediatric') : 'adult', copyright: cls.copyright,
      registry_ref_id: e.ref_id, ingest_state: old.ingest_state || 'queued', citation_source: e.citation_source || '',
      data: { ...(old.data || {}), legacy: e, legacy_registry_version: reg.registry_version, legacy_registry_file: registryFileId },
      provenance: [{ source_id: id, method: 'owner_registry', at: nowIso(), agent: actor, note: `guidelines_registry_v${reg.registry_version} ref_id ${e.ref_id}` }],
    };
    const r = await putObject(env, src, { actor, event_id: ev, summary: 'imported from owner registry v' + reg.registry_version });
    if (r.created) await queue(env, 'extract', id, { event_id: ev }, 4);
    await queue(env, 'family', id, { event_id: ev }, 3);
    out.imported++; prog.at = i + 1;
  }
  // Legacy meta (every top-level key, the original entry order, and any entry without a file) so the registry can be rebuilt exactly.
  const meta = { ...Object.fromEntries(Object.entries(reg).filter(([k]) => k !== 'sources')), order: (reg.sources || []).map((s) => s.ref_id), no_file_sources: (reg.sources || []).filter((s) => !s.drive_file_id) };
  await setSetting(env, 'legacy_registry', JSON.stringify({ meta, file: registryFileId, imported: nowIso(), version: reg.registry_version }));
  await audit(env, actor, 'registry_import', 'registry.legacy', null, String(reg.registry_version), { imported: out.imported });
  await env.DB.prepare("UPDATE mk_events SET stage = 'validated', updated = ? WHERE id = ?").bind(nowIso(), ev).run();
  return { ...out, event_id: ev };
}
