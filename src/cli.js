import { loadConfig, printHelp } from "./config.js";
import { createLogger } from "./core/logger.js";
import { ConfigError } from "./core/errors.js";
import { BrowserManager } from "./browser/browser-manager.js";
import { resolveAuth } from "./auth/auth-service.js";
import { Crawler } from "./crawl/crawler.js";

// Composition root: wires config -> browser -> auth -> crawler together. Nothing else in the
// app reaches into process.argv/process.env or constructs a BrowserManager/Crawler itself.
export async function runCli() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[fatal] ${err.message}\n`);
      printHelp();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (config.help) {
    printHelp();
    return;
  }

  const logger = createLogger("crawl");
  const browserManager = await BrowserManager.launch({ headless: config.headless });

  try {
    const { storageState } = await resolveAuth({
      mode: config.auth.mode,
      browserManager,
      loginUrl: config.auth.loginUrl,
      credentials: {
        usernameSelector: config.auth.userSelector,
        passwordSelector: config.auth.passSelector,
        submitSelector: config.auth.submitSelector,
        username: config.auth.username,
        password: config.auth.password,
      },
      logger: createLogger("auth"),
    });

    const crawler = new Crawler({ browserManager, logger });
    const result = await crawler.run({ ...config, storageState });

    logger.info(`Crawled ${result.pagesDone} screen(s).`);
    logger.info(`Knowledge base written to: ${config.outDir}`);
    logger.info(`Start with index.md and graph.json.`);
  } finally {
    await browserManager.close();
  }
}
