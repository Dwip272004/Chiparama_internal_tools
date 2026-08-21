import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import cookieParser from "cookie-parser";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Default 100kb is too small for candidate payloads -- they carry the full
// raw LinkedIn + Apollo JSON blobs (linkedin_raw/apollo_raw) by design, so
// no enrichment data gets discarded. A real production candidate already
// exceeded 100kb and got rejected with "Payload Too Large" before this fix.
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const {
  N8N_BASE_URL,                                        // e.g. https://diwp645.app.n8n.cloud  (no trailing slash)
  N8N_API_KEY,                                          // n8n Settings > API > create an API key
  N8N_FORM_WEBHOOK_ID = "696576aa-5fbe-4b76-849d-fd81f5f0cb2a", // "Sourcing Request Form" node's webhookId
  N8N_WORKFLOW_ID = "jo9Q690CzrUwUZPv",
  N8N_ASSIGN_WEBHOOK_PATH = "assign-to-job",           // "Assign To Job Webhook" node's path
  SHEET_ID = "1Jss-cmGXu_8jMzplRZYJgYxPCkOncP0vTbbDwYEci7w", // the Candidates sourcing Google Sheet
  SEARCH_REQUESTS_TAB = "Search Requests",
  CANDIDATES_TAB = "Candidates",
  SUPABASE_URL = "https://ewbpejxknkagwxhceavx.supabase.co",   // "Chiparama Sourcing Desk" project
  SUPABASE_ANON_KEY = "sb_publishable_MPL4a2rIFziptvf1k8WN9Q_WUwarTxm", // publishable key -- safe to default, not a secret
  N8N_INTERNAL_KEY, // shared secret for n8n -> server.js internal writes -- set this on Render, no default

  // ---- Credit system: every threshold below is a config value, meant to be
  // tuned (raised, mostly) once real usage has been watched for a while
  // without LinkedIn flagging or Apollo/Seamless overspend. See
  // credit_system migration in Supabase for where these are actually used.
  SOURCING_CREDIT_MAX = "3",
  SOURCING_CREDIT_REGEN_MS = String(5 * 60 * 60 * 1000),   // 5h rolling regen
  EMAIL_CREDIT_MAX = "150",
  EMAIL_CREDIT_REGEN_MS = String(5 * 60 * 60 * 1000),      // 5h rolling regen
  TEAM_MAX_SEARCHES_PER_DAY = "40",
  TEAM_MAX_SEARCHES_PER_WINDOW = "12",
  TEAM_WINDOW_MS = String(5 * 60 * 60 * 1000),              // 5h pacing window
  TEAM_DAY_MS = String(24 * 60 * 60 * 1000),
  TEAM_MAX_CANDIDATES_PER_DAY = "600",
  DEDUPE_COOLDOWN_MS = String(6 * 60 * 60 * 1000),          // re-running the same search string within 6h is blocked

  PORT = 3000
} = process.env;

if (!N8N_BASE_URL || !N8N_API_KEY) {
  console.warn("[sourcing-desk] Missing N8N_BASE_URL or N8N_API_KEY env vars — set these on Render.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// A fresh client scoped to one user's access token, so Postgres RLS and
// auth.uid() inside the credit RPC functions resolve to that specific user
// -- the shared `supabase` client above (anon key only) can't do that.
function userClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

/**
 * Team members are added directly in the Supabase dashboard (Authentication
 * > Users) -- there's no self-serve sign-up page here on purpose. The
 * browser never touches Supabase directly either: login goes through our
 * own /api/auth/login, which mediates the session as httpOnly cookies, so
 * every page and every other /api/* route can be gated the same simple way.
 */
const AUTH_COOKIE = "sb-access-token";
const REFRESH_COOKIE = "sb-refresh-token";

function setAuthCookies(res, session) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(AUTH_COOKIE, session.access_token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: (session.expires_in || 3600) * 1000
  });
  res.cookie(REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookies(res) {
  res.clearCookie(AUTH_COOKIE);
  res.clearCookie(REFRESH_COOKIE);
}

function denyAuth(req, res) {
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated." });
  return res.redirect("/login.html");
}

async function requireAuth(req, res, next) {
  const token = req.cookies[AUTH_COOKIE];
  if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (data && data.user && !error) {
      req.user = data.user;
      req.supabaseToken = token; // lets routes build a user-scoped client for the credit RPCs
      return next();
    }
  }

  // Access token missing or expired -- try the longer-lived refresh token
  // before giving up, so a session doesn't die every hour.
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data && data.session) {
      setAuthCookies(res, data.session);
      req.user = data.session.user;
      req.supabaseToken = data.session.access_token;
      return next();
    }
  }

  clearAuthCookies(res);
  return denyAuth(req, res);
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      return res.status(401).json({ error: error?.message || "Invalid email or password." });
    }

    setAuthCookies(res, data.session);
    res.json({ ok: true, email: data.user?.email || email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get("/api/auth/session", async (req, res) => {
  const token = req.cookies[AUTH_COOKIE];
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Not authenticated." });
  res.json({ email: data.user.email });
});

// Gate every page and every other /api/* route behind a valid Supabase
// session -- the login page, the auth endpoints, and the internal n8n<->server
// routes (which have no browser session at all, see requireInternalKey below)
// are the only things that stay open here.
app.use((req, res, next) => {
  if (req.path === "/login.html" || req.path.startsWith("/api/auth/") || req.path.startsWith("/api/internal/")) return next();
  return requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, "public")));

/**
 * Guards the /api/internal/* routes n8n calls directly (no browser, no
 * Supabase session -- server-to-server). A shared secret, not real auth;
 * the actual Supabase writes happen through SECURITY DEFINER RPCs that
 * don't check auth.uid() for exactly this reason. Mirrors how the browser
 * never sees the Supabase key -- here, n8n never sees it either.
 */
function requireInternalKey(req, res, next) {
  if (!N8N_INTERNAL_KEY) {
    return res.status(500).json({ error: "N8N_INTERNAL_KEY is not configured on the server." });
  }
  if (req.headers["x-internal-key"] !== N8N_INTERNAL_KEY) {
    return res.status(401).json({ error: "Invalid or missing internal key." });
  }
  next();
}

function n8nHeaders() {
  return { "X-N8N-API-KEY": N8N_API_KEY, accept: "application/json" };
}

// ---- Internal routes: n8n -> server.js -> Supabase ----
// Replaces the workflow's old Google Sheets writes ("Log Search Request",
// "Append Candidate to Sheet", "Read Candidates for Summary"). server.js is
// the only thing holding the Supabase key -- n8n only ever calls its own
// server, same trust boundary as the browser never seeing the n8n API key.

app.post("/api/internal/search-requests", requireInternalKey, async (req, res) => {
  try {
    const f = req.body || {};
    const { data, error } = await supabase.rpc("insert_search_request", {
      p_boolean_search_string: f.booleanSearchString || null,
      p_location_region: f.locationRegion || null,
      p_role_context: f.roleContext || null,
      p_role_keywords: f.roleKeywords || null,
      p_skills_keywords: f.skillsKeywords || null,
      p_min_years_experience: f.minYearsExperience || null,
      p_seniority_level: f.seniorityLevel || null,
      p_network_distance: f.networkDistance || null,
      p_spotlights: f.spotlights || null,
      p_recruit_crm_job: f.recruitCrmJob || null,
      p_requester_email: f.requesterEmail || null,
      p_submitted_at: f.submittedAt || new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called once, by the workflow's own final node, when a run finishes --
// NOT polled. This is what lets the dashboard stop polling Render/n8n for
// status entirely: it can just watch this row (and the candidates table)
// directly in Supabase instead.
app.post("/api/internal/search-requests/:id/complete", requireInternalKey, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("mark_search_complete", {
      p_id: req.params.id,
      p_total_found_on_linkedin: (req.body && req.body.totalFoundOnLinkedIn) || null
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/internal/candidates", requireInternalKey, async (req, res) => {
  try {
    const c = req.body || {};
    if (!c.public_profile_url) {
      return res.status(400).json({ error: "public_profile_url is required." });
    }
    const { data, error } = await supabase.rpc("upsert_candidate", {
      p_search_request_id: c.search_request_id || null,
      p_global_index: c._global_index ?? c.global_index ?? null,
      p_name: c.name || null,
      p_headline: c.headline || null,
      p_location: c.location || null,
      p_current_title: c.current_role || null,
      p_current_company: c.current_company || null,
      p_public_profile_url: c.public_profile_url,
      p_talent_profile_url: c.talent_profile_url || null,
      p_network_distance: c.network_distance || null,
      p_email: c.email || null,
      p_email_status: c.email_status || null,
      p_fit_score: c.fit_score ?? null,
      p_ai_summary: c.ai_summary || null,
      p_matched_signals: c.matched_signals || null,
      p_gaps: c.gaps || null,
      p_sourced_at: c.sourced_at || new Date().toISOString(),
      p_recruitcrm_slug: c.recruitcrm_slug || null,
      p_linkedin_total_found: c.linkedin_total_found ?? null,
      p_search_keywords: c.search_keywords || null,
      p_skills: c.skills || null,
      p_seniority: c.seniority || null,
      p_industry: c.industry || null,
      p_connections_count: c.connections_count ?? null,
      p_profile_picture_url: c.profile_picture_url || null,
      p_certifications: c.certifications || null,
      p_projects: c.projects || null,
      p_languages: c.languages || null,
      p_employment_history: c.employment_history || null,
      p_organization_name: c.organization_name || null,
      p_organization_industry: c.organization_industry || null,
      p_organization_employee_count: c.organization_employee_count ?? null,
      p_organization_website: c.organization_website || null,
      p_organization_linkedin_url: c.organization_linkedin_url || null,
      p_organization_phone: c.organization_phone || null,
      p_organization_description: c.organization_description || null,
      p_twitter_url: c.twitter_url || null,
      p_github_url: c.github_url || null,
      p_linkedin_raw: c.linkedin_raw || null,
      p_apollo_raw: c.apollo_raw || null,
      p_seamless_raw: c.seamless_raw || null
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replaces "Read Candidates for Summary" -- scoped to just this run's
// candidates via search_request_id, instead of re-reading everything and
// matching by keyword string (which the old sheet-based approach had to do).
app.get("/api/internal/candidates", requireInternalKey, async (req, res) => {
  try {
    const searchRequestId = req.query.search_request_id;
    if (!searchRequestId) {
      // No search_request_id -- full-list mode, for reporting workflows
      // (e.g. the Daily Digest) that need to look across all candidates,
      // not just one run's.
      const candidates = await fetchAllRows(supabase, "candidates");
      return res.json({ candidates });
    }
    const { data, error } = await supabase.rpc("get_candidates_for_search", {
      p_search_request_id: searchRequestId
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ candidates: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/internal/search-requests", requireInternalKey, async (req, res) => {
  try {
    const requests = await fetchAllRows(supabase, "search_requests");
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Internal routes: outreach automation workflows -> server.js -> Supabase ----
// Replaces the 3 n8n Data Tables (Outreach Log, Candidate Stage Tracker,
// Templates) the 7 outreach workflows used to read/write directly. Same
// trust boundary as the Sourcing Desk routes above: n8n calls server.js,
// server.js is the only thing holding the Supabase key, writes go through
// SECURITY DEFINER RPCs.

app.post("/api/internal/outreach-log", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    const { data, error } = await supabase.rpc("insert_outreach_log", {
      p_candidate_id: b.candidateId || null,
      p_candidate_email: b.candidateEmail || null,
      p_template_id: b.templateId ?? null,
      p_sent_at: b.sentAt || new Date().toISOString(),
      p_target_role: b.targetRole || null
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/internal/outreach-log", requireInternalKey, async (req, res) => {
  try {
    const rows = await fetchAllRows(supabase, "outreach_log");
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/internal/outreach-log", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.candidateEmail) return res.status(400).json({ error: "candidateEmail is required." });
    const { data, error } = await supabase.rpc("update_outreach_log_replied", {
      p_candidate_email: b.candidateEmail
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rows: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/internal/stage-tracker", requireInternalKey, async (req, res) => {
  try {
    const { candidateId, jobId } = req.query;
    if (candidateId && jobId) {
      const { data, error } = await supabase
        .from("candidate_stage_tracker")
        .select("*")
        .eq("candidate_id", candidateId)
        .eq("job_id", jobId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ row: data || null });
    }
    const rows = await fetchAllRows(supabase, "candidate_stage_tracker");
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/internal/stage-tracker", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.candidateId) return res.status(400).json({ error: "candidateId is required." });
    const { data, error } = await supabase.rpc("upsert_stage_tracker", {
      p_candidate_id: b.candidateId,
      p_job_id: b.jobId || null,
      p_last_known_stage: b.lastKnownStage || null,
      p_last_template_sent: b.lastTemplateSent ?? null,
      p_last_checked_at: b.lastCheckedAt || new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/internal/templates", requireInternalKey, async (req, res) => {
  try {
    const { templateId, recruitCrmStage } = req.query;
    if (templateId !== undefined) {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .eq("template_id", templateId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ row: data || null });
    }
    if (recruitCrmStage !== undefined) {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .eq("recruit_crm_stage", recruitCrmStage)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ row: data || null });
    }
    const rows = await fetchAllRows(supabase, "templates");
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/internal/templates", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.templateId === undefined || b.templateId === null) return res.status(400).json({ error: "templateId is required." });
    const { data, error } = await supabase.rpc("upsert_template", {
      p_template_id: b.templateId,
      p_template_name: b.templateName || null,
      p_phase: b.phase || null,
      p_trigger_type: b.triggerType || null,
      p_subject: b.subject || null,
      p_body: b.body || null,
      p_placeholders_used: b.placeholdersUsed || null,
      p_recruit_crm_stage: b.recruitCrmStage || null
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/internal/stage-history", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.candidateId) return res.status(400).json({ error: "candidateId is required." });
    const { data, error } = await supabase.rpc("insert_stage_change", {
      p_candidate_id: b.candidateId,
      p_job_id: b.jobId || null,
      p_from_stage: b.fromStage || null,
      p_to_stage: b.toStage || null,
      p_template_sent: b.templateSent ?? null,
      p_changed_at: b.changedAt || new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/internal/stage-history", requireInternalKey, async (req, res) => {
  try {
    const rows = await fetchAllRows(supabase, "stage_change_history");
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: resets a user's credit balance to whatever values are given.
// Looks the user up by email via a SECURITY DEFINER RPC (auth.users is only
// reachable from inside Postgres, not via the anon-key REST client directly)
// -- deliberately avoids adding a Supabase service-role key to this server
// just for this, since the RPC already gets us there with no new secret.
app.post("/api/internal/reset-credits", requireInternalKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email) return res.status(400).json({ error: "email is required." });
    if (b.sourcingCredits == null || b.emailCredits == null) {
      return res.status(400).json({ error: "sourcingCredits and emailCredits are required." });
    }
    const { data, error } = await supabase.rpc("admin_reset_credits", {
      p_email: b.email,
      p_sourcing_credits: b.sourcingCredits,
      p_email_credits: b.emailCredits
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ row: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Credit system helpers ----

// Tracks an email-credit reservation from /api/submit through to the
// reconcile step in /api/results/:id. Keyed by our own requestId (not n8n's
// executionId, which isn't known yet at submit time) -- single Node process,
// so an in-memory Map is enough for this scale. Swept below so an abandoned
// reservation (client never loads results) doesn't strand credits forever.
const pendingReservations = new Map(); // requestId -> { token, emailBudget, createdAt, reconciled }

setInterval(() => {
  const staleBefore = Date.now() - 15 * 60 * 1000;
  for (const [id, r] of pendingReservations) {
    if (!r.reconciled && r.createdAt < staleBefore) {
      // Supabase's .rpc() builder is thenable (works with await) but doesn't
      // implement .catch() directly -- Promise.resolve(...) wraps it in a
      // real Promise first so chaining works.
      Promise.resolve(userClient(r.token).rpc("refund_email_credits", {
        amount: r.emailBudget,
        p_max: Number(EMAIL_CREDIT_MAX),
        p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
      })).then(() => pendingReservations.delete(id))
        .catch(() => {}); // best-effort -- regen will eventually cover it anyway
    }
  }
}, 5 * 60 * 1000).unref();

function normalizeSearchString(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Checks the Candidates sheet for a search with the same (normalized)
 * boolean string sourced within the cooldown window -- by anyone on the
 * team, not just the current user. Reuses the same sheet read the history
 * panel already does rather than a new table. Best-effort: if the sheet
 * read fails, we don't block submission on it (mirrors the existing
 * best-effort pattern for the Search Requests tab below).
 */
async function findRecentDuplicateSearch(normalizedString, cooldownMs) {
  try {
    const candidates = await fetchSheetRows(CANDIDATES_TAB);
    const cutoff = Date.now() - cooldownMs;
    let best = null;
    for (const c of candidates) {
      const key = normalizeSearchString(c["Search Keywords"]);
      if (key !== normalizedString) continue;
      const sourcedAt = c["Sourced At"] ? new Date(c["Sourced At"]).getTime() : null;
      if (!sourcedAt || sourcedAt < cutoff) continue;
      if (!best || sourcedAt > best.sourcedAt) best = { sourcedAt, searchString: c["Search Keywords"] };
    }
    if (!best) return null;

    const count = candidates.filter((c) => normalizeSearchString(c["Search Keywords"]) === normalizedString).length;
    return { searchString: best.searchString, count, sourcedAt: best.sourcedAt };
  } catch {
    return null; // sheet read failed -- don't block on a best-effort check
  }
}

function minutesUntil(iso) {
  if (!iso) return "a while";
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// TEMP DEBUG endpoint: confirms whether the browser's fetch to our own
// server is arriving with complete field data.
app.post("/api/debug-echo", (req, res) => {
  res.json({ receivedBody: req.body });
});

/**
 * Trigger the workflow by posting to its production Form Trigger webhook
 * (this is the same URL the public form page itself submits to — no n8n
 * auth needed here), then correlate the run with an execution record via
 * the n8n REST API so we have an id to poll.
 *
 * NOTE: the workflow must be ACTIVE in n8n for the production webhook to
 * respond. If it's still toggled off, activate it first.
 */
app.post("/api/submit", async (req, res) => {
  try {
    const fields = req.body || {};

    // Hard requirement check before we even talk to n8n — an empty submit
    // here previously slipped through silently and produced a workflow
    // error deep inside the LinkedIn search call instead of a clear message.
    if (!fields.booleanSearchString || !fields.locationRegion) {
      return res.status(400).json({ error: "Boolean search string and location are required." });
    }

    const userSupabase = userClient(req.supabaseToken);

    // ---- Credit system gates, cheapest/most-common rejection first ----

    // 1. Genuine counts: block re-running an identical search too soon --
    // it'd just re-hit LinkedIn for results we already have and pad stats.
    const normalized = normalizeSearchString(fields.booleanSearchString);
    const dup = await findRecentDuplicateSearch(normalized, Number(DEDUPE_COOLDOWN_MS));
    if (dup) {
      return res.status(409).json({
        code: "duplicate_search",
        error: `This exact search already pooled ${dup.count} candidate${dup.count === 1 ? "" : "s"} ${minutesUntil(new Date(dup.sourcedAt + Number(DEDUPE_COOLDOWN_MS)).toISOString())} ago or more recently — reuse it from the Sourcing history panel instead of re-running it.`
      });
    }

    // 2. Team-wide hard ceiling -- independent of personal balance, since
    // the whole team shares one LinkedIn seat.
    const { data: teamData, error: teamErr } = await userSupabase.rpc("check_and_record_team_search", {
      p_max_per_day: Number(TEAM_MAX_SEARCHES_PER_DAY),
      p_max_per_window: Number(TEAM_MAX_SEARCHES_PER_WINDOW),
      p_window_ms: Number(TEAM_WINDOW_MS),
      p_day_ms: Number(TEAM_DAY_MS),
      p_max_candidates_per_day: Number(TEAM_MAX_CANDIDATES_PER_DAY)
    });
    if (teamErr) return res.status(500).json({ error: teamErr.message });
    const teamRow = teamData && teamData[0];
    if (!teamRow || !teamRow.allowed) {
      return res.status(429).json({
        code: "team_limit",
        error: `Team-wide LinkedIn usage limit reached for now (${teamRow ? teamRow.reason : "unknown"}) — resets ${teamRow ? new Date(teamRow.resets_at).toLocaleString() : "soon"}.`,
        resetsAt: teamRow ? teamRow.resets_at : null
      });
    }

    // 3. Personal sourcing credit -- the friendly per-user gate.
    const { data: spendData, error: spendErr } = await userSupabase.rpc("spend_sourcing_credit", {
      p_max: Number(SOURCING_CREDIT_MAX),
      p_regen_ms: Number(SOURCING_CREDIT_REGEN_MS)
    });
    if (spendErr) return res.status(500).json({ error: spendErr.message });
    const spendRow = spendData && spendData[0];
    if (!spendRow || !spendRow.success) {
      return res.status(429).json({
        code: "no_sourcing_credits",
        error: `You're out of sourcing credits — more in ${spendRow ? minutesUntil(spendRow.next_full_at) : "a while"}.`,
        nextFullAt: spendRow ? spendRow.next_full_at : null
      });
    }

    // 4. Reserve an email-credit budget for this run. Not a hard block if
    // it comes back 0 -- the search still runs, it just won't enrich anyone
    // until credits regenerate. The workflow enriches at most this many
    // candidates (by search rank), so unused budget gets refunded once we
    // know how many were actually attempted (see /api/results/:id below).
    const { data: reserveData, error: reserveErr } = await userSupabase.rpc("reserve_email_credits", {
      requested: 100,
      p_max: Number(EMAIL_CREDIT_MAX),
      p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
    });
    if (reserveErr) return res.status(500).json({ error: reserveErr.message });
    const emailBudget = (reserveData && reserveData[0] && reserveData[0].granted) || 0;

    const requestId = randomUUID();
    pendingReservations.set(requestId, {
      token: req.supabaseToken,
      emailBudget,
      createdAt: Date.now(),
      reconciled: false
    });

    // n8n's Form Trigger does NOT use the field's real name (booleanSearchString,
    // locationRegion, etc.) as the multipart field name — it uses positional
    // keys matching the field's order in the form definition: field-0, field-1,
    // ... This was confirmed by capturing the real form page's own submit
    // request via browser devtools. This ordering must match the "Sourcing
    // Request Form" node's formFields.values array exactly.
    const FIELD_ORDER = [
      "booleanSearchString", // field-0
      "locationRegion",      // field-1
      "roleContext",         // field-2
      "roleKeywords",        // field-3
      "skillsKeywords",      // field-4
      "minYearsExperience",  // field-5
      "seniorityLevel",      // field-6
      "networkDistance",     // field-7
      "spotlights",          // field-8
      "recruitCrmJob",       // field-9
      "emailCreditBudget",   // field-10 -- caps how many candidates get Apollo/Seamless enrichment this run
      "requesterEmail"       // field-11 -- whoever's signed in, so the completion email always reaches them
    ];

    const form = new FormData();
    FIELD_ORDER.forEach((key, i) => {
      const value = key === "emailCreditBudget" ? emailBudget
        : key === "requesterEmail" ? (req.user && req.user.email)
        : fields[key];
      form.append(`field-${i}`, value !== undefined && value !== null ? String(value) : "");
    });

    // TEMP DEBUG: log exactly what's being sent to n8n. Check this in your
    // Render service logs after a test submit.
    console.log("[submit] forwarding positional fields to n8n:", Object.fromEntries(form.entries()));

    // Recorded BEFORE triggering the webhook, with a generous clock-skew
    // buffer — used by /api/find-execution to make sure a stale prior
    // execution is never mistaken for the one just triggered.
    const submitFloor = new Date(Date.now() - 10000).toISOString();

    const webhookUrl = `https://diwp645.app.n8n.cloud/form/696576aa-5fbe-4b76-849d-fd81f5f0cb2a`;
    const submitRes = await fetch(webhookUrl, { method: "POST", body: form });
    if (!submitRes.ok) {
      const text = await submitRes.text().catch(() => "");
      // The search itself never reached n8n -- refund both credits so a
      // webhook hiccup doesn't cost the user anything.
      pendingReservations.delete(requestId);
      await Promise.resolve(userSupabase.rpc("refund_email_credits", { amount: emailBudget, p_max: Number(EMAIL_CREDIT_MAX), p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS) })).catch(() => {});
      return res.status(502).json({
        error: `Webhook submit failed (${submitRes.status}). Is the workflow active? ${text.slice(0, 300)}`
      });
    }

    // Deliberately does NOT wait here to look up the execution id. A big
    // batch can now take several minutes end to end (100 candidates,
    // multi-page pagination) — blocking a single HTTP request/response
    // cycle on that would risk the browser or hosting platform's own
    // request timeout killing the connection, independent of whatever
    // timeout value we picked here. The dashboard instead polls
    // /api/find-execution itself, as many short-lived requests as it
    // takes, which has no such ceiling.
    res.json({ ok: true, submittedAt: submitFloor, requestId, emailBudget });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Single-shot lookup: is there an execution for this workflow that started
 * at/after `since`? No internal waiting loop — the dashboard calls this
 * repeatedly itself so no individual request can time out no matter how
 * long the actual n8n run takes.
 */
app.get("/api/find-execution", async (req, res) => {
  try {
    const since = req.query.since;
    if (!since) return res.status(400).json({ error: "Missing since parameter." });

    const listUrl = `${N8N_BASE_URL}/api/v1/executions?workflowId=${N8N_WORKFLOW_ID}&limit=50`;
    const listRes = await fetch(listUrl, { headers: n8nHeaders() });
    if (!listRes.ok) return res.status(listRes.status).json({ error: `Execution lookup failed (${listRes.status}).` });

    const data = await listRes.json();
    const executions = data.data || [];
    const candidates = executions.filter((e) => e.startedAt && e.startedAt >= since);

    if (!candidates.length) return res.json({ executionId: null });

    // Earliest among the qualifying ones — the first new execution to
    // appear after the submit, not just "newest overall".
    candidates.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    res.json({ executionId: candidates[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// executionId -> { at, progress } -- the last includeData:true fetch's
// derived progress numbers. Polling that payload (2-9+ MB once a run has
// pulled real candidates, since each one carries a full raw LinkedIn
// profile blob) on every single 3s poll for a run's whole multi-minute
// duration is what was driving Render's memory limit -- multiple heavy
// fetches/parses in flight at once, per concurrent search. Throttling the
// heavy fetch to once per STATUS_CACHE_TTL_MS keeps the same live progress
// readout while cutting the actual n8n payload volume by ~70%.
const statusProgressCache = new Map();
const STATUS_CACHE_TTL_MS = 8000;

app.get("/api/status/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const cached = statusProgressCache.get(id);
    const cacheFresh = cached && (Date.now() - cached.at) < STATUS_CACHE_TTL_MS;

    // Always check status/finished cheaply (no includeData -- tiny payload),
    // so "did it just finish or crash" is never delayed by the cache.
    const statusUrl = `${N8N_BASE_URL}/api/v1/executions/${id}`;
    const statusR = await fetch(statusUrl, { headers: n8nHeaders() });
    if (!statusR.ok) return res.status(statusR.status).json({ error: `Status check failed (${statusR.status})` });
    const statusData = await statusR.json();

    let progress = cached ? cached.progress : null;
    if (!cacheFresh) {
      const url = `${N8N_BASE_URL}/api/v1/executions/${id}?includeData=true`;
      const r = await fetch(url, { headers: n8nHeaders() });
      if (r.ok) {
        const data = await r.json();
        const runData = (data && data.data && data.data.resultData && data.data.resultData.runData) || {};

        function itemCount(nodeName) {
          const runs = runData[nodeName] || [];
          let count = 0;
          for (const run of runs) {
            const mainOut = (run && run.data && run.data.main && run.data.main[0]) || [];
            count += mainOut.length;
          }
          return count;
        }

        // "Split Candidates" fires once with the full pooled list — its single
        // run's item count is the total to work through. "Merge RecruitCRM
        // Slug" fires once per candidate that's fully scored, enriched, and
        // filed, so its cumulative run count is progress made so far.
        const totalCandidates = itemCount("Split Candidates") || null;
        const processedCandidates = itemCount("Merge RecruitCRM Slug");

        // True total LinkedIn Recruiter reports for this search, which can be
        // much larger than what got pulled into this batch.
        const searchRuns = runData["LinkedIn People Search"] || [];
        const searchOut = (searchRuns[0] && searchRuns[0].data && searchRuns[0].data.main && searchRuns[0].data.main[0] && searchRuns[0].data.main[0][0] && searchRuns[0].data.main[0][0].json) || null;
        const totalFoundOnLinkedIn = (searchOut && searchOut.paging && searchOut.paging.total_count) || null;

        progress = { totalCandidates, processedCandidates, totalFoundOnLinkedIn };
        statusProgressCache.set(id, { at: Date.now(), progress });
      }
    }

    // Finished executions (success/error/crashed) won't be polled again once
    // the frontend sees them, so there's no reason to keep their cache entry.
    if (statusData.finished) statusProgressCache.delete(id);

    res.json({
      status: statusData.status,
      finished: statusData.finished,
      totalCandidates: (progress && progress.totalCandidates) || null,
      processedCandidates: (progress && progress.processedCandidates) || 0,
      totalFoundOnLinkedIn: (progress && progress.totalFoundOnLinkedIn) || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Read a tab from the public Google Sheet via the gviz endpoint. This works
 * without any credentials as long as the sheet is shared as "Anyone with
 * the link can view" — the same mechanism Google uses for embedded charts.
 * If the sheet is later locked down, this will need a service account and
 * the official Sheets API instead.
 */
async function fetchSheetRows(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheet fetch failed for "${sheetName}" (${r.status}). Is it shared as "Anyone with the link"?`);
  const text = await r.text();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Unexpected response reading "${sheetName}" tab.`);
  const data = JSON.parse(text.slice(start, end + 1));
  const cols = data.table.cols.map((c) => c.label || c.id);
  return (data.table.rows || []).map((row) => {
    const obj = {};
    (row.c || []).forEach((cell, i) => {
      obj[cols[i]] = cell ? (cell.f !== undefined && cell.f !== null ? cell.f : cell.v) : null;
    });
    return obj;
  });
}

// Maps a Supabase `candidates` row (snake_case columns) into the shape the
// dashboard's candidate cards already expect -- `current_role` is kept as
// the output key even though the column is `current_title` (a reserved
// word in Postgres), so the frontend needed zero changes for this cutover.
// Also carries the newer curated fields through for the Profile tab.
function mapCandidateRow(c) {
  return {
    name: c.name || "",
    headline: c.headline || "",
    location: c.location || "",
    current_role: c.current_title || "",
    current_company: c.current_company || "",
    public_profile_url: c.public_profile_url || "",
    talent_profile_url: c.talent_profile_url || "",
    network_distance: c.network_distance || "",
    fit_score: c.fit_score === null || c.fit_score === undefined ? "" : c.fit_score,
    ai_summary: c.ai_summary || "",
    matched_signals: c.matched_signals || "",
    gaps: c.gaps || "",
    email: c.email || "",
    email_status: c.email_status || "",
    sourced_at: c.sourced_at || "",
    recruitcrm_slug: c.recruitcrm_slug || "",
    assigned_job: c.assigned_job || "",
    assigned_at: c.assigned_at || "",
    // Curated rich fields (skills, org info, etc.) -- powers the Profile tab.
    skills: c.skills || [],
    seniority: c.seniority || "",
    industry: c.industry || "",
    connections_count: c.connections_count ?? null,
    profile_picture_url: c.profile_picture_url || "",
    certifications: c.certifications || null,
    projects: c.projects || null,
    languages: c.languages || null,
    employment_history: c.employment_history || null,
    organization_name: c.organization_name || "",
    organization_industry: c.organization_industry || "",
    organization_employee_count: c.organization_employee_count ?? null,
    organization_website: c.organization_website || "",
    organization_linkedin_url: c.organization_linkedin_url || "",
    twitter_url: c.twitter_url || "",
    github_url: c.github_url || ""
  };
}

// PostgREST enforces a max-rows cap per request (1000 by default) at the
// project level -- .range() alone can't exceed it, only page within it. As
// candidate volume grows past that (already does today), this pages
// through in 1000-row windows until a short page signals the end.
async function fetchAllRows(userSupabase, table) {
  const pageSize = 1000;
  let offset = 0;
  const all = [];
  for (;;) {
    const { data, error } = await userSupabase.from(table).select("*").range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

app.get("/api/sheet-overview", async (req, res) => {
  try {
    const userSupabase = userClient(req.supabaseToken);
    const [requests, candidates] = await Promise.all([
      fetchAllRows(userSupabase, "search_requests"),
      fetchAllRows(userSupabase, "candidates")
    ]);

    const requestById = new Map((requests || []).map((r) => [r.id, r]));

    // Grouped by search_request_id now that every candidate is properly
    // linked to one (a real improvement over the old sheet's grouping by
    // keyword string, which merged together any searches that happened to
    // reuse the same boolean string). Falls back to keyword grouping only
    // for the rare candidate that somehow has no link.
    const bySearch = new Map();
    for (const c of candidates || []) {
      const key = c.search_request_id || `unlinked:${(c.search_keywords || "").toLowerCase()}`;
      if (!bySearch.has(key)) {
        bySearch.set(key, {
          count: 0, qualified: 0, scoreSum: 0, scoreCount: 0, lastSourced: null,
          candidates: [], totalFoundOnLinkedIn: null, searchKeywordsFallback: c.search_keywords || ""
        });
      }
      const bucket = bySearch.get(key);
      bucket.count += 1;
      const score = parseFloat(c.fit_score);
      if (!isNaN(score)) {
        bucket.scoreSum += score;
        bucket.scoreCount += 1;
        if (score > 60) bucket.qualified += 1;
      }
      if (!bucket.totalFoundOnLinkedIn && c.linkedin_total_found) bucket.totalFoundOnLinkedIn = c.linkedin_total_found;
      if (c.sourced_at && (!bucket.lastSourced || c.sourced_at > bucket.lastSourced)) bucket.lastSourced = c.sourced_at;
      bucket.candidates.push(mapCandidateRow(c));
    }
    // Show strongest fits first within each search group.
    for (const bucket of bySearch.values()) {
      bucket.candidates.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
    }

    const history = Array.from(bySearch.entries())
      .map(([key, stats]) => {
        const request = requestById.get(key);
        return {
          searchString: (request && request.boolean_search_string) || stats.searchKeywordsFallback || "(unknown search)",
          location: (request && request.location_region) || "",
          roleContext: (request && request.role_context) || "",
          submittedAt: (request && request.submitted_at) || stats.lastSourced,
          candidatesPooled: stats.count,
          qualifiedCount: stats.qualified,
          avgFitScore: stats.scoreCount ? Math.round(stats.scoreSum / stats.scoreCount) : null,
          lastSourcedAt: stats.lastSourced,
          totalFoundOnLinkedIn: stats.totalFoundOnLinkedIn,
          candidates: stats.candidates
        };
      })
      .sort((a, b) => new Date(b.lastSourcedAt || 0) - new Date(a.lastSourcedAt || 0));

    const totals = {
      totalSearches: history.length,
      totalCandidatesPooled: (candidates || []).length,
      totalQualified: (candidates || []).filter((c) => parseFloat(c.fit_score) > 60).length
    };

    res.json({ history, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fallback used when n8n's own execution record is unusable -- either the
 * worker crashed mid-run (see /api/status/:id's "crashed" handling, which
 * leaves n8n's own runData as synthetic recovery placeholders, not real
 * candidate data) or /api/find-execution never located the execution at
 * all within its polling window. search_requests/candidates are written to
 * Supabase early and independently of whether n8n's own execution record
 * survives, so this looks up the most recent search_requests row for the
 * signed-in user at/after `since` directly, sidestepping n8n entirely.
 */
app.get("/api/results-fallback", async (req, res) => {
  try {
    const since = req.query.since;
    if (!since) return res.status(400).json({ error: "Missing since parameter." });
    const email = req.user && req.user.email;
    if (!email) return res.status(401).json({ error: "Not signed in." });

    const requests = await fetchAllRows(supabase, "search_requests");
    const matches = requests.filter((r) => r.requester_email === email && r.submitted_at >= since);
    if (!matches.length) return res.json({ found: false });
    matches.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    const request = matches[0];

    const { data: candidateRows, error } = await supabase.rpc("get_candidates_for_search", {
      p_search_request_id: request.id
    });
    if (error) return res.status(500).json({ error: error.message });

    const candidates = (candidateRows || []).map(mapCandidateRow);
    const totalFoundOnLinkedIn = (candidateRows || []).reduce((acc, c) => acc || c.linkedin_total_found || null, null);

    res.json({ found: true, candidates, totalFoundOnLinkedIn, searchRequestId: request.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same credit reconciliation /api/results/:id used to do, but sourced from
// Supabase directly instead of n8n's execution data -- called exactly once
// by the dashboard right after it detects (via its own direct Supabase
// polling) that a search finished, so this never needs n8n/Render polling
// at all. requestId is server.js's own credit-reservation id from
// /api/submit; searchRequestId is the Supabase search_requests row id the
// dashboard found by watching that table directly.
app.post("/api/reconcile-credits", async (req, res) => {
  try {
    const { requestId, searchRequestId } = req.body || {};
    const reservation = requestId && pendingReservations.get(requestId);
    if (!reservation || reservation.reconciled) return res.json({ ok: true, reconciled: false });

    const { data: candidateRows, error } = await supabase.rpc("get_candidates_for_search", {
      p_search_request_id: searchRequestId
    });
    if (error) return res.status(500).json({ error: error.message });
    const candidates = candidateRows || [];

    const actuallyAttempted = candidates.filter((c) => c.email_status !== "skipped_credit_budget").length;
    const unused = Math.max(0, reservation.emailBudget - actuallyAttempted);
    const userSupabase = userClient(reservation.token);
    if (unused > 0) {
      await Promise.resolve(userSupabase.rpc("refund_email_credits", {
        amount: unused,
        p_max: Number(EMAIL_CREDIT_MAX),
        p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
      })).catch(() => {});
    }
    await Promise.resolve(userSupabase.rpc("record_team_candidates", {
      candidate_count: candidates.length,
      p_day_ms: Number(TEAM_DAY_MS)
    })).catch(() => {});
    reservation.reconciled = true;
    pendingReservations.delete(requestId);

    res.json({ ok: true, reconciled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/results/:id", async (req, res) => {
  try {
    const url = `${N8N_BASE_URL}/api/v1/executions/${req.params.id}?includeData=true`;
    const r = await fetch(url, { headers: n8nHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: `Results fetch failed (${r.status})` });
    const data = await r.json();

    const runData = (data && data.data && data.data.resultData && data.data.resultData.runData) || {};

    function nodeItems(nodeName) {
      const runs = runData[nodeName] || [];
      const items = [];
      for (const run of runs) {
        const mainOut = (run && run.data && run.data.main && run.data.main[0]) || [];
        for (const it of mainOut) if (it && it.json) items.push(it.json);
      }
      return items;
    }

    // "Merge RecruitCRM Slug" carries everything "Extract Enriched Email" has
    // plus recruitcrm_slug, needed so freshly-sourced candidates can be
    // selected for job assignment without waiting on a sheet refresh.
    const candidates = nodeItems("Merge RecruitCRM Slug");
    const summaryItems = nodeItems("Build CRM Upload Summary");
    const summary = summaryItems[0] || null;

    // The true total LinkedIn Recruiter reports matching this search (can be
    // far larger than the batch actually pulled/scored) — straight off the
    // raw search response, not something we compute.
    const searchItems = nodeItems("LinkedIn People Search");
    const totalFoundOnLinkedIn =
      (searchItems[0] && searchItems[0].paging && searchItems[0].paging.total_count) || null;

    // ---- Credit reconciliation ----
    // Refund whatever part of the reserved email budget went unused. The
    // workflow's credit-budget gate routes over-budget candidates through a
    // stub that sets email_status to "skipped_credit_budget" instead of
    // calling Apollo/Seamless -- reusing the existing email_status field
    // that already flows through "Extract Enriched Email" unchanged.
    const requestId = req.query.requestId;
    const reservation = requestId && pendingReservations.get(requestId);
    if (reservation && !reservation.reconciled) {
      const actuallyAttempted = candidates.filter((c) => c.email_status !== "skipped_credit_budget").length;
      const unused = Math.max(0, reservation.emailBudget - actuallyAttempted);
      const userSupabase = userClient(req.supabaseToken);
      if (unused > 0) {
        await Promise.resolve(userSupabase.rpc("refund_email_credits", {
          amount: unused,
          p_max: Number(EMAIL_CREDIT_MAX),
          p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
        })).catch(() => {});
      }
      await Promise.resolve(userSupabase.rpc("record_team_candidates", {
        candidate_count: candidates.length,
        p_day_ms: Number(TEAM_DAY_MS)
      })).catch(() => {});
      reservation.reconciled = true;
      pendingReservations.delete(requestId);
    }

    res.json({ candidates, summary, totalFoundOnLinkedIn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Live credit status for the signed-in user, plus the team-wide ceiling --
 * powers the meter in the dashboard's masthead. Balances are computed
 * on-read (lazy regen), so this is always accurate without a background job.
 */
app.get("/api/credits", async (req, res) => {
  try {
    const userSupabase = userClient(req.supabaseToken);
    const [personalRes, teamRes] = await Promise.all([
      userSupabase.rpc("get_credit_balance", {
        p_sourcing_max: Number(SOURCING_CREDIT_MAX),
        p_sourcing_regen_ms: Number(SOURCING_CREDIT_REGEN_MS),
        p_email_max: Number(EMAIL_CREDIT_MAX),
        p_email_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
      }),
      userSupabase.rpc("get_team_usage", {
        p_max_per_day: Number(TEAM_MAX_SEARCHES_PER_DAY),
        p_max_candidates_per_day: Number(TEAM_MAX_CANDIDATES_PER_DAY),
        p_day_ms: Number(TEAM_DAY_MS)
      })
    ]);

    if (personalRes.error) return res.status(500).json({ error: personalRes.error.message });
    if (teamRes.error) return res.status(500).json({ error: teamRes.error.message });

    const p = personalRes.data && personalRes.data[0];
    const t = teamRes.data && teamRes.data[0];

    res.json({
      sourcing: { balance: p.sourcing_credits, max: p.sourcing_max, nextFullAt: p.sourcing_next_full_at },
      email: { balance: p.email_credits, max: p.email_max, nextFullAt: p.email_next_full_at },
      team: {
        searchesUsedToday: t.searches_used_today,
        maxSearchesPerDay: t.max_searches_per_day,
        dayResetsAt: t.day_resets_at,
        candidatesTouchedToday: t.candidates_touched_today,
        maxCandidatesPerDay: t.max_candidates_per_day
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Assigns the recruiter's SELECTED candidates to a RecruitCRM job.
 *
 * Every sourced candidate is already created in RecruitCRM (unassigned) by
 * the main workflow — this endpoint does not create anything. It just
 * triggers the "Assign To Job Webhook" branch added to the n8n workflow,
 * which resolves the job name to a slug and calls RecruitCRM's
 * POST /v1/candidates/{slug}/assign for each selected candidate. Candidates
 * left unchecked are simply not touched, so they stay in RecruitCRM as
 * unassigned candidates — which is the desired default.
 */
app.post("/api/assign-job", async (req, res) => {
  try {
    const { jobQuery, candidates } = req.body || {};

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: "Select at least one candidate to assign." });
    }

    const cleanCandidates = candidates
      .filter((c) => c && c.slug)
      .map((c) => ({
        slug: c.slug,
        name: c.name || "",
        public_profile_url: c.public_profile_url || ""
      }));

    if (cleanCandidates.length === 0) {
      return res.status(400).json({
        error: "None of the selected candidates have a RecruitCRM slug yet — they may still be mid-run. Try again once the run finishes."
      });
    }

    // No job given — nothing to assign. Every sourced candidate is already
    // created in RecruitCRM as an unassigned candidate by the main workflow,
    // so this is a no-op confirmation rather than an error, and we skip
    // calling n8n entirely.
    if (!jobQuery || !String(jobQuery).trim()) {
      return res.json({
        skipped: true,
        jobName: null,
        assignedCount: 0,
        failedCount: 0,
        assignedNames: [],
        failedNames: [],
        message: `No job specified — the ${cleanCandidates.length} selected candidate${cleanCandidates.length === 1 ? "" : "s"} already exist in RecruitCRM as unassigned candidates.`
      });
    }

    const webhookUrl = `https://diwp645.app.n8n.cloud/webhook/${N8N_ASSIGN_WEBHOOK_PATH}`;
    const assignRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobQuery: String(jobQuery).trim(), candidates: cleanCandidates })
    });

    const text = await assignRes.text().catch(() => "");
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (!assignRes.ok) {
      return res.status(assignRes.status).json({ error: payload.error || `Assignment webhook failed (${assignRes.status}).` });
    }

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Sourcing desk proxy listening on port ${PORT}`));
