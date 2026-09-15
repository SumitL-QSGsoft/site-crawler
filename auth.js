import fs from "node:fs/promises";
import readline from "node:readline/promises";

const STORAGE_STATE_PATH = "./.auth-state.json";

/**
 * Handles three auth modes:
 *  - "none": no login needed
 *  - "manual": opens a real (non-headless) browser window, you log in by hand,
 *              then press Enter in the terminal. Session cookies are saved
 *              to disk and reused for the actual crawl.
 *  - "credentials": auto-fills a login form using provided selectors.
 */
export async function resolveAuth({ mode, browser, loginUrl, credentials }) {
  if (mode === "none") {
    return { storageState: undefined };
  }

  if (mode === "manual") {
    console.log("\n[auth] Opening a browser window for manual login.");
    console.log("[auth] Log in normally, get to a page that proves you're authenticated,");
    console.log("[auth] then come back here and press Enter.\n");

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you are logged in... ");
    rl.close();

    await context.storageState({ path: STORAGE_STATE_PATH });
    await context.close();
    console.log(`[auth] Session saved to ${STORAGE_STATE_PATH}. Reusing it for the crawl.\n`);
    return { storageState: STORAGE_STATE_PATH };
  }

  if (mode === "credentials") {
    const { usernameSelector, passwordSelector, submitSelector, username, password } = credentials;
    if (!usernameSelector || !passwordSelector || !submitSelector || !username || !password) {
      throw new Error(
        "credentials auth mode requires: --login-url, --user-selector, --pass-selector, --submit-selector, --username, --password"
      );
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.fill(usernameSelector, username);
    await page.fill(passwordSelector, password);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      page.click(submitSelector),
    ]);
    await page.waitForTimeout(1500);

    await context.storageState({ path: STORAGE_STATE_PATH });
    await context.close();
    console.log(`[auth] Logged in via credentials. Session saved to ${STORAGE_STATE_PATH}.\n`);
    return { storageState: STORAGE_STATE_PATH };
  }

  throw new Error(`Unknown auth mode: ${mode}`);
}

export async function clearSavedSession() {
  try {
    await fs.unlink(STORAGE_STATE_PATH);
  } catch {
    /* no-op */
  }
}
