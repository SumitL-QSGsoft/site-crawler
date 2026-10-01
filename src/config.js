import fs from "node:fs";
import { ConfigError } from "./core/errors.js";

const DEFAULTS = {
  outDir: "./knowledge-base",
  maxPages: 50,
  maxDepth: 5,
  delayMs: 500,
  sameOriginOnly: true,
  headless: true,
  authMode: "none",
  // Multiple pages crawled in parallel (one shared browser context, one tab per worker) -
  // the single biggest lever on wall-clock time since each screen's click/popover/form
  // probing is itself many sequential scratch-page round trips. 2-3 is a safe default for
  // most sites; push higher only if the target can handle the extra concurrent load.
  concurrency: 3,
};

// Minimal .env loader (no extra dependency): KEY=VALUE lines, '#' comments, blank lines skipped.
// Never overrides a variable already set in the real environment (real env always wins).
export function loadEnvFile(filePath = ".env") {
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

function envDefaults(env) {
  // Every key below is included even when unset, so it must be stripped of undefined values
  // before merging over DEFAULTS - otherwise an explicit `authMode: undefined` here would
  // overwrite DEFAULTS.authMode ("none") instead of falling through to it.
  return compact({
    startUrl: env.SITE_URL || undefined,
    outDir: env.OUT_DIR || undefined,
    maxPages: env.MAX_PAGES ? parseInt(env.MAX_PAGES, 10) : undefined,
    maxDepth: env.MAX_DEPTH ? parseInt(env.MAX_DEPTH, 10) : undefined,
    delayMs: env.DELAY_MS ? parseInt(env.DELAY_MS, 10) : undefined,
    concurrency: env.WORKERS ? parseInt(env.WORKERS, 10) : undefined,
    headless: env.HEADLESS ? env.HEADLESS.toLowerCase() !== "false" : undefined,
    authMode: env.AUTH_MODE || undefined,
    loginUrl: env.LOGIN_URL || undefined,
    username: env.USERNAME || undefined,
    password: env.PASSWORD || undefined,
    userSelector: env.USER_SELECTOR || undefined,
    passSelector: env.PASS_SELECTOR || undefined,
    submitSelector: env.SUBMIT_SELECTOR || undefined,
  });
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const FLAG_HANDLERS = {
  "--url": (args, next) => (args.startUrl = next()),
  "--out": (args, next) => (args.outDir = next()),
  "--max-pages": (args, next) => (args.maxPages = parseInt(next(), 10)),
  "--max-depth": (args, next) => (args.maxDepth = parseInt(next(), 10)),
  "--delay-ms": (args, next) => (args.delayMs = parseInt(next(), 10)),
  "--workers": (args, next) => (args.concurrency = parseInt(next(), 10)),
  "--allow-cross-origin": (args) => (args.sameOriginOnly = false),
  "--headed": (args) => (args.headless = false),
  "--max-click-candidates": (args, next) => (args.maxClickCandidates = parseInt(next(), 10)),
  "--max-forms-per-page": (args, next) => (args.maxFormsPerPage = parseInt(next(), 10)),
  "--auth": (args, next) => (args.authMode = next()), // none | manual | credentials
  "--login-url": (args, next) => (args.loginUrl = next()),
  "--username": (args, next) => (args.username = next()),
  "--password": (args, next) => (args.password = next()),
  "--user-selector": (args, next) => (args.userSelector = next()),
  "--pass-selector": (args, next) => (args.passSelector = next()),
  "--submit-selector": (args, next) => (args.submitSelector = next()),
  "--help": (args) => (args.help = true),
};

// Precedence, low to high: hardcoded defaults < .env / real env vars < CLI flags.
function parseCliArgs(argv, base) {
  const args = { ...base };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    const handler = FLAG_HANDLERS[flag];
    if (!handler) {
      console.warn(`Unknown arg: ${flag}`);
      continue;
    }
    handler(args, next);
  }
  return args;
}

/**
 * @typedef {Object} CrawlConfig
 * @property {string} startUrl
 * @property {string} outDir
 * @property {number} maxPages
 * @property {number} maxDepth
 * @property {number} delayMs
 * @property {number} concurrency
 * @property {boolean} sameOriginOnly
 * @property {boolean} headless
 * @property {number} [maxClickCandidates]
 * @property {number} [maxFormsPerPage]
 * @property {Object} auth
 * @property {"none"|"manual"|"credentials"} auth.mode
 * @property {string} [auth.loginUrl]
 * @property {string} [auth.username]
 * @property {string} [auth.password]
 * @property {string} [auth.userSelector]
 * @property {string} [auth.passSelector]
 * @property {string} [auth.submitSelector]
 */

// Builds and validates the immutable config the whole app runs off of. Loading env/CLI parsing
// is deliberately separated from validation so tests can construct a Config without touching argv/fs.
export function loadConfig(argv = process.argv.slice(2)) {
  loadEnvFile();
  const merged = parseCliArgs(argv, { ...DEFAULTS, ...envDefaults(process.env) });

  if (merged.help) {
    return { help: true };
  }
  if (!merged.startUrl) {
    throw new ConfigError("Missing required --url (or SITE_URL in .env).");
  }

  return {
    help: false,
    startUrl: merged.startUrl,
    outDir: merged.outDir,
    maxPages: merged.maxPages,
    maxDepth: merged.maxDepth,
    delayMs: merged.delayMs,
    // Clamped so a typo/huge value can't launch dozens of concurrent tabs against someone's site.
    concurrency: Math.max(1, Math.min(merged.concurrency || 1, 8)),
    sameOriginOnly: merged.sameOriginOnly,
    headless: merged.headless,
    maxClickCandidates: merged.maxClickCandidates,
    maxFormsPerPage: merged.maxFormsPerPage,
    auth: {
      mode: merged.authMode,
      loginUrl: merged.loginUrl,
      username: merged.username,
      password: merged.password,
      userSelector: merged.userSelector,
      passSelector: merged.passSelector,
      submitSelector: merged.submitSelector,
    },
  };
}

export function printHelp() {
  console.log(`
site-knowledge-crawler — crawl a live web app into an LLM-ready knowledge base

USAGE:
  node index.js --url https://example.com [options]

REQUIRED:
  --url <url>              Starting URL to crawl (or set SITE_URL in .env)

CRAWL OPTIONS:
  --out <dir>               Output directory (default: ./knowledge-base)
  --max-pages <n>            Max screens to visit (default: 50)
  --max-depth <n>            Max link-hops from start (default: 5)
  --delay-ms <n>              Delay between page loads, be polite (default: 500)
  --workers <n>                Pages crawled in parallel, 1-8 (default: 3)
  --allow-cross-origin        Follow links off the starting domain too
  --headed                    Show the browser window while crawling
  --max-click-candidates <n>  Optional limit on clickable candidates per screen (default: all)
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

  All AUTH OPTIONS can also be set via .env (SITE_URL, AUTH_MODE, LOGIN_URL, USERNAME, PASSWORD, ...).

EXAMPLES:
  node index.js --url https://example.com --max-pages 30

  node index.js --url https://app.example.com/dashboard \\
    --auth manual --login-url https://app.example.com/login --headed

  node index.js --url https://app.example.com/dashboard \\
    --auth credentials --login-url https://app.example.com/login \\
    --username me@example.com --password secret \\
    --user-selector "#email" --pass-selector "#password" --submit-selector "button[type=submit]"
`);
}
