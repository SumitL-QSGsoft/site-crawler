import { chromium } from "playwright";
import { installPageHelpers } from "./page-helpers.js";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

// Thin wrapper around Playwright so the rest of the app depends on this seam, not the library
// directly, and every context we hand out is guaranteed to have the shared page helpers installed.
export class BrowserManager {
  #browser;

  constructor(browser) {
    this.#browser = browser;
  }

  static async launch({ headless = true } = {}) {
    const browser = await chromium.launch({ headless });
    return new BrowserManager(browser);
  }

  get raw() {
    return this.#browser;
  }

  async newContext({ storageState } = {}) {
    const context = await this.#browser.newContext({ storageState, viewport: DEFAULT_VIEWPORT });
    await context.addInitScript(installPageHelpers);
    return context;
  }

  // Manual login needs a real visible window even when the crawl itself runs headless.
  static async launchHeaded() {
    const browser = await chromium.launch({ headless: false });
    return new BrowserManager(browser);
  }

  async close() {
    await this.#browser.close();
  }
}
