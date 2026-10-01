import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { BrowserManager } from "../src/browser/browser-manager.js";
import { Crawler } from "../src/crawl/crawler.js";
import { createLogger } from "../src/core/logger.js";

// This server is a thin UI shell: all crawling logic (navigation, extraction, modal/form
// discovery, screen/graph writing) is the unmodified engine from ../src — nothing here
// re-implements or duplicates it, it only orchestrates jobs and renders their output.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, "runs");
const PORT = process.env.PORT || 4000;
const MAX_CONCURRENT_JOBS = 5;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// A crashed/disconnected page in one job (or any other stray async error not caught by its own
// try/catch) must not take the whole server - and every other job's in-progress crawl - down
// with it. Log and keep running instead of letting Node's default behavior kill the process.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
});

const jobs = new Map(); // jobId -> job state
let runningJobs = 0;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/runs", express.static(RUNS_DIR));

app.post("/api/crawls", async (req, res) => {
  const { url, maxPages, maxDepth, delayMs, sameOriginOnly, workers } = req.body || {};

  const urlError = validateTargetUrl(url);
  if (urlError) {
    return res.status(400).json({ error: urlError });
  }
  if (runningJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: "Another crawl is already running. Please wait for it to finish." });
  }

  const jobId = crypto.randomUUID();
  const outDir = path.join(RUNS_DIR, jobId);
  const job = {
    id: jobId,
    status: "running",
    logs: [],
    startUrl: url,
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
    pendingAuth: null, // { url, resolve } while waiting on POST /api/crawls/:id/auth
  };
  jobs.set(jobId, job);
  runningJobs += 1;

  res.status(202).json({ jobId });

  runCrawlJob(job, outDir, {
    startUrl: url,
    outDir,
    maxPages: clampInt(maxPages, 1, 300, 30),
    maxDepth: clampInt(maxDepth, 0, 20, 3),
    delayMs: clampInt(delayMs, 100, 5000, 400),
    sameOriginOnly: sameOriginOnly !== false,
    // More than ~6 tabs sharing one browser process usually hits diminishing (or negative)
    // returns from CPU/network contention rather than crawling faster - see index.html's hint.
    concurrency: clampInt(workers, 1, 8, 4),
    headless: true,
    auth: { mode: "none" },
    // The web server has no terminal to answer an interactive auth prompt with; onAuthRequired
    // below pauses the job and asks the browser UI for credentials instead.
    interactive: false,
    maxFormsPerPage: 10,
    onAuthRequired: ({ url: loginUrl }) => requestAuthFromUser(job, loginUrl),
  })
    .catch((err) => {
      job.status = "error";
      job.error = err.message;
      job.pendingAuth = null; // don't leave a stale login prompt showing once the job has failed
    })
    .finally(() => {
      runningJobs -= 1;
    });
});

app.get("/api/crawls/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(toPublicJob(job));
});

// Submits (or skips) credentials for a crawl that's currently paused on a detected login page.
// Credentials are only ever held in memory for the life of this one call/login attempt.
app.post("/api/crawls/:id/auth", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (!job.pendingAuth) return res.status(400).json({ error: "This crawl isn't waiting on a login right now." });

  const { username, password, cancel } = req.body || {};
  const resolve = job.pendingAuth.resolve;
  job.pendingAuth = null;
  job.status = "running";

  if (cancel || !username || !password) {
    resolve(null);
  } else {
    resolve({ username: String(username), password: String(password) });
  }
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Crawler demo running at http://localhost:${PORT}`);
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Pauses the crawl by returning a promise that only resolves once the frontend posts credentials
// (or skips) via POST /api/crawls/:id/auth - or after AUTH_TIMEOUT_MS if nobody responds, so an
// abandoned tab can't hold a job/browser open (and one of MAX_CONCURRENT_JOBS's slots) forever.
function requestAuthFromUser(job, loginUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      job.pendingAuth = null;
      job.status = "running";
      job.logs.push({
        level: "warn",
        line: `No login response within ${AUTH_TIMEOUT_MS / 1000}s - continuing without it.`,
        at: new Date().toISOString(),
      });
      settle(null);
    }, AUTH_TIMEOUT_MS);

    job.pendingAuth = { url: loginUrl, resolve: settle };
    job.status = "needs-auth";
  });
}

// Basic SSRF guard: only allow http(s) URLs and reject obvious loopback/private/link-local
// targets so this web-exposed form can't be used to probe internal network hosts.
function validateTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "A website URL is required.";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "That doesn't look like a valid URL.";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "Only http:// and https:// URLs are supported.";

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) return "Local/internal hosts are not allowed.";
  if (net.isIP(hostname)) {
    if (isPrivateOrLoopbackIp(hostname)) return "Private/internal IP addresses are not allowed.";
  }
  return null;
}

function isPrivateOrLoopbackIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

async function runCrawlJob(job, outDir, config) {
  const logger = makeCapturingLogger(job);
  const browserManager = await BrowserManager.launch({ headless: config.headless });
  try {
    const crawler = new Crawler({ browserManager, logger });
    // No wall-clock timeout here - a crawl runs until it completes (bounded by maxPages/maxDepth).
    // If it's taking too long, lower "Max screens" from the UI instead.
    const { nodes, edges, pagesDone } = await crawler.run(config);
    const screens = await loadScreens(outDir, job.id, nodes, edges);

    job.result = {
      pagesDone,
      modalCount: screens.filter((s) => s.isModal).length,
      actionCount: screens.reduce((sum, s) => sum + s.sections.actions.length, 0),
      formCount: screens.reduce((sum, s) => sum + s.sections.fields.length, 0),
      nodes,
      edges,
      screens,
    };
    job.status = "done";
  } finally {
    await browserManager.close();
  }
}

function makeCapturingLogger(job) {
  const base = createLogger("crawl");
  const wrap = (level) => (...args) => {
    job.logs.push({ level, line: args.map(String).join(" "), at: new Date().toISOString() });
    base[level](...args);
  };
  const logger = { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
  logger.child = () => logger;
  return logger;
}

async function loadScreens(outDir, jobId, nodes, edges) {
  const modalTargets = new Set(edges.filter((e) => e.label?.startsWith("modal:")).map((e) => e.to));

  const screens = [];
  for (const node of nodes) {
    const dir = path.join(outDir, "screens", node.id);
    const meta = await readJsonSafe(path.join(dir, "meta.json"));
    const content = await readTextSafe(path.join(dir, "content.md"));
    const hasScreenshot = fsSync.existsSync(path.join(dir, "screenshot.png"));

    screens.push({
      ...node,
      ...meta,
      isModal: modalTargets.has(node.id),
      screenshotUrl: hasScreenshot ? `/runs/${jobId}/screens/${node.id}/screenshot.png` : null,
      sections: parseContentSections(content),
    });
  }
  return screens;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return {};
  }
}

async function readTextSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

// Pulls the structured lists out of a screen's content.md (produced by src/extraction/markdown.js,
// in the same section layout AutoQA's own crawler uses) so the UI can render headings/navigation/
// buttons/fields/ARIA as chips instead of raw markdown.
function parseContentSections(md) {
  const blockUnder = (heading) => {
    const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?:\\n## |$)`);
    const match = re.exec(md);
    return match ? match[1] : "";
  };
  const bulletsUnder = (heading) =>
    blockUnder(heading)
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());

  const headingsLine = /^- \*\*Page heading\(s\):\*\* (.*)$/m.exec(md);

  const ariaMatch = /## ARIA snapshot\n+```yaml\n([\s\S]*?)\n```/.exec(md);

  return {
    headings: headingsLine ? headingsLine[1].split(" | ").map((h) => h.trim()) : [],
    navigation: bulletsUnder("Sub-navigation"),
    actions: bulletsUnder("Buttons").map(parseActionLine),
    fields: parseFieldsTable(blockUnder("Form fields")),
    columns: bulletsUnder("Table / grid columns"),
    aria: ariaMatch ? ariaMatch[1] : null,
    links: bulletsUnder("Links on this screen"),
  };
}

// "- <text> — `<locator>`" (see src/extraction/markdown.js) -> { text, locator }.
function parseActionLine(line) {
  const match = /^(.*) — `(.*)`$/.exec(line);
  return match ? { text: match[1].trim(), locator: match[2].trim() } : { text: line, locator: null };
}

// "## Form fields" is a single markdown table (Label | Tag | name | type | placeholder | Locator)
// covering every field on the page - parse each row into a plain object.
function parseFieldsTable(block) {
  const rows = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|\s*-+\s*\|/.test(l) && !/^\|\s*Label\s*\|/.test(l));

  return rows.map((row) => {
    const cells = row
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const [label, tag, name, type, placeholder, locator] = cells;
    return {
      label: label || null,
      tag: tag || null,
      name: name || null,
      type: type || null,
      placeholder: placeholder || null,
      locator: locator ? locator.replace(/^`|`$/g, "") : null,
    };
  });
}

function toPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    startUrl: job.startUrl,
    logs: job.logs,
    error: job.error,
    result: job.result,
    pendingAuth: job.pendingAuth ? { url: job.pendingAuth.url } : null,
  };
}
