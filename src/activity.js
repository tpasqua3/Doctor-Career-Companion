// Activity events for Routine Rewards (roadmap Phase 5; specs/activity_events_contract.md, section 7 "As built").
// When a physician actually finishes something, the server sends one activity event through the USAP node kit (emitEvent,
// delivered over the USAP_UGF binding with the rest of the kit's traffic); USAP routes it to Routine Rewards.
//   StudySessionCompleted  a sitting in the study log (med/log: a lesson, a question set or a deck) that lasted a minute or more
//   QuestionSetCompleted   a question set finished (med/state `sets`), quantity = questions answered
//   LessonCompleted        a lesson marked complete (med/les_<id> `done` set)
//   ObjectiveCompleted     MKOS's learner model first puts a blueprint objective (blueprint_topic) in the Mastery state
// Completions are found where the server receives the save (the record before and after), so the website and the Claude copy
// need no page code. Only completions from now on: nothing older than RECENT is reported, and restores report nothing.
// Privacy: the subject (sha256 of the email) is computed at emit time, goes only in user_id and is never stored or logged.
// Metadata carries only duration_min, quantity, unit, category, label and objective_id: never titles, scores, names or emails.
export const APP = 'doctor_companion_app';
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const DAY = 864e5, RECENT = 3 * DAY, CAT = 'medical_study';

/* The person's ecosystem subject, or null when the account has no email (then nothing is sent). */
export async function subjectOf(email) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e || !e.includes('@')) return null;
  return 's1_' + await sha('lifeos-subject:v1:' + e);
}

/* The documents whose saves can hold a completion. */
export const watched = (path) => path === 'med/state' || path === 'med/log' || /^med\/les_[A-Za-z0-9_-]+$/.test(path);

const fresh = (t, now) => Number.isFinite(t) && t > now - RECENT && t < now + DAY;
const iso = (t, now) => new Date(Math.min(t, now)).toISOString();
const LOG_LABEL = { lesson: 'Medical lesson', quiz: 'Medical questions', cards: 'Medical flashcards' };

/* Pure: what one save completed. `before` is the stored body (null when there was none), `after` the body being saved. */
export function detect(path, before, after, now = Date.now()) {
  const out = [], A = after && typeof after === 'object' ? after : {}, B = before && typeof before === 'object' ? before : {};
  if (path === 'med/state') {
    const had = new Set((Array.isArray(B.sets) ? B.sets : []).map((s) => s && s.t));
    for (const s of Array.isArray(A.sets) ? A.sets : []) {
      const t = Number(s && s.t), n = Math.round(Number(s && s.n));
      if (had.has(s && s.t) || !fresh(t, now) || !(n > 0)) continue;
      out.push({ type: 'QuestionSetCompleted', rec: 'set-' + t, at: iso(t, now), metadata: { quantity: Math.min(n, 1000), unit: 'question', category: CAT, label: 'Medical questions' } });
    }
  } else if (path === 'med/log') {
    const had = new Set((Array.isArray(B.e) ? B.e : []).map((x) => x && x.t + ':' + x.k));
    for (const x of Array.isArray(A.e) ? A.e : []) {
      const t = Number(x && x.t), min = Number(x && x.min), k = String((x && x.k) || '').replace(/[^a-z]/g, '').slice(0, 12);
      if (had.has(x && x.t + ':' + x.k) || !fresh(t, now) || !(min >= 1)) continue;
      const end = t + Math.min(min, 600) * 60e3;
      out.push({ type: 'StudySessionCompleted', rec: 'log-' + t + '-' + (k || 'study'), at: iso(end, now),
        metadata: { duration_min: Math.round(Math.min(min, 600) * 10) / 10, quantity: 1, unit: 'session', category: CAT, label: LOG_LABEL[k] || 'Medical study' } });
    }
  } else if (/^med\/les_/.test(path)) {
    const t = Number(A.done);
    if (A.done && !B.done && fresh(t, now)) {
      const id = String(A.id || path.slice(8)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      out.push({ type: 'LessonCompleted', rec: 'les-' + id, at: iso(t, now), metadata: { quantity: 1, unit: 'lesson', category: CAT, label: 'Medical lesson' } });
    }
  }
  return out;
}

/* Pure: an objective MKOS has just put in the Mastery state (see deriveFromRecord in src/mkos/learner.js). */
export const objective = (id, name, now = Date.now()) => ({ type: 'ObjectiveCompleted', rec: 'obj-' + id, at: new Date(now).toISOString(),
  metadata: { objective_id: String(id).slice(0, 160), quantity: 1, unit: 'objective', category: CAT, label: String(name || 'Medical objective').slice(0, 80) } });

/* Stable per completion and per account, without the subject or the email: retries and re-saves never count twice. */
export async function keyOf(userId, f) {
  const tag = (await sha('dcc-activity:' + userId)).slice(0, 16);
  let rec = f.rec; if (rec.length > 60) rec = rec.slice(0, 4) + (await sha(rec)).slice(0, 32);
  return `${APP}:${tag}.${rec}:${f.type}`;
}

/* Sends the found completions for one account ({id, email}). Never throws; returns how many were queued in the kit. */
export async function emitActivity(usap, user, found) {
  try {
    if (!found || !found.length || !user || !user.id) return 0;
    const subject = await subjectOf(user.email);
    if (!subject) return 0;
    for (const f of found) usap.emitEvent(f.type, { user_id: subject, surface: 'system', occurred_at: f.at, idempotency_key: await keyOf(user.id, f), metadata: f.metadata });
    return found.length;
  } catch { return 0; }
}
