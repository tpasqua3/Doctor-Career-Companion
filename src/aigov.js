/* USAP AI governance labels (node kit 1.3.0; Brain governance/usap_ai_governance_ontology_v1.json, catalog.actions, keys
   "doctor_companion_app.<action>"). Each AI call is labelled with the catalog action it belongs to, its feature, and whether a
   deterministic step ran first ("hybrid") or not ("ai"). Labels only: nothing here changes which service answers, the order of
   operations (SERVICES, TIERS, JOBS, AI_ORDER) or the MKOS budget. No prompt text, user id or anything personal leaves this file. */
export const GOV_APP = 'doctor_companion_app.';

/* action -> [feature, path]. `path` is "hybrid" only where the code guarantees a deterministic step ran first and found nothing. */
export const GOV_ACTIONS = {
  lesson_write: ['lesson', 'hybrid'],          // the page asks asset_find before writing
  lesson_lib_write: ['lesson', 'hybrid'],
  lesson_review: ['lesson', 'ai'],
  questions_write: ['questions', 'hybrid'],
  questions_review: ['questions', 'ai'],
  cards_write: ['flashcards', 'hybrid'],
  cards_review: ['flashcards', 'ai'],
  plan_build: ['study_plan', 'ai'],
  career_plan: ['career_plan', 'ai'],
  ite_report_extract: ['ite', 'ai'],
  ite_objective_map: ['ite', 'hybrid'],        // the page maps by topic and registry first; AI only for the items left
  notes_update: ['ask', 'ai'],
  ask_chat: ['ask', 'ai'],
  record_brief: ['mentor', 'ai'],              // not in the catalog: the mentor's briefing (a request with no job); USAP marks it Needs Review
  gen_lesson_write: ['lesson_queue', 'hybrid'], // queued only when no stored asset was found
  gen_lesson_review: ['lesson_queue', 'ai'],
  gen_questions_write: ['lesson_queue', 'ai'],
  gen_questions_review: ['lesson_queue', 'ai'],
  gen_cards_write: ['lesson_queue', 'ai'],
  gen_cards_review: ['lesson_queue', 'ai'],
  mkos_extract: ['mkos', 'hybrid'],
  mkos_enrich: ['mkos', 'ai'],
  mkos_pearls: ['mkos', 'ai'],
  mkos_pronounce: ['mkos', 'hybrid'],          // the owner's pronunciation list answers first; AI only for terms it lacks
  speak_tts: ['speech', 'ai'],
  doc_to_markdown: ['library', 'hybrid'],      // Google Doc export, plain text and the chapter cache come first
};

/* The runAI job (JOBS ids) -> action, for requests from the page (POST /api/ai and the connector's ask_ai). */
const BY_JOB = { lesson: 'lesson_write', lesson_lib: 'lesson_lib_write', questions: 'questions_write', cards: 'cards_write', review: 'lesson_review',
  plan: 'plan_build', report: 'ite_report_extract', notes: 'notes_update', chat: 'ask_chat' };

/* Governance dims for one call. `job` is runAI's resolved job, `rawJob` what the request said, `head` the start of the prompt (read
   here only to tell two actions of one job apart; never sent). `gov` may name the action ({ action, user_initiated, route }). */
export function govDims({ job, rawJob, chat, head, gov } = {}) {
  const g = gov && typeof gov === 'object' ? gov : {};
  let a = g.action && GOV_ACTIONS[g.action] ? g.action : '';
  if (!a) {
    const h = String(head || '').slice(0, 120);
    if (!rawJob && !chat) a = 'record_brief';
    else if (job === 'plan' && /^You are a career strategist/.test(h)) a = 'career_plan';
    else if (job === 'report' && /^You are mapping a physician's missed/.test(h)) a = 'ite_objective_map';
    else a = BY_JOB[job] || 'lesson_write';
  }
  const [feature, path] = GOV_ACTIONS[a];
  return { action: GOV_APP + a, feature, path, user_initiated: g.user_initiated === 0 ? 0 : 1, route: g.route || '/api/ai' };
}
/* The same, for a call that names its action (TTS, document conversion, MKOS background calls). */
export function govOf(action, { user_initiated = 1, route, path } = {}) {
  const [feature, p] = GOV_ACTIONS[action] || ['other', 'ai'];
  return { action: GOV_APP + action, feature, path: path || p, user_initiated: user_initiated ? 1 : 0, route: route || action };
}
