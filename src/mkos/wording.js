// PROMPT WORDING BY FAMILY (blueprints.json "wording"; Specialty Independence Doctrine). Generation prompts name the learner, the
// board and the field from the learner's or the blueprint's family, never from fixed text. A family's own `wording` is used as written
// (the ABIM internal medicine families carry the exact wording the prompts used before, so their prompts are unchanged); any other
// family is worded from its board_name and specialty with the templates.
import { FRAMEWORK } from './framework.js';

const BP = FRAMEWORK.frameworks.blueprints, W = BP.wording, SPEC = Object.fromEntries(FRAMEWORK.frameworks.specialties.specialties.map((s) => [s.id, s]));
const fam = (id) => BP.families.find((f) => f.id === id) || null;
export const defaultFamily = () => BP.default_family;
export function wordingFor(familyId) {
  const f = fam(familyId) || fam(BP.default_family) || {};
  if (f.wording) return { family: f.id, ...f.wording };
  const field = (SPEC[f.specialty] || {}).name ? SPEC[f.specialty].name.toLowerCase() : W.field_default, Field = field.charAt(0).toUpperCase() + field.slice(1);
  const fill = (t) => String(t).replace(/\{board_name\}/g, f.board_name || 'board examination').replace(/\{field\}/g, field).replace(/\{Field\}/g, Field);
  return { family: f.id || null, ...Object.fromEntries(Object.entries(W.templates).map(([k, t]) => [k, fill(t)])) };
}
/* The family of an exam key (cert, lka, ...) and the exam key of a family (bridge.js plan selection). */
export const examKeyOf = (familyId, fallback = 'cert') => (fam(familyId) || {}).exam_key || fallback;
export async function familyOfBlueprint(env, blueprintId) {
  if (!blueprintId) return null;
  const r = await env.DB.prepare('SELECT blueprint_family FROM mk_blueprint_registries WHERE blueprint_id = ?').bind(blueprintId).first();
  return r ? r.blueprint_family : null;
}
export async function learnerFamily(env, userId) {
  if (!userId) return null;
  const r = await env.DB.prepare('SELECT selected_blueprint_family AS f FROM mk_learner_blueprint WHERE learner_id = ?').bind(String(userId)).first().catch(() => null);
  return r ? r.f : null;
}
