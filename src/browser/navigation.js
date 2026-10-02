const pendingDataRequests = new WeakMap();

// Navigates like a real user would: don't block on strict networkidle (some SPAs keep a socket
// open forever, e.g. live dashboards/chat), just wait for the DOM then give the network a bounded
// chance to settle before we read the page. Avoids the whole page being skipped on a load timeout.
export async function gotoAndSettle(target, url, { timeout = 30000, idleTimeout = 2500 } = {}) {
  if (!pendingDataRequests.has(target)) {
    const pending = new Set();
    pendingDataRequests.set(target, pending);
    target.on("request", (request) => {
      if (["fetch", "xhr"].includes(request.resourceType())) pending.add(request);
    });
    target.on("requestfinished", (request) => pending.delete(request));
    target.on("requestfailed", (request) => pending.delete(request));
  }
  const response = await target.goto(url, { waitUntil: "domcontentloaded", timeout });
  await target.waitForLoadState("networkidle", { timeout: idleTimeout }).catch(() => { });
  return response;
}

export async function waitForContentReady(page, { timeout = 6000 } = {}) {
  const ready = await page.waitForFunction(() => {
    const content = document.querySelector('main, [role="main"]');
    const root = content || document.body;
    const text = root?.innerText?.trim() || "";
    const loading = /\bloading(?:\.{1,3}|\s)/i.test(text) ||
      Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"]'));
    const appRoot = document.querySelector('#app, #root, [data-reactroot]');
    let hasContent;
    if (appRoot) {
      const view = appRoot.cloneNode(true);
      view.querySelectorAll('nav, header, aside, footer, [role="navigation"], script, style').forEach((node) => node.remove());
      hasContent = Boolean(view.textContent.trim() ||
        view.querySelector('img[alt], canvas, a[href], button, form, table, [role="grid"]'));
    } else {
      hasContent = Boolean(content?.innerText?.trim() ||
        root?.querySelector('h1, h2, form, table, [role="grid"], a[href], button, input[type="password"]'));
    }
    return hasContent && !loading;
  }, null, { timeout, polling: 250 }).then(() => true).catch(() => false);
  if (!ready) return false;

  const pending = pendingDataRequests.get(page);
  if (pending?.size) {
    const initialText = await page.evaluate(() => document.body.innerText.trim());
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        page.off("requestfinished", check);
        page.off("requestfailed", check);
        resolve();
      };
      const check = () => { if (!pending.size) finish(); };
      const timer = setTimeout(finish, timeout);
      page.on("requestfinished", check);
      page.on("requestfailed", check);
      check();
    });
    await page.waitForFunction((text) => document.body.innerText.trim() !== text, initialText,
      { timeout: 800 }).catch(() => { });
  }
  return true;
}

// Waits for an observable outcome after an interaction that *might* trigger navigation (a real
// page load, an SPA router pushState/replaceState, or a plain location assignment - whichever
// mechanism the framework used, `location.href` changes either way). Resolves as soon as that
// happens instead of blindly sleeping a fixed duration; when nothing navigates (e.g. the click
// only opened a modal/popover in place) falls back to one bounded network-settle window so the
// caller still gets a fair chance to observe the resulting DOM before it gives up. No
// `waitForTimeout` involved - both branches are tied to a real, observable condition.
// The fallback window is kept short (not the full `timeout`): the overwhelming majority of click
// probes hit a dead/no-op element, and with potentially dozens of candidates per screen, every
// probe paying the full window for that common case is the single biggest avoidable crawl-time
// cost - most real UI reacts to a click within a couple of render frames, not seconds.
export async function settleAfterAction(page, initialUrl, { timeout = 800 } = {}) {
  const navigated = await page
    .waitForFunction((initial) => window.location.href !== initial, initialUrl, { timeout })
    .then(() => true)
    .catch(() => false);
  if (!navigated) {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 800) }).catch(() => { });
  }
}

// Drops image/media/font requests on throwaway scratch pages (click/form probing, login
// verification) that are never screenshotted - pure navigation-speed win, never applied to the
// real crawled page since its screenshot needs to look like what a user actually sees.
// Uses fallback() rather than continue() for anything not blocked, since page-level routes take
// priority over the context's own - continue() would send the request straight to the network
// and skip any context.route() handler (e.g. request mocking in tests) entirely.
export async function blockHeavyResources(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") return route.abort();
    return route.fallback();
  });
}
