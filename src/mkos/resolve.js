// Concept resolution (Ontology protection): text -> existing concept, deterministically, before anything new is created.
// Order: exact normalized name/alias -> abbreviation -> plural/singular and word-order variants -> trigram similarity.
// Only a confident match (>= AUTO) is used without review; weaker matches are returned as candidates.
import { norm } from './kb.js';
import { J } from './db.js';

export const AUTO = 0.92, CANDIDATE = 0.6;
const STOP = new Set(['of', 'the', 'and', 'in', 'with', 'a', 'an', 'to', 'for', 'disease', 'syndrome', 'disorder', 'disorders']);
const sing = (w) => w.length > 4 && /ies$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
export const keyOf = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w)).map(sing).sort().join(' ');
const grams = (s) => { const t = ' ' + s + ' ', g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
export function similarity(a, b) {
  const A = grams(norm(a)), B = grams(norm(b)); let n = 0; for (const g of A) if (B.has(g)) n++;
  return A.size + B.size ? (2 * n) / (A.size + B.size) : 0;
}

// Resolve one name among objects of the given types. Returns {id, confidence, method} or {candidates}.
export async function resolveName(env, text, { types = ['Concept'], conceptType = null } = {}) {
  const n = norm(text); if (!n) return { id: null, confidence: 0, method: 'empty' };
  const tq = `AND o.type IN (${types.map(() => '?').join(',')})`;
  const exact = (await env.DB.prepare(`SELECT a.id, a.kind, o.body FROM mk_aliases a JOIN mk_objects o ON o.id = a.id WHERE a.alias = ? ${tq} AND o.status IN ('current','modified')`).bind(n, ...types).all()).results;
  const fit = (rows) => conceptType ? rows.filter((r) => (J(r.body) || {}).concept_type === conceptType) : rows;
  let hit = fit(exact);
  if (hit.length === 1 || (hit.length > 1 && conceptType)) return { id: hit[0].id, confidence: hit[0].kind === 'name' ? 1 : 0.97, method: 'alias:' + hit[0].kind };
  if (hit.length > 1) {
    // Several objects share the name (a concept and its blueprint topics, say): the caller's first type wins when it is unique.
    const typeOf = (h) => (J(h.body) || {}).type, first = hit.filter((h) => typeOf(h) === types[0]);
    if (first.length === 1) return { id: first[0].id, confidence: first[0].kind === 'name' ? 0.99 : 0.96, method: 'alias:' + first[0].kind + ':preferred_type' };
    return { id: null, confidence: 0.6, method: 'ambiguous', candidates: hit.map((h) => ({ id: h.id, confidence: 0.6 })) };
  }
  // Word-order / plural variants share a key.
  const k = keyOf(text);
  const pool = (await env.DB.prepare(`SELECT o.id, o.name, o.body FROM mk_objects o WHERE o.norm LIKE ? ${tq} AND o.status IN ('current','modified') LIMIT 200`)
    .bind('%' + (n.split(' ').sort((x, y) => y.length - x.length)[0] || n).slice(0, 12) + '%', ...types).all()).results;
  const scored = fit(pool).map((r) => ({ id: r.id, name: r.name, confidence: keyOf(r.name) === k ? 0.95 : similarity(r.name, text) })).sort((a, b) => b.confidence - a.confidence);
  if (scored[0] && scored[0].confidence >= AUTO && (!scored[1] || scored[1].confidence < scored[0].confidence - 0.03)) return { id: scored[0].id, confidence: scored[0].confidence, method: 'variant' };
  return { id: null, confidence: scored[0]?.confidence || 0, method: 'unresolved', candidates: scored.filter((s) => s.confidence >= CANDIDATE).slice(0, 5) };
}

/* A free-text citation (as the AI writes them into lessons, questions and cards) -> the guideline family and edition it names.
   Year, organizations and topic words are read from the text; the family with the most topic overlap (and an organization in common,
   when the citation names any) wins. Returns {family, edition, cited_year, current_year, current_edition, status: 'current' | 'older_edition' |
   'newer_than_library' | 'unmatched', score}. families: Guideline objects; editions: id -> Source. */
const JOURNAL = new Set(['journal', 'cardiol', 'circulation', 'hypertension', 'lancet', 'annals', 'internal', 'medicine', 'stroke', 'chest', 'diabetes', 'arthritis', 'rheumatol', 'gastroenterol', 'hepatol', 'hepatology', 'gastroenterology', 'kidney', 'infect', 'clinical', 'infectious', 'diseases', 'respir', 'respiratory', 'critical', 'intensive', 'update', 'guideline', 'guidelines', 'practice', 'society', 'american', 'european', 'college', 'association', 'improving', 'global', 'outcomes', 'technical', 'standard']);
const citeWords = (t, topicWords) => {
  const names = new Set(); const re = /\b([A-Z][a-z]+)\s+[A-Z]{1,3}\b/g; let m; while ((m = re.exec(t))) names.add(m[1].toLowerCase());   // "Whelton PK"
  return new Set(topicWords(t).filter((w) => w.length > 4 && !names.has(w) && !JOURNAL.has(w)));
};
/* A free-text citation (as the AI writes them into lessons, questions and cards) -> the guideline family and edition it names.
   Topic words (author names, journal words and short tokens removed) must match a family's exactly; organizations, when the citation
   names any, must overlap. Returns {family, edition, cited_year, current_year, current_edition, status: 'current' | 'older_edition' |
   'newer_than_library' | 'unmatched'}. families: Guideline objects; editions: id -> Source. */
export function matchCitation(text, families, editions, { orgsOf, topicWords } = {}) {
  const t = String(text || ''), year = (t.match(/\b(19[89]\d|20[0-4]\d)\b/g) || []).map(Number).sort()[0] || null;
  const words = citeWords(t, topicWords), orgs = new Set(orgsOf(t));
  if (words.size < 2) return { status: 'unmatched', score: 0 };
  let best = null;
  for (const f of families) {
    const eds0 = (f.editions || []).map((id) => editions[id]).filter(Boolean);
    const fw = new Set([...citeWords(eds0.map((e) => e.title).join(' '), topicWords)].filter((w) => eds0.every((e) => citeWords(e.title, topicWords).has(w))));
    if (fw.size < 2) continue;
    const same = fw.size === words.size && [...fw].every((w) => words.has(w));
    const orgOk = !orgs.size || (f.responsible_orgs || []).some((o) => orgs.has(o));
    if (same && orgOk) { best = { f, score: 1 }; break; }
  }
  if (!best) return { status: 'unmatched', score: 0 };
  const eds = (best.f.editions || []).map((id) => editions[id]).filter(Boolean), yr = (s) => Number(s.year) || Number(String(s.published_online || s.issue_date || '').slice(0, 4)) || 0;
  const cur = editions[best.f.current_edition] || eds[0], curYear = cur ? yr(cur) : null;
  const same = year ? eds.find((e) => Math.abs(yr(e) - year) <= 1) : cur;
  const status = !year || !curYear ? 'current' : year < curYear - 1 && !same ? 'older_edition' : year > curYear + 1 ? 'newer_than_library' : same && same.status === 'superseded' ? 'older_edition' : 'current';
  return { family: best.f.id, family_name: best.f.name, edition: same ? same.id : null, cited_year: year, current_year: curYear, current_edition: cur ? cur.id : null, status, score: best.score };
}
