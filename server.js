import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import cookieParser from "cookie-parser";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
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
// session -- only the login page and the auth endpoints themselves stay open.
app.use((req, res, next) => {
  if (req.path === "/login.html" || req.path.startsWith("/api/auth/")) return next();
  return requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, "public")));

function n8nHeaders() {
  return { "X-N8N-API-KEY": N8N_API_KEY, accept: "application/json" };
}

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
      userClient(r.token).rpc("refund_email_credits", {
        amount: r.emailBudget,
        p_max: Number(EMAIL_CREDIT_MAX),
        p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
      }).then(() => pendingReservations.delete(id))
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
      "emailCreditBudget"    // field-10 -- caps how many candidates get Apollo/Seamless enrichment this run
    ];

    const form = new FormData();
    FIELD_ORDER.forEach((key, i) => {
      const value = key === "emailCreditBudget" ? emailBudget : fields[key];
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
      await userSupabase.rpc("refund_email_credits", { amount: emailBudget, p_max: Number(EMAIL_CREDIT_MAX), p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS) }).catch(() => {});
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

app.get("/api/status/:id", async (req, res) => {
  try {
    // includeData:true costs a bit more per poll but is the only way to see
    // how many candidates have been found vs. fully processed so far, which
    // is what turns the dashboard's ledger from a blind spinner into a real
    // progress readout.
    const url = `${N8N_BASE_URL}/api/v1/executions/${req.params.id}?includeData=true`;
    const r = await fetch(url, { headers: n8nHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: `Status check failed (${r.status})` });
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

    res.json({
      status: data.status,
      finished: data.finished,
      totalCandidates,
      processedCandidates,
      totalFoundOnLinkedIn
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

// Combines the Search Requests + Candidates tabs into a reusable search
// history: each past boolean search string, how many candidates it pooled,
// how many cleared the fit-score bar, and average fit score.
// Maps a raw Google Sheet row (keyed by column header) into the same shape
// the dashboard's candidate cards expect. Tries a couple of header variants
// since the exact sheet header text wasn't directly verifiable from here.
function mapCandidateRow(row) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    }
    return "";
  };
  return {
    name: pick("Name", "name"),
    headline: pick("Headline", "headline"),
    location: pick("Location", "location"),
    current_role: pick("Current Role", "Current Role/Title", "current_role"),
    current_company: pick("Current Company", "current_company"),
    public_profile_url: pick("Public Profile URL", "LinkedIn URL", "Profile URL", "public_profile_url"),
    talent_profile_url: pick("Talent Profile URL", "Recruiter Profile URL", "talent_profile_url"),
    network_distance: pick("Network Distance", "network_distance"),
    fit_score: (() => {
      const v = pick("Fit Score", "fit_score");
      const n = parseFloat(v);
      return isNaN(n) ? v : n;
    })(),
    ai_summary: pick("AI Summary", "ai_summary"),
    matched_signals: pick("Matched Signals", "matched_signals"),
    gaps: pick("Gaps", "gaps"),
    email: pick("Email", "email"),
    email_status: pick("Email Status", "email_status"),
    sourced_at: pick("Sourced At", "sourced_at"),
    recruitcrm_slug: pick("RecruitCRM Slug", "recruitcrm_slug"),
    assigned_job: pick("Assigned Job", "assigned_job"),
    assigned_at: pick("Assigned At", "assigned_at")
  };
}

app.get("/api/sheet-overview", async (req, res) => {
  try {
    const [requests, candidates] = await Promise.all([
      fetchSheetRows(SEARCH_REQUESTS_TAB).catch(() => []), // best-effort only, see below
      fetchSheetRows(CANDIDATES_TAB)
    ]);

    // Build history straight from the Candidates tab, grouped by the unique
    // search keyword strings actually used. This is the reliable source —
    // the Search Requests tab was found to silently return nothing (wrong
    // headers/tab name/never written), which made totals populate but the
    // history list stay empty. Candidates data alone is enough to answer
    // "what searches have we run and how many candidates did each pool."
    const bySearch = {};
    for (const c of candidates) {
      const key = c["Search Keywords"] || "(unknown search)";
      if (!bySearch[key]) {
        bySearch[key] = { count: 0, qualified: 0, scoreSum: 0, scoreCount: 0, lastSourced: null, candidates: [], totalFoundOnLinkedIn: null };
      }
      const bucket = bySearch[key];
      bucket.count += 1;
      const score = parseFloat(c["Fit Score"]);
      if (!isNaN(score)) {
        bucket.scoreSum += score;
        bucket.scoreCount += 1;
        if (score > 60) bucket.qualified += 1;
      }
      // Reads the "LinkedIn Total Found" column once it exists on the sheet
      // — every row for the same search carries the same number, so the
      // first non-empty one found is enough.
      const totalFound = parseInt(c["LinkedIn Total Found"], 10);
      if (!bucket.totalFoundOnLinkedIn && !isNaN(totalFound)) bucket.totalFoundOnLinkedIn = totalFound;
      const sourcedAt = c["Sourced At"];
      if (sourcedAt && (!bucket.lastSourced || sourcedAt > bucket.lastSourced)) bucket.lastSourced = sourcedAt;
      bucket.candidates.push(mapCandidateRow(c));
    }
    // Show strongest fits first within each search group.
    Object.values(bySearch).forEach((b) => b.candidates.sort((a, b2) => (b2.fit_score || 0) - (a.fit_score || 0)));

    // Best-effort enrichment: if the Search Requests tab does have usable
    // rows, borrow the original target location/role context per search
    // string. If it doesn't, history still works fine without this.
    const requestMeta = new Map();
    for (const r of requests) {
      const key = r["Boolean Search String"];
      if (!key) continue;
      const existing = requestMeta.get(key);
      if (existing && new Date(existing.submittedAt || 0) >= new Date(r["Submitted At"] || 0)) continue;
      requestMeta.set(key, {
        location: r["Location/Region"] || "",
        roleContext: r["Role Context"] || "",
        submittedAt: r["Submitted At"] || null
      });
    }

    const history = Object.entries(bySearch)
      .map(([searchString, stats]) => {
        const meta = requestMeta.get(searchString) || {};
        return {
          searchString,
          location: meta.location || "",
          roleContext: meta.roleContext || "",
          submittedAt: meta.submittedAt || stats.lastSourced,
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
      totalCandidatesPooled: candidates.length,
      totalQualified: candidates.filter((c) => parseFloat(c["Fit Score"]) > 60).length
    };

    res.json({ history, totals });
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
        await userSupabase.rpc("refund_email_credits", {
          amount: unused,
          p_max: Number(EMAIL_CREDIT_MAX),
          p_regen_ms: Number(EMAIL_CREDIT_REGEN_MS)
        }).catch(() => {});
      }
      await userSupabase.rpc("record_team_candidates", {
        candidate_count: candidates.length,
        p_day_ms: Number(TEAM_DAY_MS)
      }).catch(() => {});
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
