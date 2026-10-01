import readline from "node:readline/promises";
import { resolveAuth } from "./auth-service.js";
import { verifyLoginSucceeded } from "./login-wall.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { selectorForField } from "../util/selector-utils.js";

/**
 * Interactively asks the user to log in (manually or via credentials) so the crawl can continue
 * past a login wall it just hit. Returns a storageState path, or null if the user declined.
 *
 * @param {Object} params
 * @param {BrowserManager} params.browserManager
 * @param {boolean} params.headless
 * @param {string} params.url
 * @param {Object} params.extracted
 * @param {import("../core/logger.js").createLogger} params.logger
 */
export async function promptAndAuthenticate({ browserManager, headless, url, extracted, logger }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n[auth] Hit what looks like a login page: ${url}`);
  const proceed = await rl.question("[auth] Log in now so the crawl can continue past it? (Y/n) ");
  if (proceed.trim().toLowerCase() === "n") {
    rl.close();
    return null;
  }

  const mode = (await rl.question("[auth] Log in (m)anually in a browser window, or auto-fill with (c)redentials? [m/c] "))
    .trim()
    .toLowerCase();

  if (mode === "c") {
    const fields = extracted.forms.flatMap((f) => f.fields);
    const userField = fields.find((f) => f.type !== "password" && selectorForField(f));
    const passField = fields.find((f) => f.type === "password" && selectorForField(f));
    const defaultUserSelector = userField ? selectorForField(userField) : "";
    const defaultPassSelector = passField ? selectorForField(passField) : "";
    const defaultSubmitSelector = 'button[type="submit"], input[type="submit"], form button:not([type="button"]):not([type="reset"])';

    const username = await rl.question("[auth] Username/email: ");
    const password = await rl.question("[auth] Password: ");
    const userSelector = (await rl.question(`[auth] Username field selector [${defaultUserSelector}]: `)) || defaultUserSelector;
    const passSelector = (await rl.question(`[auth] Password field selector [${defaultPassSelector}]: `)) || defaultPassSelector;
    const submitSelector = (await rl.question(`[auth] Submit button selector [${defaultSubmitSelector}]: `)) || defaultSubmitSelector;
    rl.close();

    const { storageState } = await resolveAuth({
      mode: "credentials",
      browserManager,
      loginUrl: url,
      credentials: { usernameSelector: userSelector, passwordSelector: passSelector, submitSelector, username, password },
      logger,
    });

    if (storageState && !(await verifyLoginSucceeded(browserManager, storageState, url))) {
      console.warn(
        "\n[auth] Still looks like a login page after auto-fill \u2014 this can happen with MFA/OTP/CAPTCHA challenges"
      );
      console.warn("[auth] that can't be automated. Re-run and choose manual login (m) instead if the crawl stalls.\n");
    }
    return storageState;
  }

  rl.close();

  // Manual login needs a visible window even if the crawl itself is running headless.
  let loginBrowserManager = browserManager;
  let ownsBrowser = false;
  if (headless) {
    loginBrowserManager = await BrowserManager.launchHeaded();
    ownsBrowser = true;
  }
  const { storageState } = await resolveAuth({ mode: "manual", browserManager: loginBrowserManager, loginUrl: url, logger });
  if (ownsBrowser) await loginBrowserManager.close();
  return storageState;
}
