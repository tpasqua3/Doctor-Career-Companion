// Account standard section 7, "never block, always remind": the "Finish adding your info" popup of the app (app/companion.html) and
// the account page (public/account.html). The page code runs here against a tiny stand-in for the document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fakeDoc() {
  const els = {}, on = {};
  const el = id => ({ id, _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, get firstChild() { return this._html ? {} : null; }, querySelector: () => null });
  return {
    on, els,
    addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
    getElementById: id => els[id] || null,
    createElement: () => el(''),
    body: { appendChild: e => { els[e.id] = e; } },
  };
}
function appBlock(o = {}) {
  const html = readFileSync(new URL('../app/companion.html', import.meta.url), 'utf8');
  const a = html.indexOf('let FINME=null'), b = html.indexOf('const setupNote=');
  assert.ok(a > 0 && b > a, 'the reminder code is where it was');
  const document = fakeDoc(), calls = { render: 0, toast: [], fetch: [] };
  const run = new Function('document', 'esc', 'WEB', 'GOVSITE', 'render', 'toast', 'fetch', 'location', 'getProf', `let PROF=getProf();${html.slice(a, b)}; return { drawFin, finOpen, finSave, finLine, finMissing, get open(){return FINOPEN}, set me(m){FINME=m;FINOPEN=true} };`);
  const api = run(document, esc, o.web !== false, 'https://dcc.example', () => calls.render++, t => calls.toast.push(t),
    async (url, init) => { calls.fetch.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, setup: { complete: true, missing: [] }, password: true }) }; },
    { replace() { throw new Error('no redirect expected'); } }, () => null);
  return { api, document, calls };
}
const incomplete = { email: 'nia@example.com', firstName: 'Nia', lastName: 'Park', password: false, questions: ['What city were you born in?'], setup: { complete: false, missing: ['password', 'question'] } };
const click = (doc, fin) => doc.on.click.forEach(fn => fn({ target: { closest: s => s === '[data-fin]' ? { dataset: { fin } } : null }, preventDefault() { }, stopPropagation() { } }));

test('the app shows the popup when something is missing, with Save and Remind me later, and only what is missing', () => {
  const { api, document } = appBlock();
  api.me = incomplete; api.drawFin();
  const pop = document.els.finpop.innerHTML;
  assert.match(pop, /Finish adding your info/); assert.match(pop, /Remind me later/); assert.match(pop, />Save</);
  assert.match(pop, /missing a password and a security question/);
  assert.match(pop, /id="fin-pw"/); assert.match(pop, /id="fin-pw2"/); assert.match(pop, /id="fin-sq"/);
  assert.match(pop, /value="nia@example.com" readonly/);
  /* An older account that only lacks a question is asked only for that. */
  const b = appBlock(); b.api.me = { ...incomplete, password: true, setup: { complete: false, missing: ['question'] } }; b.api.drawFin();
  const p2 = b.document.els.finpop.innerHTML;
  assert.match(p2, /id="fin-sq"/); assert.doesNotMatch(p2, /fin-pw/); assert.doesNotMatch(p2, /fin-first/);
  /* A complete account gets no popup. */
  const c = appBlock(); c.api.me = { ...incomplete, setup: { complete: true, missing: [] } }; c.api.drawFin();
  assert.equal(c.document.els.finpop.innerHTML, ''); assert.equal(c.api.open, false);
});

test('"Remind me later" closes it for this app open; the Profile button opens it again; there is no way to turn it off', () => {
  const { api, document } = appBlock();
  api.me = incomplete; api.drawFin(); assert.ok(document.els.finpop.innerHTML);
  click(document, 'later'); assert.equal(document.els.finpop.innerHTML, ''); assert.equal(api.open, false);
  const line = api.finLine(incomplete);
  assert.match(line, /Your account is missing: a password and a security question\./); assert.match(line, /data-fin="open"/);
  api.finOpen(incomplete); assert.match(document.els.finpop.innerHTML, /Finish adding your info/);
  assert.doesNotMatch(readFileSync(new URL('../app/companion.html', import.meta.url), 'utf8'), /setup\.complete===false\)\{location\.replace/, 'no forced redirect to the setup screen');
});

test('inside Claude the popup never opens (the connector sets no passwords); the Profile line links to the website', () => {
  const { api, document } = appBlock({ web: false });
  api.me = incomplete; api.drawFin(); assert.equal(document.els.finpop.innerHTML, '');
  assert.match(api.finLine(incomplete), /href="https:\/\/dcc\.example\/account\.html" target="_blank"/);
});

test('Save sends the setup form to POST /api/account/setup and closes the popup once complete', async () => {
  const { api, document, calls } = appBlock();
  api.me = incomplete; api.drawFin();
  const vals = { 'fin-first': 'Nia', 'fin-last': 'Park', 'fin-pw': 'nia-password', 'fin-pw2': 'nia-password', 'fin-sq': 'What city were you born in?', 'fin-sa': 'Rome', 'fin-gender': '', 'fin-self': '', 'fin-dob': '' };
  for (const [id, value] of Object.entries(vals)) document.els[id] = { value };
  document.els['fin-msg'] = { innerHTML: '' }; document.els['fin-save'] = {};
  await api.finSave();
  assert.equal(calls.fetch[0][0], '/api/account/setup');
  assert.deepEqual(calls.fetch[0][1], { firstName: 'Nia', lastName: 'Park', gender: '', genderSelf: '', dob: '', password: 'nia-password', confirm: 'nia-password', question: 'What city were you born in?', answer: 'Rome' });
  assert.equal(api.open, false); assert.equal(document.els.finpop.innerHTML, ''); assert.match(calls.toast[0], /complete/);
  /* Mismatched passwords never reach the server. */
  const b = appBlock(); b.api.me = incomplete; b.api.drawFin();
  for (const [id, value] of Object.entries({ ...vals, 'fin-pw2': 'other-pass' })) b.document.els[id] = { value };
  b.document.els['fin-msg'] = { innerHTML: '' }; await b.api.finSave();
  assert.equal(b.calls.fetch.length, 0); assert.match(b.document.els['fin-msg'].innerHTML, /do not match/);
});

test('the account page reminds instead of blocking: popup once per page load, a persistent missing line, Remind me later', () => {
  const html = readFileSync(new URL('../public/account.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /setup\.complete===false\?setupView\(\):home\(\)/, 'the setup screen no longer replaces the page');
  const a = html.indexOf('const MISSING='), b = html.indexOf('function home(){');
  assert.ok(a > 0 && b > a);
  const page = new Function('esc', 'demoFields', 'pwPair', 'qFields', 'getMe', `let me=getMe();${html.slice(a, b)}; return { setupView, missingLine };`)(esc, () => '<demo>', () => '<input id="pw">', () => '<select id="sq">', () => incomplete);
  assert.match(page.missingLine(), /Your account is missing: a password and a security question\./); assert.match(page.missingLine(), /data-act="remind"/);
  const v = page.setupView(); assert.match(v, /Finish adding your info/); assert.match(v, /data-act="later">Remind me later/); assert.match(v, />Save</);
  assert.match(html, /if\(me&&!reminded&&missingOf\(\)\.length\)\{reminded=true;remind=true\}/, 'shown once per page load or sign-in');
  assert.match(html, /if\(a==='later'\)\{remind=false;return draw\(\)\}/);
});
