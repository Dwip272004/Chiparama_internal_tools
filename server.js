import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  N8N_BASE_URL,                                        // e.g. https://diwp645.app.n8n.cloud  (no trailing slash)
  N8N_API_KEY,                                          // n8n Settings > API > create an API key
  N8N_FORM_WEBHOOK_ID = "696576aa-5fbe-4b76-849d-fd81f5f0cb2a", // "Sourcing Request Form" node's webhookId
  N8N_WORKFLOW_ID = "jo9Q690CzrUwUZPv",
  N8N_ASSIGN_WEBHOOK_PATH = "assign-to-job",           // "Assign To Job Webhook" node's path
  SHEET_ID = "1Jss-cmGXu_8jMzplRZYJgYxPCkOncP0vTbbDwYEci7w", // the Candidates sourcing Google Sheet
  SEARCH_REQUESTS_TAB = "Search Requests",
  CANDIDATES_TAB = "Candidates",
  PORT = 3000
} = process.env;

if (!N8N_BASE_URL || !N8N_API_KEY) {
  console.warn("[sourcing-desk] Missing N8N_BASE_URL or N8N_API_KEY env vars — set these on Render.");
}

function n8nHeaders() {
  return { "X-N8N-API-KEY": N8N_API_KEY, accept: "application/json" };
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
      "recruitCrmJob"        // field-9
    ];

    const form = new FormData();
    FIELD_ORDER.forEach((key, i) => {
      const value = fields[key];
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
    res.json({ ok: true, submittedAt: submitFloor });
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

    res.json({ candidates, summary, totalFoundOnLinkedIn });
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
