import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { ConfigError } from "../core/errors.js";
import { settleAfterAction } from "../browser/navigation.js";

export const STORAGE_STATE_PATH = "./.auth-state.json";

/**
 * Handles three auth modes:
 *  - "none": no login needed
 *  - "manual": opens a real (non-headless) browser window, the user logs in by hand,
 *              then presses Enter in the terminal. Session cookies are saved to disk
 *              and reused for the actual crawl.
 *  - "credentials": auto-fills a login form using provided selectors.
 *
 * @param {Object} params
 * @param {"none"|"manual"|"credentials"} params.mode
 * @param {import("../browser/browser-manager.js").BrowserManager} params.browserManager
 * @param {string} [params.loginUrl]
 * @param {Object} [params.credentials]
 * @param {import("../core/logger.js").createLogger} params.logger
 * @param {string} [params.storageStatePath] Defaults to STORAGE_STATE_PATH; pass a job-specific
 *   path when multiple crawls may authenticate concurrently so they don't overwrite each other.
 */
export async function resolveAuth({ mode, browserManager, loginUrl, credentials, logger, storageStatePath = STORAGE_STATE_PATH }) {
  if (mode === "none") {
    return { storageState: undefined };
  }

  if (mode === "manual") {
    logger.info("Opening a browser window for manual login.");
    logger.info("Log in normally, get to a page that proves you're authenticated, then come back and press Enter.");

    const context = await browserManager.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you are logged in... ");
    rl.close();

    await context.storageState({ path: storageStatePath });
    await context.close();
    logger.info(`Session saved to ${storageStatePath}. Reusing it for the crawl.`);
    return { storageState: storageStatePath };
  }

  if (mode === "credentials") {
    const { usernameSelector, passwordSelector, submitSelector, username, password } = credentials;
    if (!usernameSelector || !passwordSelector || !submitSelector || !username || !password) {
      throw new ConfigError(
        "credentials auth mode requires: --login-url, --user-selector, --pass-selector, --submit-selector, --username, --password"
      );
    }

    const context = await browserManager.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    // Use .first() so a selector matching more than one element (common with hidden/duplicate
    // autofill inputs) doesn't throw a Playwright strict-mode violation and abort the login.
    await page.locator(usernameSelector).first().fill(username);
    await page.locator(passwordSelector).first().fill(password);
    const preSubmitUrl = page.url();
    await page.locator(submitSelector).first().click();
    // Waits for the post-login redirect (real navigation or SPA pushState) instead of a fixed
    // sleep; still bounded, so a login that doesn't redirect at all can't hang the crawl.
    await settleAfterAction(page, preSubmitUrl, { timeout: 8000 });

    await context.storageState({ path: storageStatePath });
    await context.close();
    logger.info(`Logged in via credentials. Session saved to ${storageStatePath}.`);
    return { storageState: storageStatePath };
  }

  throw new ConfigError(`Unknown auth mode: ${mode}`);
}

export async function clearSavedSession() {
  try {
    await fs.unlink(STORAGE_STATE_PATH);
  } catch {
    /* no-op: nothing saved yet */
  }
}
