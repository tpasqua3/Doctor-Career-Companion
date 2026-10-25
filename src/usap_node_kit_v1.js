// USAP NODE KIT v1 — the one module an application adds when it connects to USAP.
// Source of truth: Master USAP Backend Brain / Ontological Framework Database / domain-sdk / usap_node_kit_v1.js
// Standard: domain-sdk/usap_node_connection_standard_v1.json. Do not fork per app; copy this file unchanged and
// configure it. Upgrades replace the file in every app at once.
//
// What it does (worker side, Cloudflare Workers):
//   1. registerApplication  — identifies the app to the USAP Governance Framework (UGF) on first use.
//   2. emitMetric / timeRequest / timeAI — telemetry. Observation only: never changes what the app does, never reorders
//      or retries AI providers, never throws into the app, never blocks a response (flushed with ctx.waitUntil).
//   3. emitEvent — USAP learning/system events (Level 3 of the compliance ladder; domain node apps only).
//   4. handleGovernance — the app's /api/usap/governance/* route that feeds the USAP-generated Settings > Governance
//      subsection, enforcing the shared access policy (owner + owner-granted users) on every call.
//   5. mcpTool — the standard 'usap_governance' connector tool, so the Claude artifact surface gets the same data.
//   6. serveUI — serves the shared renderer at /usap/ui.js (proxied from USAP), so the UI is never hard-coded per app.
//   7. onRemediate / handleRemediation — opt-in deterministic remediation hooks (UARF). The app registers only the
//      actions it allows; USAP can call nothing else, and actions blocked by a locked policy are always refused.
//
// Changes: 1.3.0 (2026-10-25) AI invocation record: timeAI also emits ai_invocation (latency) with governance dims
// feature, action, path (ai | hybrid), user_initiated, tokens; recordDeterministic(action) for deterministic hits. Labels and
// counts only (AI Governance framework, Brain governance/usap_ai_governance_ontology_v1.json).
// 1.2.0 (2026-10-24) handleClient (shared browser reporter: page load time, script errors, page views) and
// heartbeat (a daily zero for activity counters, so "no activity" is measured instead of looking like missing telemetry).
// 1.1.1 (2026-10-24) remediation endpoint: the binding marker is trusted only without CF-Connecting-IP (internet
// requests always carry it); key compared in constant time. 1.1.0 remediation hooks, MCP tool, access policy.
//
// Safe by default: with no UGF binding/URL configured the kit is a silent no-op (ugf_stage 'registered').
// Privacy: no user identity, user text, amounts or content ever leaves the app in telemetry. Access checks send only
// sha256(lowercased email).

export const KIT_VERSION = "1.3.0";

const DIMS_ALLOW = new Set(["route", "status_class", "provider", "model_id", "job", "outcome", "fell_back", "tool", "store",
  "database", "voice_kind", "surface", "subsystem", "tokens", "feature", "action", "path", "user_initiated"]);
const MAX_BUFFER = 500;
const ACCESS_TTL_MS = 60_000;
const LEVEL_RANK = { none: 0, view: 1, operate: 2, owner: 3 };
const OPS = { // op -> minimum access level; anything else is refused
  surface: "view", dashboard: "view", chart: "view", health: "view", findings: "view", recommendations: "view",
  debt: "view", reports: "view", report: "view", subsystem: "view", portfolio: "view",
  audits: "view", compliance: "view", remediations: "view",
  lifecycle: "operate", audit_run: "operate",
  remediation_decide: "owner", remediation_pause: "owner",
  access: "owner", access_grant: "owner", access_revoke: "owner", access_log: "owner",
};
const PORTFOLIO_OPS = new Set(["portfolio"]);

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + now());
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const statusClass = (s) => (s >= 500 ? "5xx" : s >= 400 ? "4xx" : s >= 300 ? "3xx" : "2xx");

async function sha256(text) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "").trim().toLowerCase()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cleanDims(dims) {
  const out = {};
  if (!dims || typeof dims !== "object") return out;
  for (const [k, v] of Object.entries(dims)) {
    if (!DIMS_ALLOW.has(k)) continue;
    if (typeof v === "boolean" || finite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 64); // low-cardinality labels only (route templates, model ids)
  }
  return out;
}

// config: {
//   appId:       registry app_id (required)
//   isOwner:     (env, user) => boolean   — the app's existing owner check (ADMIN_EMAIL / OWNER_EMAIL / isAdmin)
//   userEmail:   (user) => string|null    — how to read the signed-in user's email (default user.email)
//   routeLabel:  (url) => string          — collapse ids out of paths, e.g. /api/doc/123 -> /api/doc/:id (default: first 3 segments)
//   ugfBinding:  name of a Service Binding to the UGF worker (default "USAP_UGF")
//   ugfUrlVar / ugfKeyVar: env var names for URL + ingest key when no binding (default USAP_UGF_URL / USAP_INGEST_KEY)
//   lockedHooks: remediation hook names this app must never run (e.g. ["provider_circuit"] for MKOS, SR-03)
// }
export function createUsapNode(config) {
  if (!config || !config.appId) throw new Error("usap node kit: appId is required");
  const appId = config.appId;
  const isOwner = config.isOwner || (() => false);
  const userEmail = config.userEmail || ((u) => (u && u.email) || null);
  const routeLabel = config.routeLabel || ((url) => "/" + url.pathname.split("/").filter(Boolean).slice(0, 3).join("/"));
  const bindingName = config.ugfBinding || "USAP_UGF";
  const urlVar = config.ugfUrlVar || "USAP_UGF_URL";
  const keyVar = config.ugfKeyVar || "USAP_INGEST_KEY";

  let buffer = [];
  let registered = false;
  const accessCache = new Map(); // subjectHash -> {at, decision}
  const remediationHandlers = new Map();
  const lockedHooks = new Set(config.lockedHooks || []);
  const seenToday = new Map();   // activity counters with a positive value today (heartbeat)

  const transport = (env) => {
    const b = env && env[bindingName];
    if (b && typeof b.fetch === "function") return { kind: "binding", base: "https://ugf.internal", fetch: (u, i) => b.fetch(u, i), key: env[keyVar] || "" };
    if (env && env[urlVar]) return { kind: "url", base: String(env[urlVar]).replace(/\/$/, ""), fetch: (u, i) => fetch(u, i), key: env[keyVar] || "" };
    return null;
  };
  const ugf = async (env, path, init = {}) => {
    const t = transport(env);
    if (!t) return null;
    const headers = { "content-type": "application/json", "x-usap-app": appId, "x-usap-kit": KIT_VERSION, ...(t.key ? { authorization: "Bearer " + t.key } : {}), ...(init.headers || {}) };
    return t.fetch(t.base + "/api/v1/governance" + path, { ...init, headers });
  };

  function emitMetric(metricKey, value, dims, surface = "system") {
    try {
      if (typeof metricKey !== "string" || !finite(value)) return;
      if (buffer.length >= MAX_BUFFER) buffer.shift(); // drop oldest, never grow unbounded
      if (value > 0) seenToday.set(metricKey, iso().slice(0, 10));
      buffer.push({ event_id: uid(), app_id: appId, subsystem_key: (dims && typeof dims.subsystem === "string") ? dims.subsystem : null,
        metric_key: metricKey, value, surface, occurred_at: iso(), idempotency_key: uid(), dims: cleanDims(dims), kit_version: KIT_VERSION });
    } catch { /* never throw into the app */ }
  }

  const events = [];
  function emitEvent(eventType, ev = {}) {
    try {
      if (events.length >= MAX_BUFFER) events.shift();
      events.push({ event_id: uid(), event_type: String(eventType), schema_version: "1", user_id: ev.user_id ?? null, domain_id: ev.domain_id || null,
        app_id: appId, surface: ev.surface || "system", node_id: ev.node_id ?? null, previous_state: ev.previous_state ?? null,
        current_state: ev.current_state ?? null, mastery_change: ev.mastery_change ?? null, confidence_change: ev.confidence_change ?? null,
        occurred_at: ev.occurred_at || iso(), idempotency_key: ev.idempotency_key || uid(), metadata: ev.metadata || {} });
    } catch { /* never throw */ }
  }

  async function flush(env) {
    const metrics = buffer; buffer = [];
    const evs = events.splice(0, events.length);
    if (!metrics.length && !evs.length) return;
    try {
      if (!transport(env)) return; // not connected yet: drop silently (registered stage)
      if (!registered) {
        await ugf(env, "/apps/hello", { method: "POST", body: JSON.stringify({ app_id: appId, kit_version: KIT_VERSION, remediation_hooks: [...remediationHandlers.keys()], locked_hooks: [...lockedHooks] }) }).catch(() => null);
        registered = true;
      }
      if (metrics.length) await ugf(env, "/metrics/events", { method: "POST", body: JSON.stringify({ events: metrics }) });
      if (evs.length) await ugf(env, "/events", { method: "POST", body: JSON.stringify({ events: evs }) });
    } catch { /* telemetry loss is acceptable; app behavior is not affected */ }
  }
  const flushLater = (env, ctx) => { try { ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil(flush(env)) : flush(env); } catch { /* ignore */ } };

  // Wrap the worker's fetch handler. The app's response object is returned untouched.
  function timeRequest(handler) {
    return async function usapTimed(request, env, ctx) {
      const t0 = now();
      let url; try { url = new URL(request.url); } catch { url = null; }
      const measured = url && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp"));
      try {
        const res = await handler(request, env, ctx);
        if (measured) {
          const route = routeLabel(url), sc = statusClass(res && res.status || 200);
          emitMetric("api_latency_p50_ms", now() - t0, { route, status_class: sc });
          emitMetric("requests_total", 1, { route, status_class: sc });
          emitMetric("api_error_rate", sc === "5xx" ? 1 : 0, { route });
          if (url.pathname.startsWith("/mcp")) emitMetric("mcp_tool_calls", 1, {});
        }
        return res;
      } catch (err) {
        if (measured) { emitMetric("api_latency_p50_ms", now() - t0, { route: routeLabel(url), status_class: "5xx" }); emitMetric("api_error_rate", 1, { route: routeLabel(url) }); emitMetric("requests_total", 1, { status_class: "5xx" }); }
        throw err; // the app's own error handling is unchanged
      } finally {
        flushLater(env, ctx);
      }
    };
  }

  // Wrap ONE provider call. Returns exactly what fn returns and rethrows exactly what fn throws.
  // It does not choose, reorder, retry or skip providers (safe for locked routing such as MKOS SR-03).
  async function timeAI(fn, dims = {}) {
    const t0 = now();
    try {
      const out = await fn();
      try {
        emitMetric("ai_calls", 1, { ...dims, outcome: "ok" });
        emitMetric("ai_latency_p95_ms", now() - t0, { ...dims, outcome: "ok" });
        emitMetric("ai_fallback_rate", dims.fell_back ? 1 : 0, dims);
        const u = out && (out.usage || out.usageMetadata);
        const tokens = u && ((u.total_tokens ?? u.totalTokenCount) ?? ((u.input_tokens || u.prompt_tokens || 0) + (u.output_tokens || u.completion_tokens || 0)));
        if (finite(tokens) && tokens > 0) emitMetric("ai_tokens_total", tokens, dims);
        if (dims.action) emitMetric("ai_invocation", now() - t0, invocationDims(dims, out, tokens, "ok"));
      } catch { /* ignore */ }
      return out;
    } catch (err) {
      if (dims.action) emitMetric("ai_invocation", now() - t0, invocationDims(dims, null, null, "error"));
      emitMetric("ai_calls", 1, { ...dims, outcome: "error" });
      emitMetric("ai_latency_p95_ms", now() - t0, { ...dims, outcome: "error" });
      throw err;
    }
  }

  // ---- AI invocation record (1.3.0) ---------------------------------------------------------------------------------
  // dims for timeAI: { provider, model_id?, job?, feature, action: "<app>.<action>", path: "ai" | "hybrid", user_initiated: 1|0 }
  // USAP fills the governance category and expected path from the Brain catalog; the app reports only what happened.
  function invocationDims(dims, out, tokens, outcome) {
    const d = { feature: dims.feature, action: dims.action, path: dims.path === "hybrid" ? "hybrid" : "ai", user_initiated: dims.user_initiated ? 1 : 0,
      provider: dims.provider, model_id: dims.model_id || (out && typeof out === "object" && typeof out.model === "string" ? out.model : undefined), route: dims.route, job: dims.job, outcome };
    if (finite(tokens) && tokens > 0) d.tokens = Math.round(tokens);
    return d;
  }
  // A request a deterministic path answered without AI (retrieval hit, cache, rules) for an action that could have used AI.
  function recordDeterministic(action, { feature, route, user_initiated = 1, ms = 0 } = {}) {
    emitMetric("ai_invocation", finite(ms) ? ms : 0, { action, feature, route, path: "deterministic", user_initiated: user_initiated ? 1 : 0, outcome: "ok" });
  }

  // ---- governance access -----------------------------------------------------------------------------------------
  async function decide(env, user) {
    if (!user) return { role: "none", level: null, sections: [], portfolio: false, can_manage_access: false };
    let owner = false;
    try { owner = !!(await isOwner(env, user)); } catch { owner = false; }
    if (owner) return { role: "owner", level: "owner", sections: ["*"], portfolio: true, can_manage_access: true };
    const email = userEmail(user);
    if (!email) return { role: "none", level: null, sections: [], portfolio: false, can_manage_access: false };
    const subject = await sha256(email);
    const hit = accessCache.get(subject);
    if (hit && now() - hit.at < ACCESS_TTL_MS) return hit.decision;
    let decision = { role: "none", level: null, sections: [], portfolio: false, can_manage_access: false };
    try {
      const r = await ugf(env, `/access/decision?app_id=${encodeURIComponent(appId)}&subject=${subject}`);
      if (r && r.ok) {
        const d = await r.json();
        if (d && (d.level === "view" || d.level === "operate")) decision = { role: "grantee", level: d.level, sections: Array.isArray(d.sections) ? d.sections : [], portfolio: !!d.portfolio, can_manage_access: false };
      }
    } catch { /* fail closed */ }
    accessCache.set(subject, { at: now(), decision });
    return decision;
  }
  const allows = (decision, op, section) => {
    const need = OPS[op];
    if (!need) return false;
    if (LEVEL_RANK[decision.level || "none"] < LEVEL_RANK[need]) return false;
    if (PORTFOLIO_OPS.has(op) && !decision.portfolio) return false;
    if (section && !(decision.sections.includes("*") || decision.sections.includes(section))) return false;
    return true;
  };

  // Core dispatcher shared by the HTTP route and the MCP tool. Returns {status, body}.
  async function governanceCall(env, user, op, params = {}, method = "GET", payload = null) {
    const decision = await decide(env, user);
    if (op === "whoami") return { status: 200, body: { decision, app_id: appId, kit_version: KIT_VERSION, connected: !!transport(env) } };
    if (decision.role === "none") return { status: 404, body: { error: "Not found" } }; // hidden, not greyed out
    if (!allows(decision, op, params.section)) return { status: 403, body: { error: "Your access does not include this" } };
    if (!transport(env)) return { status: 200, body: { connected: false, message: "This app is registered with USAP; governance data appears once telemetry is connected." } };
    const q = new URLSearchParams({ app_id: appId, op, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) });
    const headers = { "x-usap-actor-level": decision.level, "x-usap-actor-portfolio": decision.portfolio ? "1" : "0", "x-usap-actor-sections": decision.sections.join(",") };
    try {
      const r = await ugf(env, `/app-surface?${q}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!r) return { status: 503, body: { error: "USAP unavailable" } };
      const body = await r.json().catch(() => ({}));
      if (op === "surface" && body && Array.isArray(body.settings_sections)) body.decision = decision;
      if (op.startsWith("access")) accessCache.clear();
      return { status: r.status, body };
    } catch { return { status: 503, body: { error: "USAP unavailable" } }; }
  }

  // HTTP: mount once in the app router. Returns a Response for /api/usap/governance/*, otherwise null.
  async function handleGovernance(request, env, ctx, user) {
    let url; try { url = new URL(request.url); } catch { return null; }
    if (!url.pathname.startsWith("/api/usap/governance")) return null;
    const op = url.pathname.replace(/^\/api\/usap\/governance\/?/, "").split("/")[0] || "surface";
    const params = Object.fromEntries(url.searchParams);
    let payload = null;
    if (request.method !== "GET" && request.method !== "HEAD") payload = await request.json().catch(() => null);
    const { status, body } = await governanceCall(env, user, op, params, request.method, payload);
    flushLater(env, ctx);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  // MCP: add to the app's existing tools/list and tools/call. Same permission check as the HTTP route.
  const mcpTool = {
    name: "usap_governance",
    description: "USAP governance data for this app (health, performance, AI usage, data, knowledge, technical debt, optimization, reports, access). Used by the app's Settings > Governance section.",
    inputSchema: { type: "object", properties: { op: { type: "string" }, params: { type: "object" }, method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] }, payload: { type: "object" } }, required: ["op"] },
    async call(env, user, args = {}) {
      const { status, body } = await governanceCall(env, user, String(args.op || "surface"), args.params || {}, args.method || "GET", args.payload || null);
      return { status, ...body };
    },
  };

  // Shared renderer at /usap/ui.js, proxied from USAP so it is never copied into app source (web + hub surfaces).
  async function serveUI(request, env) {
    let url; try { url = new URL(request.url); } catch { return null; }
    if (url.pathname !== "/usap/ui.js") return null;
    try {
      const r = await ugf(env, "/ui/renderer.js");
      if (r && r.ok) return new Response(r.body, { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
    } catch { /* fall through */ }
    return new Response("/* USAP governance UI unavailable */", { status: 200, headers: { "content-type": "text/javascript" } });
  }

  // ---- remediation hooks (UARF) ----------------------------------------------------------------------------------
  // Register a deterministic action the app allows USAP to trigger, e.g. kit.onRemediate("retry_persistence", fn).
  function onRemediate(name, fn) {
    if (typeof name !== "string" || typeof fn !== "function") return false;
    if (lockedHooks.has(name)) return false; // a locked policy wins over registration
    remediationHandlers.set(name, fn);
    return true;
  }
  // Route POST /api/usap/remediate from UGF only (service binding, or bearer = the app's ingest key).
  async function handleRemediation(request, env, ctx) {
    let url; try { url = new URL(request.url); } catch { return null; }
    if (url.pathname !== "/api/usap/remediate") return null;
    const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (request.method !== "POST") return J({ error: "method" }, 405);
    const key = env && env[keyVar];
    const auth = request.headers.get("authorization") || "";
    // 1.1.1: the binding marker alone is not proof. Cloudflare adds CF-Connecting-IP to every request that arrives from the
    // internet (and a client cannot remove it); a Worker-to-Worker Service Binding call does not carry it. So a request is
    // trusted as USAP's only if it has the marker AND no CF-Connecting-IP; otherwise it needs the ingest key (constant-time).
    const viaBinding = request.headers.get("x-usap-ugf") === "binding" && !request.headers.get("cf-connecting-ip") && env && env[bindingName];
    const want = key ? "Bearer " + key : "";
    let same = !!want && auth.length === want.length; if (same) { let x = 0; for (let i = 0; i < want.length; i++) x |= want.charCodeAt(i) ^ auth.charCodeAt(i); same = x === 0; }
    if (!viaBinding && !same) return J({ error: "unauthorized" }, 401);
    const body = await request.json().catch(() => ({}));
    const name = String(body.hook || "");
    if (lockedHooks.has(name)) return J({ ok: false, refused: "locked_policy", hook: name }, 409);
    const fn = remediationHandlers.get(name);
    if (!fn) return J({ ok: false, refused: "not_registered", hook: name }, 404);
    const t0 = now();
    try {
      const result = await fn(env, body.params || {}, { mode: body.mode === "verify" ? "verify" : "execute", actionId: body.action_id || null });
      emitMetric("remediations_executed", 1, { outcome: "ok", job: name });
      flushLater(env, ctx);
      return J({ ok: true, hook: name, mode: body.mode || "execute", result: result ?? null, ms: now() - t0 });
    } catch (err) {
      emitMetric("remediations_executed", 1, { outcome: "error", job: name });
      flushLater(env, ctx);
      return J({ ok: false, hook: name, error: String(err && err.message || err).slice(0, 200) }, 500);
    }
  }
  // ---- shared browser reporter (1.2.0) -----------------------------------------------------------------------------
  // The app routes POST /api/usap/client here (no sign-in needed: it carries numbers only). The page sends, once per load:
  //   { load_ms, errors, views }  -> frontend_load_ms, frontend_js_error_rate (1 if the load saw a script error), frontend_views
  // CLIENT_SNIPPET (below) is the page side; inline it in the page (it is plain JavaScript, no dependencies).
  async function handleClient(request, env, ctx) {
    let url; try { url = new URL(request.url); } catch { return null; }
    if (url.pathname !== "/api/usap/client") return null;
    const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (request.method !== "POST") return J({ error: "method" }, 405);
    let b = {}; try { const t = await request.text(); if (t.length > 2000) return J({ error: "too large" }, 413); b = JSON.parse(t || "{}"); } catch { return J({ error: "bad json" }, 400); }
    const surface = ["web", "claude_artifact", "lifeos_hub"].includes(b.surface) ? b.surface : "web";
    const ms = Number(b.load_ms), errs = Number(b.errors);
    if (finite(ms) && ms >= 0 && ms < 120000) emitMetric("frontend_load_ms", ms, { surface }, surface);
    if (finite(errs) && errs >= 0 && errs < 1000) emitMetric("frontend_js_error_rate", errs > 0 ? 1 : 0, { surface }, surface);
    emitMetric("frontend_views", 1, { surface }, surface);
    flushLater(env, ctx);
    return J({ ok: true });
  }

  // ---- daily heartbeat (1.2.0) --------------------------------------------------------------------------------------
  // Call once a day from the app's scheduled job. For each activity counter that had no events in this isolate today it
  // emits 0 (e.g. ai_calls 0 on a day nobody used the assistant), so USAP can tell "no activity" from "not wired".
  // Measurements that only exist when there is activity (latency, fallback rate, tokens) are judged by USAP against these
  // counters (metric registry `applies_when`), never faked.
  const _emit = emitMetric;
  function heartbeat(env, counters = ["ai_calls", "frontend_views", "mcp_tool_calls"], ctx = null) {
    const d = iso().slice(0, 10);
    for (const k of counters) if (seenToday.get(k) !== d) _emit(k, 0, { job: "heartbeat" });
    flushLater(env, ctx);
  }
  const remediationHooks = () => [...remediationHandlers.keys()];

  return { appId, KIT_VERSION, onRemediate, handleRemediation, remediationHooks, emitMetric, emitEvent, timeRequest, timeAI, flush, handleGovernance, mcpTool, serveUI, handleClient, heartbeat, recordDeterministic, _decide: decide };
}

// The page side of handleClient: inline this in the app's page (once). It posts load time, whether a script error happened
// and one view, once per page load. `base` is "" on the website; inside Claude pass the site URL or route it through the app's
// connector instead (the server side is the same).
export const CLIENT_SNIPPET = `(function(base,surface){var errs=0;addEventListener("error",function(){errs++},true);addEventListener("unhandledrejection",function(){errs++});addEventListener("load",function(){setTimeout(function(){try{var n=performance.getEntriesByType("navigation")[0];var ms=n?Math.round(n.loadEventEnd||n.domContentLoadedEventEnd||0):0;fetch(base+"/api/usap/client",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({load_ms:ms,errors:errs,views:1,surface:surface}),keepalive:true}).catch(function(){})}catch(e){}},0)})})("", "web");`;
