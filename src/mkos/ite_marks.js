// ITE pipeline change marks (ite.js): the write paths that move an ITE item along its trace mark the accounts whose trace must be
// recomputed, with one small insert. A lesson stored, a job queued, finished, failed or cancelled for a blueprint objective marks every
// account whose trace waits on that objective (mk_ite_watch); the engine run recomputes only those accounts (iteTick). Never throws:
// a mark that fails is caught up by the next page visit, which recomputes the account's trace itself.
const at = () => new Date().toISOString();

export async function markUser(env, userId, reason) {
  if (!userId) return;
  try { await env.DB.prepare('INSERT OR IGNORE INTO mk_ite_dirty (user_id, reason, marked_at) VALUES (?, ?, ?)').bind(String(userId), String(reason || '').slice(0, 60), at()).run(); } catch { /* table not created yet */ }
}

export async function markObjectives(env, ids, reason) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    try {
      await env.DB.prepare(`INSERT OR IGNORE INTO mk_ite_dirty (user_id, reason, marked_at) SELECT DISTINCT user_id, ?, ? FROM mk_ite_watch WHERE objective_id IN (${part.map(() => '?').join(',')})`)
        .bind(String(reason || '').slice(0, 60), at(), ...part).run();
    } catch { /* table not created yet */ }
  }
}

/* A generation job changed state: its objective's watchers (and the account that queued it) are recomputed. */
export async function markJob(env, jobId, reason) {
  try {
    const r = await env.DB.prepare('SELECT user_id, objective FROM mk_gen WHERE id = ?').bind(String(jobId)).first();
    if (!r || !r.objective) return;
    await markObjectives(env, [r.objective], reason);
    await markUser(env, r.user_id, reason);
  } catch { /* best effort */ }
}
