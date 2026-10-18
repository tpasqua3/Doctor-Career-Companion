// Run the whole MKOS engine locally against a library listing, with the real framework and importers, and report.
//   node tools/mkos/dryrun.mjs --work <dir> [--db file.sqlite] [--ticks N]
// <dir> holds: inventory.jsonl (one Drive file/folder per line: id, title, mimeType, fileSize, modifiedTime, parentId, path),
//              existing/guidelines_registry_v6.json, existing/abim_cert_blueprint.json, existing/abim_lka_blueprint.json,
//              optional learner.json ({"med/state": ..., "med/bank_x": ...}).
// Nothing here talks to Google or Cloudflare. Library data stays in <dir>, outside the repository.
import { readFileSync, existsSync } from 'node:fs';
// A simulated clock: each engine run is five minutes after the last, as on the cron.
const RealDate = Date; let FAKE = RealDate.now();
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FAKE])); } static now() { return FAKE; } };
const advance = () => { FAKE += 300000; };
import { join } from 'node:path';
import { d1 } from './d1shim.mjs';
import { mkTick } from '../../src/mkos/tick.js';
import { setSetting, mkInit } from '../../src/mkos/db.js';
import { status, graphValidation } from '../../src/mkos/governance.js';
import { validateCutover, appRegistryMap } from '../../src/mkos/cutover.js';
import { curriculumPlan, conceptContext, routeRequest } from '../../src/mkos/adaptive.js';
import { query } from '../../src/mkos/kb.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const W = arg('work', '/home/claude/mkos_work'), TICKS = Number(arg('ticks', 400));
const OWNER = 'owner-test';
const inv = readFileSync(join(W, 'inventory.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ROOT = inv.find((f) => !inv.some((g) => g.id === f.parentId)).parentId;
const byParent = {}; for (const f of inv) (byParent[f.parentId] = byParent[f.parentId] || []).push(f);
const J = (f) => JSON.parse(readFileSync(join(W, 'existing', f), 'utf8'));
const legacy = J('guidelines_registry_v6.json'), cert = J('abim_cert_blueprint.json'), lka = J('abim_lka_blueprint.json');
const idOf = (re) => (inv.find((f) => re.test(f.title)) || {}).id;
const jsonById = { [idOf(/^guidelines_registry_v\d+_CURRENT/)]: legacy, [idOf(/CERT_blueprint_registry/)]: cert, [idOf(/LKA_blueprint_registry/)]: lka };
const SAMPLE_ID = (legacy.sources.find((s) => /hypertension/i.test(s.short_label)) || {}).drive_file_id;
// The app's own blueprint document shape (med/blueprint) from the LKA registry.
const abimDoc = { cats: lka.categories.map((c) => ({ name: c.name, pct: c.exam_pct, topics: c.subcategories.flatMap((s) => s.topics.map((t) => ({ n: t[1], lf: t[3], sub: s.name, r: t[2] }))) })) };
const learner = existsSync(join(W, 'learner.json')) ? JSON.parse(readFileSync(join(W, 'learner.json'), 'utf8')) : {};
learner['med/libreg'] = { map: appRegistryMap(legacy), name: 'guidelines_registry_v6_CURRENT.json' };
learner['med/blueprint'] = abimDoc;
const SAMPLE = `# 5. Treatment
## 5.2 Pharmacologic treatment
| COR | LOE | Recommendations |
|---|---|---|
| 1 | A | 1. In adults with stage 2 hypertension, initiation of antihypertensive drug therapy is recommended to reduce cardiovascular events. |
| 2a | B-R | 2. In adults with stage 1 hypertension and lower risk, drug therapy after 3 to 6 months of lifestyle change is reasonable. |
| 3: Harm | A | 3. In adults with hypertension, simultaneous use of an ACE inhibitor and an ARB is potentially harmful. |
`;
const uploads = [];
const deps = {
  list: async (id, token) => { const all = byParent[id] || [], start = Number(token || 0); const files = all.slice(start, start + 100).map((f) => ({ id: f.id, title: f.title, mimeType: f.mimeType, parentId: f.parentId, fileSize: f.fileSize || '', md5: '', modifiedTime: f.modifiedTime || '' })); return { files, next: start + 100 < all.length ? String(start + 100) : '' }; },
  readText: async (id) => (id === SAMPLE_ID ? SAMPLE : '# Front matter\nShort text.'),
  readJson: async (id) => { if (!jsonById[id]) throw new Error('no json ' + id); return structuredClone(jsonById[id]); },
  findJson: async (q) => { const want = [...q.matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase()); const f = inv.find((x) => /json/.test(x.mimeType) && want.every((w) => x.title.toLowerCase().includes(w))); return f ? { id: f.id, title: f.title } : null; },
  upload: async (o) => { uploads.push({ name: o.name, bytes: o.text.length }); return o.id || 'up' + uploads.length; },
  mkdir: async (name) => 'dir_' + name, patch: async () => 'ok',
  folders: { registry: 'reg', oldVersions: 'old', mkos: 'mk' },
  userDocs: async (uid, prefixes) => Object.fromEntries(Object.entries(learner).filter(([p]) => prefixes.some((x) => (x.endsWith('_') ? p.startsWith(x) : p === x)))),
  ownerDocs: async (prefixes) => deps.userDocs(OWNER, prefixes),
  changedUsers: async () => [{ user_id: OWNER, updated: '2026-10-17T00:00:00Z' }],
  ai: null,
};
// --budget N runs at a fixed per-run query budget (e.g. 28 = Cloudflare's free plan); default is the maximum.
const BUDGET = Number(arg('budget', 900));
const env = { DB: d1(arg('db', ':memory:'), { strict: true }) };
await mkInit(env);
await setSetting(env, 'tick', JSON.stringify({ budget: BUDGET, capped: BUDGET < 880, capped_at: new Date().toISOString() }));
let t0 = RealDate.now(), last;
for (let i = 0; i < TICKS; i++) {
  last = await mkTick(env, deps, { root: ROOT, mirrorRoot: 'mkos-root' }); advance();
  if (last.error) { console.log('tick error', last.error); break; }
  const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_jobs WHERE state IN ('queued','running')").first()).n;
  const scan = await env.DB.prepare("SELECT v FROM mk_settings WHERE k = 'scan_last_complete'").first();
  if (i % 25 === 0) console.log('tick', i, 'used', last.used, 'open jobs', open, last.steps.slice(-3).join(' | '));
  if (scan && !open && i > 5) { console.log('settled after', i + 1, 'ticks'); break; }
}
console.log('time', ((RealDate.now() - t0) / 1000).toFixed(1) + 's', 'simulated days', ((FAKE - t0) / 864e5).toFixed(1));
const st = await status(env);
const agg = {}; for (const r of st.objects) agg[r.type] = (agg[r.type] || 0) + r.n;
console.log('objects', agg, 'edges', st.edges);
console.log('sources by class/ingest', st.ingest.map((r) => `${r.class}:${r.state}=${r.n}`).join(', '));
console.log('jobs', JSON.stringify(st.jobs));
const gv = await graphValidation(env); console.log('graph validation', gv.pass, JSON.stringify(Object.fromEntries(Object.entries(gv.checks).map(([k, v]) => [k, v.pass ? 'ok' : v]))).slice(0, 1500));
const cut = await validateCutover(env, deps, { learnerDocs: learner });
console.log('cutover', cut.pass, JSON.stringify(Object.fromEntries(Object.entries(cut.gates).map(([k, g]) => [k, g.pass]))));
for (const [k, g] of Object.entries(cut.gates)) if (!g.pass) console.log('  gate', k, JSON.stringify(g).slice(0, 1500));
console.log('citations', JSON.stringify({ resolved: cut.gates.citation_resolution.free_text_resolved, of: cut.gates.citation_resolution.free_text_citations, superseded: cut.gates.citation_resolution.citing_superseded_sources.map((s) => s.citation.slice(0, 60)) }));
const fam = await query(env, { type: 'Guideline', limit: 200 }); console.log('guideline families', fam.length, fam.filter((f) => f.editions.length > 1).map((f) => f.name + ' x' + f.editions.length).slice(0, 15));
const sup = await query(env, { type: 'Source', status: 'superseded', limit: 50 }); console.log('superseded sources', sup.map((s) => s.name.slice(0, 50)));
const recs = await query(env, { type: 'Recommendation', limit: 10 }); console.log('recommendations', recs.map((r) => `${r.strength_original}/${r.loe_original} -> ${r.strength}/${r.evidence_level} ${r.statement.slice(0, 50)}`));
const plan = await curriculumPlan(env, OWNER, { limit: 4 }); console.log('plan', JSON.stringify(Object.fromEntries(Object.entries(plan.plan).map(([k, v]) => [k, v.map((x) => x.name).slice(0, 4)]))));
const route = await routeRequest(env, OWNER, 'Essential hypertension'); console.log('route', route.decision, route.confidence, route.reasoning);
const cnode = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN json_array_length(json_extract(body,'$.concepts'))>0 THEN 1 ELSE 0 END) AS m FROM mk_objects WHERE type='CurriculumNode' AND id LIKE 'cn.t.%'").first(); console.log('curriculum topics mapped to concepts', cnode);
const lr = await env.DB.prepare('SELECT level, COUNT(*) AS n FROM mk_learner GROUP BY level').all(); console.log('learner states', JSON.stringify(lr.results));
console.log('uploads', uploads.length, uploads.slice(0, 6));
