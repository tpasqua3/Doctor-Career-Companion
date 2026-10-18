// LARGE SOURCE ROUTING (Large Source Governance directive, 2026-10-18): file size never decides whether a source is processed, only how.
// A PDF too large to convert to text inside the Worker is read for its structure instead: its embedded table of contents (the PDF
// outline, "bookmarks") is parsed from a few byte ranges of the file, never the whole file, and becomes chapter, section and
// subsection records (SourceSection objects: titles, levels, page numbers), each linked to its source and to the concepts its title
// names. Only headings and page numbers are kept: no narrative text, nothing reproduced. A PDF with no embedded outline is still
// registered and mapped by its title, and listed as an exception ("no embedded table of contents") rather than failed.
//
// The parser reads: the trailer (last bytes) -> the cross-reference table or stream (and earlier ones via /Prev) -> the catalog ->
// /Outlines -> each item's /Title, /First, /Next and destination -> the page tree, to turn destinations into page numbers.
// Compressed object streams (/ObjStm) and Flate-compressed cross-reference streams are supported; encrypted files are not.

import { nowIso } from './db.js';
import { getObject, putObject, norm } from './kb.js';
import { addEdges } from './graph.js';

const dec = new TextDecoder('latin1');
const PDFDOC = { 0x80: '•', 0x81: '†', 0x82: '‡', 0x83: '…', 0x84: '—', 0x85: '–', 0x86: 'ƒ', 0x87: '⁄', 0x88: '‹', 0x89: '›', 0x8a: '−', 0x8b: '‰', 0x8c: '„', 0x8d: '“', 0x8e: '”', 0x8f: '‘', 0x90: '’', 0x91: '‚', 0x92: '™', 0x93: 'ﬁ', 0x94: 'ﬂ', 0x95: 'Ł', 0x96: 'Œ', 0x97: 'Š', 0x98: 'Ÿ', 0x99: 'Ž', 0x9a: 'ı', 0x9b: 'ł', 0x9c: 'œ', 0x9d: 'š', 0x9e: 'ž', 0xa0: '€' };

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---------- a small PDF object parser ----------
class Lexer {
  constructor(bytes, pos = 0) { this.b = bytes; this.p = pos; }
  ws() { const b = this.b; for (;;) { while (this.p < b.length && (b[this.p] <= 32)) this.p++; if (b[this.p] === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; } return; } }
  peek() { this.ws(); return this.b[this.p]; }
  delim(c) { return c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37; }
  word() { const s = this.p; while (this.p < this.b.length && !this.delim(this.b[this.p])) this.p++; return dec.decode(this.b.subarray(s, this.p)); }
  value() {
    this.ws(); const b = this.b, c = b[this.p];
    if (c === undefined) throw new Error('unexpected end of PDF data');
    if (c === 47) { this.p++; return { n: this.word().replace(/#([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))) }; }
    if (c === 40) return { s: this.literal() };
    if (c === 60 && b[this.p + 1] === 60) { this.p += 2; const d = {}; for (;;) { if (this.peek() === 62) { this.p += 2; return { d }; } const k = this.value(); if (!k || k.n === undefined) throw new Error('bad dictionary'); d[k.n] = this.value(); } }
    if (c === 60) { this.p++; const s = this.p; while (b[this.p] !== 62) this.p++; const hex = dec.decode(b.subarray(s, this.p)).replace(/[^0-9a-fA-F]/g, ''); this.p++; const out = new Uint8Array(Math.ceil(hex.length / 2)); for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.substr(i * 2, 2) + '0').slice(0, 2), 16); return { s: out }; }
    if (c === 91) { this.p++; const a = []; for (;;) { if (this.peek() === 93) { this.p++; return { a }; } a.push(this.value()); } }
    const w = this.word();
    if (w === 'true' || w === 'false') return { b: w === 'true' };
    if (w === 'null') return { z: true };
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // "12 0 R" is a reference
      const save = this.p; this.ws(); const s2 = this.p; const w2 = this.word();
      if (/^\d+$/.test(w) && /^\d+$/.test(w2)) { this.ws(); if (this.b[this.p] === 82 && this.delim(this.b[this.p + 1] ?? 32)) { this.p++; return { r: Number(w), g: Number(w2) }; } }
      this.p = save; void s2; return { i: Number(w) };
    }
    if (!w) { this.p++; return { z: true }; }
    return { k: w };
  }
  literal() {
    const b = this.b, out = []; let depth = 0; this.p++;
    for (; this.p < b.length; this.p++) {
      const c = b[this.p];
      if (c === 92) { const n = b[++this.p];
        if (n >= 48 && n <= 55) { let o = n - 48; for (let k = 0; k < 2 && b[this.p + 1] >= 48 && b[this.p + 1] <= 55; k++) o = o * 8 + (b[++this.p] - 48); out.push(o & 255); }
        else if (n === 13) { if (b[this.p + 1] === 10) this.p++; }
        else if (n !== 10) out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[n] ?? n);
        continue; }
      if (c === 40) depth++;
      if (c === 41) { if (!depth) { this.p++; break; } depth--; }
      out.push(c);
    }
    return Uint8Array.from(out);
  }
}
// PDF text strings: UTF-16BE with a byte order mark, UTF-8 with one, or PDFDocEncoding.
export function pdfText(u8) {
  if (!u8) return '';
  if (u8[0] === 0xfe && u8[1] === 0xff) { let s = ''; for (let i = 2; i + 1 < u8.length; i += 2) s += String.fromCharCode((u8[i] << 8) | u8[i + 1]); return s; }
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder().decode(u8.subarray(3));
  let s = ''; for (const c of u8) s += PDFDOC[c] || String.fromCharCode(c); return s;
}

// ---------- reading the file by byte ranges ----------
export async function pdfOutline(read, size, { maxItems = 4000, maxDepth = 4, maxReads = 600 } = {}) {
  let reads = 0;
  const cache = new Map();   // fixed 64 KB blocks
  const BLOCK = 65536;
  const block = async (i) => { if (cache.has(i)) return cache.get(i); if (++reads > maxReads) throw new Error('too many reads for this file'); const s = i * BLOCK, e = Math.min(size, s + BLOCK) - 1; const v = await read(s, e); cache.set(i, v); return v; };
  const bytes = async (start, len) => {
    const end = Math.min(size, start + len), out = new Uint8Array(end - start);
    for (let i = Math.floor(start / BLOCK); i * BLOCK < end; i++) { const b = await block(i), bs = i * BLOCK; const from = Math.max(start, bs), to = Math.min(end, bs + b.length); out.set(b.subarray(from - bs, to - bs), from - start); }
    return out;
  };
  // trailer
  const tailLen = Math.min(size, 4096), tail = dec.decode(await bytes(size - tailLen, tailLen));
  const sx = /startxref\s+(\d+)/g; let m, last = null; while ((m = sx.exec(tail))) last = Number(m[1]);
  if (last == null) throw new Error('no cross-reference table found');
  const offsets = new Map(), inStream = new Map(); let trailer = null;
  const seen = new Set();
  for (let at = last; at != null && !seen.has(at); ) {
    seen.add(at);
    let head = await bytes(at, 2048); const lx = new Lexer(head);
    if (dec.decode(head.subarray(0, 4)) === 'xref') {
      // classic table: subsections of "first count" then 20-byte entries
      let txt = '', len = 2048; for (;;) { txt = dec.decode(await bytes(at, len)); if (/trailer[\s\S]*>>/.test(txt) || at + len >= size) break; len *= 2; if (len > 8e6) break; }
      const ti = txt.indexOf('trailer'); const body = txt.slice(4, ti);
      const lines = body.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean); let num = 0;
      for (const l of lines) { const p = l.split(/\s+/); if (p.length === 2) { num = Number(p[0]); continue; } if (p.length >= 3) { if (p[2] === 'n' && !offsets.has(num) && !inStream.has(num)) offsets.set(num, Number(p[0])); num++; } }
      const tb = await bytes(at + ti + 7, Math.min(8192, size - at - ti - 7)); const t = new Lexer(tb).value().d || {};
      trailer = trailer || t;
      at = t.Prev ? t.Prev.i : null;
      if (t.XRefStm) { const r = await xrefStream(t.XRefStm.i); void r; }
      continue;
    }
    // cross-reference stream: "n g obj << ... >> stream"
    const r = await xrefStream(at); trailer = trailer || r; at = r.Prev ? r.Prev.i : null;
    void lx;
  }
  async function streamAt(off) {
    let len = 4096, head, lx, dict;
    for (;;) { head = await bytes(off, len); lx = new Lexer(head); try { lx.value(); lx.value(); lx.value(); dict = lx.value(); break; } catch (e) { if (len > 4e6) throw e; len *= 4; } }
    lx.ws(); const kw = lx.word(); if (kw !== 'stream') return { dict: dict.d || {}, data: null };
    if (head[lx.p] === 13) lx.p++; if (head[lx.p] === 10) lx.p++;
    let L = dict.d.Length; if (L && L.r != null) L = (await obj(L.r)); const n = L && L.i != null ? L.i : 0;
    const raw = await bytes(off + lx.p, n);
    const f = dict.d.Filter, filters = f ? (f.a ? f.a.map((x) => x.n) : [f.n]) : [];
    let data = raw; for (const x of filters) { if (x === 'FlateDecode') data = await inflate(data); else throw new Error('unsupported filter ' + x); }
    const dp = dict.d.DecodeParms; const pred = dp && (dp.d || (dp.a && dp.a[0] && dp.a[0].d));
    if (pred && pred.Predictor && pred.Predictor.i >= 10) data = unpredict(data, (pred.Columns && pred.Columns.i) || 1);
    return { dict: dict.d, data };
  }
  async function xrefStream(off) {
    const { dict, data } = await streamAt(off);
    const W = dict.W.a.map((x) => x.i), idx = dict.Index ? dict.Index.a.map((x) => x.i) : [0, dict.Size.i], row = W[0] + W[1] + W[2];
    let p = 0; const field = (w) => { let v = 0; for (let k = 0; k < w; k++) v = v * 256 + data[p++]; return v; };
    for (let s = 0; s < idx.length; s += 2) for (let n = idx[s], c = 0; c < idx[s + 1]; c++, n++) {
      if (p + row > data.length) break;
      const t = W[0] ? field(W[0]) : 1, a = field(W[1]), b = field(W[2]);
      if (offsets.has(n) || inStream.has(n)) continue;
      if (t === 1) offsets.set(n, a); else if (t === 2) inStream.set(n, { stm: a, idx: b });
    }
    return dict;
  }
  const objCache = new Map(), stmCache = new Map();
  async function obj(num) {
    if (objCache.has(num)) return objCache.get(num);
    let v = null;
    if (offsets.has(num)) {
      let len = 2048; for (;;) { const b = await bytes(offsets.get(num), len); try { const lx = new Lexer(b); lx.value(); lx.value(); lx.value(); v = lx.value(); break; } catch (e) { if (len >= 4e6 || offsets.get(num) + len >= size) { v = null; break; } len *= 4; } }
    } else if (inStream.has(num)) {
      const { stm } = inStream.get(num);
      let s = stmCache.get(stm);
      if (!s) { const { dict, data } = await streamAt(offsets.get(stm)); const N = dict.N.i, first = dict.First.i, lx = new Lexer(data); const map = new Map(); for (let k = 0; k < N; k++) { const on = lx.value().i, ofs = lx.value().i; map.set(on, first + ofs); } s = { data, map }; stmCache.set(stm, s); }
      if (s.map.has(num)) v = new Lexer(s.data, s.map.get(num)).value();
    }
    objCache.set(num, v); return v;
  }
  const deref = async (v) => (v && v.r != null ? obj(v.r) : v);
  if (!trailer) throw new Error('no trailer');
  if (trailer.Encrypt) return { items: [], reason: 'encrypted file' };
  const root = await deref(trailer.Root); if (!root || !root.d) throw new Error('no catalog');
  const outlines = await deref(root.d.Outlines);
  // page tree: page object number -> page number (1-based); walked lazily only when there is an outline
  const pageNum = new Map();
  async function walkPages() {
    let n = 0; const stack = [root.d.Pages]; const visited = new Set();
    while (stack.length && pageNum.size < 20000) {
      const ref = stack.pop(); if (!ref || ref.r == null || visited.has(ref.r)) continue; visited.add(ref.r);
      const node = await obj(ref.r); if (!node || !node.d) continue;
      if (node.d.Type && node.d.Type.n === 'Pages' || node.d.Kids) { const kids = (node.d.Kids && node.d.Kids.a) || []; for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]); }
      else pageNum.set(ref.r, ++n);
    }
  }
  const names = new Map();
  async function namedDest(name) {
    if (names.has(name)) return names.get(name);
    let d = null;
    const dests = await deref(root.d.Dests); if (dests && dests.d && dests.d[name]) d = await deref(dests.d[name]);
    if (!d) { const nm = await deref(root.d.Names); const tree = nm && nm.d && await deref(nm.d.Dests); if (tree) d = await nameTree(tree, name); }
    names.set(name, d); return d;
  }
  async function nameTree(node, key, depth = 0) {
    if (!node || !node.d || depth > 12) return null;
    if (node.d.Names) { const a = node.d.Names.a || []; for (let i = 0; i + 1 < a.length; i += 2) if (pdfText(a[i].s) === key) return deref(a[i + 1]); return null; }
    for (const k of (node.d.Kids && node.d.Kids.a) || []) { const kid = await deref(k); const lim = kid && kid.d && kid.d.Limits && kid.d.Limits.a; if (lim && (pdfText(lim[0].s) > key || pdfText(lim[1].s) < key)) continue; const r = await nameTree(kid, key, depth + 1); if (r) return r; }
    return null;
  }
  async function pageOf(item) {
    let d = item.Dest ? await deref(item.Dest) : null;
    if (!d && item.A) { const a = await deref(item.A); if (a && a.d && a.d.D) d = await deref(a.d.D); }
    if (d && (d.s || d.n)) d = await namedDest(d.s ? pdfText(d.s) : d.n);
    if (d && d.d && d.d.D) d = await deref(d.d.D);
    const first = d && d.a && d.a[0];
    if (first && first.r != null) return pageNum.get(first.r) || null;
    if (first && first.i != null) return first.i + 1;
    return null;
  }
  if (!outlines || !outlines.d || !outlines.d.First) return { items: [], reason: 'no embedded table of contents', reads };
  await walkPages();
  const items = []; const visited = new Set();
  async function walk(ref, level, parent) {
    for (let cur = ref; cur && cur.r != null && items.length < maxItems; ) {
      if (visited.has(cur.r)) break; visited.add(cur.r);
      const node = await obj(cur.r); if (!node || !node.d) break;
      const title = pdfText(node.d.Title && node.d.Title.s).replace(/\s+/g, ' ').trim();
      const me = items.length;
      if (title) items.push({ title: title.slice(0, 200), level, parent, page: await pageOf(node.d) });
      if (node.d.First && level < maxDepth) await walk(node.d.First, level + 1, title ? me : parent);
      cur = node.d.Next;
    }
  }
  await walk(outlines.d.First, 1, null);
  return { items, pages: pageNum.size, reads };
}

// PNG predictors (used by compressed cross-reference streams).
function unpredict(data, cols) {
  const row = cols + 1, out = new Uint8Array(Math.floor(data.length / row) * cols); let prev = new Uint8Array(cols);
  for (let r = 0; r * row < data.length; r++) {
    const t = data[r * row], cur = data.subarray(r * row + 1, r * row + 1 + cols), o = new Uint8Array(cols);
    for (let i = 0; i < cols; i++) { const a = i ? o[i - 1] : 0, b = prev[i], c = i ? prev[i - 1] : 0; let v = cur[i];
      if (t === 1) v += a; else if (t === 2) v += b; else if (t === 3) v += (a + b) >> 1; else if (t === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      o[i] = v & 255; }
    out.set(o, r * cols); prev = o;
  }
  return out;
}

// ---------- the index: outline -> SourceSection records ----------

/* What a heading names, by the alias index (no AI): concepts, domains, blueprint topics and curriculum nodes, longest match first.
   Returns [{id, type}]. Words like "Chapter 12:" and page furniture are ignored. */
const LINK_TYPES = ['Concept', 'Domain', 'BlueprintTopic', 'CurriculumNode'];
const REL_FOR = { Concept: 'covers', Domain: 'in_domain', BlueprintTopic: 'mapped_to_blueprint', CurriculumNode: 'covers' };
export async function linkHeading(env, title, max = 6) {
  const w = norm(String(title).replace(/^\s*(chapter|section|part|unit)\s+[\divxlc.]+\s*[:.-]?\s*/i, '')).split(' ').filter(Boolean), spans = new Set();
  for (let n = Math.min(6, w.length); n >= 1; n--) for (let i = 0; i + n <= w.length; i++) { const sp = w.slice(i, i + n).join(' '); if (sp.length >= 4 || n > 1) spans.add(sp); }
  const list = [...spans].slice(0, 180); if (!list.length) return [];
  const rows = [];
  for (let i = 0; i < list.length; i += 90) { const part = list.slice(i, i + 90);
    rows.push(...(await env.DB.prepare(`SELECT a.alias, a.id, o.type FROM mk_aliases a JOIN mk_objects o ON o.id = a.id WHERE o.type IN (${LINK_TYPES.map(() => '?').join(',')}) AND o.status IN ('current','modified') AND a.alias IN (${part.map(() => '?').join(',')})`).bind(...LINK_TYPES, ...part).all()).results); }
  rows.sort((a, b) => b.alias.length - a.alias.length);
  const out = [], used = [];
  for (const r of rows) { if (used.some((u) => u !== r.alias && u.includes(r.alias))) continue; used.push(r.alias); if (!out.some((o) => o.id === r.id)) out.push({ id: r.id, type: r.type }); if (out.length >= max) break; }
  return out;
}
const KIND = (level) => (level === 1 ? 'chapter' : level === 2 ? 'section' : 'subsection');
const short = (id) => String(id).replace(/^src\./, '').slice(0, 24);
// Confidence the outline maps a heading to a concept: an outline is the publisher's own structure (high); a title-only match less so.
const MAP_CONF = { pdf_outline: 75, title_only: 50 };

/* One slice of indexing a large source (job payload p keeps its place). First run reads the outline; later runs write up to `per`
   section records each. Returns {done, sections, method}. */
export async function indexLargeSource(env, deps, src, p, { per = 30, actor = 'indexer' } = {}) {
  if (!p.outline) {
    let r;
    if (!/pdf/i.test(src.mime_type || '') || !deps.readRange) r = { items: [], reason: !deps.readRange ? 'byte-range reading unavailable' : 'not a PDF: no outline to read' };
    else { try { r = await pdfOutline((s, e) => deps.readRange(src.drive_file_id, s, e), Number(src.bytes) || 0); } catch (e) { if (e.budget) throw e; r = { items: [], reason: 'outline could not be read: ' + String(e.message || e).slice(0, 120) }; } }
    p.outline = { items: r.items || [], reason: r.reason || null, pages: r.pages || null }; p.at = 0;
  }
  const items = p.outline.items, method = items.length ? 'pdf_outline' : 'title_only', at = nowIso();
  const prov = (note) => [{ source_id: src.id, method: 'structural_index', at, agent: actor, note }];
  const eprov = (note) => ({ source_id: src.id, method: 'structural_index', at, note: String(note || '').slice(0, 120) });
  const idOf = (i) => `ss.${short(src.id)}.${i}`;
  let n = 0;
  while (p.at < items.length && n < per) {
    const i = p.at, it = items[i], id = idOf(i), parent = it.parent == null ? src.id : idOf(it.parent);
    const links = await linkHeading(env, it.title, 6);
    await putObject(env, { id, type: 'SourceSection', name: it.title, source_id: src.id, section_kind: KIND(it.level), level: it.level, order: i, page: it.page || null, parent_id: parent,
      source_class: src.source_class || null, specialty: src.specialty || [], concepts: links.filter((l) => l.type === 'Concept').map((l) => l.id), mappings: links,
      governance_status: 'validated', provenance: prov(`outline item ${i}${it.page ? ', page ' + it.page : ''}`) },
      { actor, audited: false, aliases: false, summary: 'indexed from the table of contents' });
    await addEdges(env, [{ src: id, rel: 'part_of', dst: parent, conf: 95, prov: eprov('outline') }, ...links.map((l) => ({ src: id, rel: REL_FOR[l.type], dst: l.id, conf: MAP_CONF.pdf_outline, prov: eprov(it.title) }))]);
    p.at++; n++;
  }
  if (p.at < items.length) return { done: false, sections: p.at, of: items.length, method };
  // Finished: the source itself covers what its title names (always) and what its sections name; marked indexed, never failed.
  const tc = await linkHeading(env, String(src.title || src.name || '').replace(/\.(pdf|docx?|pptx?)$/i, ''), 4);
  if (tc.length) await addEdges(env, tc.map((l) => ({ src: src.id, rel: REL_FOR[l.type], dst: l.id, conf: MAP_CONF.title_only, prov: eprov('title') })));
  const cur = await getObject(env, src.id);
  await putObject(env, { ...cur, ingest_state: 'indexed', index_method: method, index_sections: items.length, index_pages: p.outline.pages, index_note: p.outline.reason || null,
    ingest_note: items.length ? `${items.length} chapters and sections indexed from the table of contents ${at.slice(0, 10)}` : `registered and mapped by title (${p.outline.reason}) ${at.slice(0, 10)}` },
    { actor, summary: 'indexed (large source, ' + method + ')', audited: false });
  return { done: true, sections: items.length, method, reason: p.outline.reason };
}
