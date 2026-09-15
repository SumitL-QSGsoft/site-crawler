#!/usr/bin/env node
import fs from "node:fs";
import { chromium } from "playwright";
import { resolveAuth } from "./auth.js";
import { crawlSite } from "./crawler.js";

// Minimal .env loader (no extra dependency): KEY=VALUE lines, '#' comments, blank lines skipped.
// Never overrides a variable already set in the real environment.
function loadEnvFile(filePath = ".env") {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const env = process.env;
  const args = {
    headless: env.HEADLESS ? env.HEADLESS.toLowerCase() !== "false" : true,
    sameOriginOnly: true,
    startUrl: env.SITE_URL || undefined,
    outDir: env.OUT_DIR || undefined,
    maxPages: env.MAX_PAGES ? parseInt(env.MAX_PAGES, 10) : undefined,
    maxDepth: env.MAX_DEPTH ? parseInt(env.MAX_DEPTH, 10) : undefined,
    delayMs: env.DELAY_MS ? parseInt(env.DELAY_MS, 10) : undefined,
    authMode: env.AUTH_MODE || undefined,
    loginUrl: env.LOGIN_URL || undefined,
    username: env.USERNAME || undefined,
    password: env.PASSWORD || undefined,
    userSelector: env.USER_SELECTOR || undefined,
    passSelector: env.PASS_SELECTOR || undefined,
    submitSelector: env.SUBMIT_SELECTOR || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": args.startUrl = next(); break;
      case "--out": args.outDir = next(); break;
      case "--max-pages": args.maxPages = parseInt(next(), 10); break;
      case "--max-depth": args.maxDepth = parseInt(next(), 10); break;
      case "--delay-ms": args.delayMs = parseInt(next(), 10); break;
      case "--allow-cross-origin": args.sameOriginOnly = false; break;
      case "--headed": args.headless = false; break;
      case "--max-click-candidates": args.maxClickCandidates = parseInt(next(), 10); break;
      case "--max-forms-per-page": args.maxFormsPerPage = parseInt(next(), 10); break;
      case "--auth": args.authMode = next(); break; // none | manual | credentials
      case "--login-url": args.loginUrl = next(); break;
      case "--username": args.username = next(); break;
      case "--password": args.password = next(); break;
      case "--user-selector": args.userSelector = next(); break;
      case "--pass-selector": args.passSelector = next(); break;
      case "--submit-selector": args.submitSelector = next(); break;
      case "--help": args.help = true; break;
      default:
        console.warn(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
site-knowledge-crawler — crawl a live web app into an LLM-ready knowledge base

USAGE:
  node src/index.js --url https://example.com [options]

REQUIRED:
  --url <url>              Starting URL to crawl

CRAWL OPTIONS:
  --out <dir>               Output directory (default: ./knowledge-base)
  --max-pages <n>            Max screens to visit (default: 50)
  --max-depth <n>            Max link-hops from start (default: 5)
  --delay-ms <n>              Delay between page loads, be polite (default: 500)
  --allow-cross-origin        Follow links off the starting domain too
  --headed                    Show the browser window while crawling
  --max-click-candidates <n>  Non-anchor clickables probed per screen for SPA nav (default: 15)
  --max-forms-per-page <n>    GET forms probed per screen for query-driven content (default: 10)

AUTH OPTIONS:
  --auth none|manual|credentials   Default: none
  --login-url <url>                Where the login page is (manual & credentials modes)

  # manual mode: browser opens, you log in by hand, press Enter in terminal.
  # credentials mode: auto-fills a login form. Needs:
  --username <user>
  --password <pass>
  --user-selector <css>        e.g. "#email"
  --pass-selector <css>        e.g. "#password"
  --submit-selector <css>      e.g. "button[type=submit]"

EXAMPLES:
  node src/index.js --url https://example.com --max-pages 30

  node src/index.js --url https://app.example.com/dashboard \\
    --auth manual --login-url https://app.example.com/login --headed

  node src/index.js --url https://app.example.com/dashboard \\
    --auth credentials --login-url https://app.example.com/login \\
    --username me@example.com --password secret \\
    --user-selector "#email" --pass-selector "#password" --submit-selector "button[type=submit]"
`);
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.startUrl) {
    printHelp();
    process.exit(args.startUrl ? 0 : 1);
  }

  const authMode = args.authMode || "none";
  const browser = await chromium.launch({ headless: args.headless });

  try {
    const { storageState } = await resolveAuth({
      mode: authMode,
      browser,
      loginUrl: args.loginUrl,
      credentials: {
        usernameSelector: args.userSelector,
        passwordSelector: args.passSelector,
        submitSelector: args.submitSelector,
        username: args.username,
        password: args.password,
      },
    });

    const result = await crawlSite(browser, {
      startUrl: args.startUrl,
      outDir: args.outDir || "./knowledge-base",
      maxPages: args.maxPages || 50,
      maxDepth: args.maxDepth ?? 5,
      delayMs: args.delayMs ?? 500,
      sameOriginOnly: args.sameOriginOnly,
      storageState,
      headless: args.headless,
      maxClickCandidates: args.maxClickCandidates,
      maxFormsPerPage: args.maxFormsPerPage,
    });

    console.log(`\n[done] Crawled ${result.pagesDone} screen(s).`);
    console.log(`[done] Knowledge base written to: ${args.outDir || "./knowledge-base"}`);
    console.log(`[done] Start with index.md and graph.json.\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
