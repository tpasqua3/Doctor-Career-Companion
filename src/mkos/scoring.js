// KNOWLEDGE FRESHNESS SCORING and the UNIVERSAL CONFIDENCE MODEL, as deterministic functions of an object's own fields.
// Every number comes from mkos/ontology/scoring.json (or the owner's central override of it).
import { FRAMEWORK } from './framework.js';
import { fwGet } from './db.js';

const F = FRAMEWORK.frameworks;
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(x * 10) / 10));
const CLASS = Object.fromEntries(F.source_classes.classes.map((c) => [c.key, c]));
export const sourceClass = (key) => CLASS[key] || CLASS.unclassified;
const LEVEL_SCORE = Object.fromEntries(F.ontology.evidence_model.levels.map((l) => [l.key, l.evidence_score]));

export function confidenceLevel(score, ovr) {
  for (const l of fwGet('scoring.confidence_levels', ovr)) if (score >= l.min) return l.level;
  return 'low';
}

// Years since a date string (YYYY, YYYY-MM or YYYY-MM-DD), from now.
export function ageYears(date) {
  const m = /^(\d{4})(?:-(\d\d))?(?:-(\d\d))?/.exec(String(date || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], m[2] ? +m[2] - 1 : 6, m[3] ? +m[3] : 1);
  return Math.max(0, (Date.now() - t) / (365.25 * 864e5));
}

export function freshness(date, specSourceType, status, ovr) {
  const fr = fwGet('scoring.freshness', ovr), age = ageYears(date);
  if (status === 'retired') return fr.retired_cap;
  const hl = fr.half_life_years[specSourceType] || fr.half_life_years.default;
  let s = age == null ? 50 : 100 * Math.pow(0.5, age / hl);
  if (status === 'superseded') return clamp(Math.min(s, fr.superseded_cap));
  if (status === 'current' || status === 'modified') s = Math.max(s, fr.floor_if_current);
  return clamp(s);
}

export function citationScore(o, ovr) {
  const w = fwGet('scoring.citation_score', ovr), d = o.data || o;
  let s = 0;
  if (d.doi) s += w.has_doi;
  if (d.page != null || d.section || (d.locator && (d.locator.page != null || d.locator.section))) s += w.has_page_or_section_locator;
  if (d.drive_file_id || d.source_id || (o.provenance || []).some((p) => p.source_id)) s += w.has_source_file;
  if (d.citation_verified || ['pdf', 'pdf+lookup'].includes(d.citation_source)) s += w.citation_verified_against_pdf;
  return clamp(s);
}

export function trust(scores, ovr) {
  const w = fwGet('scoring.trust_weights', ovr);
  let t = 0; for (const [k, v] of Object.entries(w)) t += (scores[k] ?? 50) * v;
  return clamp(t);
}

// Scores for a Source object.
export function scoreSource(src, ovr) {
  const c = sourceClass(src.source_class);
  const scores = {
    authority_score: c.base_authority,
    evidence_score: ['Guidelines', 'Consensus Statements'].includes(c.spec_source_type) ? 85 : c.spec_source_type === 'Review Articles' ? 60 : 55,
    citation_score: citationScore(src, ovr),
    freshness_score: freshness(src.published_online || src.issue_date || src.year, c.spec_source_type, src.status, ovr),
    supersession_score: fwGet('scoring.supersession_score', ovr)[src.status] ?? 50,
  };
  scores.trust_score = trust(scores, ovr);
  return scores;
}

// Scores for a Recommendation (or Claim) from its own grading and its source's scores.
export function scoreDerived(o, srcScores, ovr) {
  const lvl = o.evidence_level || 'C-EO';
  const scores = {
    authority_score: srcScores ? srcScores.authority_score : 50,
    evidence_score: LEVEL_SCORE[lvl] ?? 45,
    citation_score: citationScore(o, ovr),
    freshness_score: srcScores ? srcScores.freshness_score : 50,
    supersession_score: fwGet('scoring.supersession_score', ovr)[o.status] ?? 50,
  };
  // Confidence may not increase downstream: a derived object never outranks its source on authority or freshness.
  scores.trust_score = Math.min(trust(scores, ovr), srcScores ? srcScores.trust_score + 10 : 100);
  return scores;
}

// The confidence object (CONFIDENCE OBJECT fields) for a knowledge object.
export function knowledgeConfidence(o, scores, ovr) {
  let c = scores.trust_score;
  const ai = (o.provenance || []).some((p) => p.method === 'ai_extraction');
  if (ai && o.governance_status !== 'validated' && o.governance_status !== 'approved') c = Math.min(c, fwGet('scoring.ai_extraction_cap', ovr));
  if (o.governance_status === 'validated' || o.governance_status === 'approved') c = Math.min(100, c + fwGet('scoring.validated_bonus', ovr));
  return {
    confidence_score: clamp(c), confidence_type: 'trust', confidence_source: ai ? 'ai_extraction' : (o.provenance?.[0]?.method || 'derived'),
    evidence_count: (o.provenance || []).length, signal_strength: scores.evidence_score, data_density: Math.min(100, (o.provenance || []).length * 25),
    stability_score: scores.supersession_score, last_updated: new Date().toISOString(), calculation_method: 'scoring.trust_weights over the five knowledge scores; ai_extraction_cap until validated', version: '1',
    level: confidenceLevel(c, ovr),
  };
}

// Normalize a stated grade onto the five evidence levels and the strength scale. Original wording is always kept by the caller.
export function normalizeEvidence(loe, system) {
  const x = F.scoring.evidence_crosswalk, s = String(loe || '').trim();
  if (!s) return x.unstated;
  const tryMap = (m) => m && (m[s] || m[s.toUpperCase()] || m[s.toLowerCase()]);
  if (system && tryMap(x[system])) return tryMap(x[system]);
  for (const m of Object.values(x)) if (typeof m === 'object' && tryMap(m)) return tryMap(m);
  if (/^A/i.test(s)) return 'A'; if (/B-?R/i.test(s)) return 'B-R'; if (/B-?NR/i.test(s)) return 'B-NR'; if (/C-?LD/i.test(s)) return 'C-LD'; if (/C-?EO|expert/i.test(s)) return 'C-EO';
  if (/high/i.test(s)) return 'A'; if (/moderate/i.test(s)) return 'B-R'; if (/very low/i.test(s)) return 'C-EO'; if (/low/i.test(s)) return 'C-LD';
  return x.unstated;
}
export function normalizeStrength(cor, system) {
  const x = F.scoring.recommendation_strength_crosswalk, s = String(cor || '').trim();
  if (!s) return 'unstated';
  if (system && x[system] && x[system][s]) return x[system][s];
  for (const m of Object.values(x)) if (m[s]) return m[s];
  if (/^1$|class\s*1\b|class\s*i\b|strong/i.test(s)) return 'strong';
  if (/2a|iia|moderate/i.test(s)) return 'moderate';
  if (/2b|iib|weak|conditional/i.test(s)) return 'weak';
  if (/3.*harm|iii.*harm/i.test(s)) return 'against_strong';
  if (/3|iii|no benefit|against|not recommend/i.test(s)) return 'against_moderate';
  if (/insufficient|^i$/i.test(s)) return 'insufficient';
  return 'unstated';
}

// CONFIDENCE PROPAGATION RULE: downstream confidence is the minimum of the chain.
export const propagate = (...cs) => Math.min(...cs.filter((c) => typeof c === 'number'));
