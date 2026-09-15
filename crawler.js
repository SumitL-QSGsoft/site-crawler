import path from "node:path";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import { extractScreen, extractModal, toMarkdown, NAV_CANDIDATE_SELECTOR, DESTRUCTIVE_TEXT_RE } from "./extract.js";
import { resolveAuth } from "./auth.js";
import { normalizeUrl, sameOrigin, shortId, slugify, writeJson, writeText, ensureDir, sleep } from "./util.js";

// Defaults for how much SPA-discovery work we do per screen (both configurable via CLI flags).
const DEFAULT_MAX_CLICK_CANDIDATES = 15;
const DEFAULT_MAX_FORMS_PER_PAGE = 10;
// How many chained clicks we'll follow to reach real nav/a modal (e.g. open a menu, then click its item).
const MAX_NESTED_CLICKS = 2;

// Navigates like a real user would: don't block on strict networkidle (some SPAs keep a socket
// open forever, e.g. live dashboards/chat), just wait for the DOM then give the network a bounded
// chance to settle before we read the page. Avoids the whole page being skipped on a 30s timeout.
async function gotoAndSettle(target, url, { timeout = 30000 } = {}) {
  const response = await target.goto(url, { waitUntil: "domcontentloaded", timeout });
  await target.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  return response;
}

// Same filter pipeline as extractScreen's navCandidates, minus the mapping to text — used so
// click-probing can tell whether a click revealed a *new* candidate (e.g. a submenu opening).
async function getCandidateLabels(page) {
  return page.evaluate(
    ({ navSelector, destructiveSrc }) => {
      function deepQueryAll(sel, root = document) {
        const found = [...root.querySelectorAll(sel)];
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) found.push(...deepQueryAll(sel, el.shadowRoot));
        }
        return found;
      }
      function visible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      const destructiveRe = new RegExp(destructiveSrc, "i");
      return deepQueryAll(navSelector)
        .filter((el) => el.tagName.toLowerCase() !== "a")
        .filter((el) => !el.closest("form"))
        .filter(visible)
        .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true")
        .map((el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim())
        .filter((t) => !destructiveRe.test(t));
    },
    { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source }
  );
}

// Clicks the nth nav candidate (same selector/order/filters as getCandidateLabels and extractScreen).
async function clickCandidateAt(page, index) {
  return page.evaluate(
    ({ navSelector, destructiveSrc, index }) => {
      function deepQueryAll(sel, root = document) {
        const found = [...root.querySelectorAll(sel)];
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) found.push(...deepQueryAll(sel, el.shadowRoot));
        }
        return found;
      }
      function visible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      const destructiveRe = new RegExp(destructiveSrc, "i");
      const candidates = deepQueryAll(navSelector)
        .filter((el) => el.tagName.toLowerCase() !== "a")
        .filter((el) => !el.closest("form"))
        .filter(visible)
        .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true")
        .filter((el) => {
          const t = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
          return !destructiveRe.test(t);
        });
      const el = candidates[index];
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source, index }
  );
}

// Clicks the nth nav candidate (same selector/order used in extractScreen) in a scratch page, then
// follows up to MAX_NESTED_CLICKS more clicks if a new candidate appears without navigating (e.g. a
// menu opening its submenu). Reports either the resulting URL (real navigation) or an opened modal
// (client-only state change), so SPA routes/menus without a real <a href> can still be discovered.
async function probeClickNavigation(context, url, index) {
  const scratchPage = await context.newPage();
  let keepPageOpen = false;
  try {
    await gotoAndSettle(scratchPage, url);

    let labelsSeen = await getCandidateLabels(scratchPage);
    let clicked = await clickCandidateAt(scratchPage, index);
    if (!clicked) return null;

    for (let step = 0; step < MAX_NESTED_CLICKS; step++) {
      await scratchPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });
      await sleep(300);

      const resultUrl = scratchPage.url();
      if (normalizeUrl(resultUrl) !== normalizeUrl(url)) {
        return { type: "url", url: resultUrl };
      }

      // No navigation happened — check whether the click opened a modal/dialog instead.
      const modal = await extractModal(scratchPage);
      if (modal) {
        keepPageOpen = true; // caller screenshots this page, then closes it
        return { type: "modal", modal, page: scratchPage };
      }

      // Still nothing — maybe a submenu revealed a new candidate; try clicking into it.
      const labelsNow = await getCandidateLabels(scratchPage);
      const nextIndex = labelsNow.findIndex((label) => !labelsSeen.includes(label));
      if (nextIndex === -1) return null;

      labelsSeen = labelsNow;
      clicked = await clickCandidateAt(scratchPage, nextIndex);
      if (!clicked) return null;
    }
    return null;
  } finally {
    if (!keepPageOpen) await scratchPage.close().catch(() => { });
  }
}

// Fills a GET form's visible fields with placeholder-ish values and submits it in a scratch page.
// GET-only: submitting a form is how query-string-driven content (search/filter/pagination) is reached.
async function probeFormSubmission(context, url, formIndex) {
  const scratchPage = await context.newPage();
  try {
    await gotoAndSettle(scratchPage, url);
    const submitted = await scratchPage.evaluate((idx) => {
      function deepQueryAll(sel, root = document) {
        const found = [...root.querySelectorAll(sel)];
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) found.push(...deepQueryAll(sel, el.shadowRoot));
        }
        return found;
      }
      function visible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      const form = deepQueryAll("form")[idx];
      if (!form) return false;

      [...form.querySelectorAll("input, select, textarea")].filter(visible).forEach((field) => {
        const tag = field.tagName.toLowerCase();
        if (tag === "select") {
          if (field.options.length) field.value = field.options[0].value;
        } else if (field.type === "checkbox" || field.type === "radio") {
          // leave pre-set toggles alone; don't change their semantics
        } else if (!["hidden", "submit", "button"].includes(field.type) && !field.value) {
          field.value = field.placeholder && /^[\w .-]+$/.test(field.placeholder) ? field.placeholder : "test";
        }
      });

      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return true;
    }, formIndex);

    if (!submitted) return null;
    await scratchPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });
    await sleep(300);
    return scratchPage.url();
  } finally {
    await scratchPage.close().catch(() => { });
  }
}

// A password field (or a /login-ish URL) means we hit a login wall the crawl can't get past on its own.
function looksLikeLoginPage(extracted, url) {
  const hasPasswordField = extracted.forms.some((f) => f.fields.some((field) => field.type === "password"));
  const urlLooksLikeLogin = /\/(login|signin|sign-in|log-in|auth)(\/|$|\?)/i.test(url);
  return hasPasswordField || urlLooksLikeLogin;
}

// After an auto-filled credentials login, confirms we actually got past the login wall. If it still
// looks like a login page, the site likely needs MFA/OTP/CAPTCHA that can't be automated here.
async function verifyLoginSucceeded(browser, storageState, url) {
  const checkContext = await browser.newContext({ storageState });
  try {
    const checkPage = await checkContext.newPage();
    await gotoAndSettle(checkPage, url);
    const extracted = await extractScreen(checkPage);
    return !looksLikeLoginPage(extracted, checkPage.url());
  } catch {
    return true; // don't block the crawl over a verification hiccup
  } finally {
    await checkContext.close().catch(() => {});
  }
}

// Interactively asks the user to log in (manually or via credentials) so the crawl can continue past a login wall.
async function promptAndAuthenticate({ browser, headless, url, extracted }) {
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
    const userField = fields.find((f) => f.type !== "password" && f.name);
    const passField = fields.find((f) => f.type === "password" && f.name);
    const defaultUserSelector = userField ? `input[name="${userField.name}"]` : "";
    const defaultPassSelector = passField ? `input[name="${passField.name}"]` : "";

    const username = await rl.question("[auth] Username/email: ");
    const password = await rl.question("[auth] Password: ");
    const userSelector = (await rl.question(`[auth] Username field selector [${defaultUserSelector}]: `)) || defaultUserSelector;
    const passSelector = (await rl.question(`[auth] Password field selector [${defaultPassSelector}]: `)) || defaultPassSelector;
    const submitSelector =
      (await rl.question('[auth] Submit button selector [button[type="submit"]]: ')) || 'button[type="submit"]';
    rl.close();

    const { storageState } = await resolveAuth({
      mode: "credentials",
      browser,
      loginUrl: url,
      credentials: { usernameSelector: userSelector, passwordSelector: passSelector, submitSelector, username, password },
    });

    if (storageState && !(await verifyLoginSucceeded(browser, storageState, url))) {
      console.warn(
        "\n[auth] Still looks like a login page after auto-fill \u2014 this can happen with MFA/OTP/CAPTCHA challenges"
      );
      console.warn("[auth] that can't be automated. Re-run and choose manual login (m) instead if the crawl stalls.\n");
    }
    return storageState;
  }

  rl.close();

  // Manual login needs a visible window even if the crawl itself is running headless.
  let manualBrowser = browser;
  let ownsBrowser = false;
  if (headless) {
    manualBrowser = await chromium.launch({ headless: false });
    ownsBrowser = true;
  }
  const { storageState } = await resolveAuth({ mode: "manual", browser: manualBrowser, loginUrl: url });
  if (ownsBrowser) await manualBrowser.close();
  return storageState;
}

/**
 * BFS crawl of a site starting at startUrl.
 * options:
 *   maxPages, maxDepth, sameOriginOnly, delayMs, outDir, storageState, headless,
 *   maxClickCandidates, maxFormsPerPage
 */
export async function crawlSite(browser, options) {
  const {
    startUrl,
    maxPages = 50,
    maxDepth = 5,
    sameOriginOnly = true,
    delayMs = 500,
    outDir = "./knowledge-base",
    storageState,
    headless = true,
    maxClickCandidates = DEFAULT_MAX_CLICK_CANDIDATES,
    maxFormsPerPage = DEFAULT_MAX_FORMS_PER_PAGE,
  } = options;

  let context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });
  let page = await context.newPage();

  const queue = [{ url: startUrl, depth: 0, discoveredVia: "seed" }];
  const visited = new Set(); // normalized URLs already queued/visited
  const nodes = []; // graph nodes: { id, url, title, screenId }
  const edges = []; // graph edges: { from, to, label }
  const urlToScreenId = new Map();
  let authProbeDone = false; // only ask to authenticate once per crawl run

  visited.add(normalizeUrl(startUrl));

  await ensureDir(path.join(outDir, "screens"));

  let pagesDone = 0;

  // Persists a modal's content as its own screen (synthetic URL) without a full page navigation.
  async function persistModalScreen({ modalPage, modal, baseUrl, label, depth, parentScreenId }) {
    const syntheticUrl = `${baseUrl}#modal:${slugify(label)}`;
    const screenId = `${slugify(syntheticUrl)}-${shortId(syntheticUrl)}`;
    const discoveredVia = `modal: "${label}"`;

    const extracted = {
      title: modal.title,
      metaDescription: "",
      headings: [],
      links: [],
      buttons: modal.buttons,
      forms: modal.forms,
      tables: [],
      bodyText: modal.bodyText,
      url: baseUrl,
      screenId,
      discoveredVia,
    };

    const screenDir = path.join(outDir, "screens", screenId);
    await ensureDir(screenDir);
    await modalPage.screenshot({ path: path.join(screenDir, "screenshot.png"), fullPage: true }).catch((err) => {
      console.warn(`[crawl] modal screenshot failed for "${label}": ${err.message}`);
    });
    await modalPage.close().catch(() => { });

    await writeText(path.join(screenDir, "content.md"), toMarkdown(extracted));
    await writeJson(path.join(screenDir, "meta.json"), {
      screenId,
      url: baseUrl,
      normalizedUrl: syntheticUrl,
      depth,
      discoveredVia,
      title: modal.title,
      httpStatus: null,
      crawledAt: new Date().toISOString(),
    });

    nodes.push({ id: screenId, url: syntheticUrl, title: modal.title, depth });
    if (parentScreenId) edges.push({ from: parentScreenId, to: screenId, label: discoveredVia });
    pagesDone += 1;
  }

  while (queue.length && pagesDone < maxPages) {
    const item = queue.shift();
    const normUrl = normalizeUrl(item.url);

    console.log(`[crawl] (${pagesDone + 1}/${maxPages}, depth ${item.depth}) ${item.url}`);

    let response;
    try {
      response = await gotoAndSettle(page, item.url);
    } catch (err) {
      console.warn(`[crawl] failed to load ${item.url}: ${err.message}`);
      continue;
    }

    const status = response ? response.status() : null;
    if (status && status >= 400) {
      console.warn(`[crawl] skipping ${item.url} (HTTP ${status})`);
      continue;
    }

    await sleep(delayMs);

    const screenId = `${slugify(item.url)}-${shortId(normUrl)}`;
    urlToScreenId.set(normUrl, screenId);

    // Extract structured content
    const extracted = await extractScreen(page);
    extracted.screenId = screenId;
    extracted.discoveredVia = item.discoveredVia;

    if (!authProbeDone && looksLikeLoginPage(extracted, item.url)) {
      authProbeDone = true;
      const newStorageState = await promptAndAuthenticate({ browser, headless, url: item.url, extracted });
      if (newStorageState) {
        await context.close();
        context = await browser.newContext({ storageState: newStorageState, viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        queue.unshift(item); // retry this same URL now that we're authenticated
        continue;
      }
    }

    // Screenshot
    const screenDir = path.join(outDir, "screens", screenId);
    await ensureDir(screenDir);
    const screenshotPath = path.join(screenDir, "screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch((err) => {
      console.warn(`[crawl] screenshot failed for ${item.url}: ${err.message}`);
    });

    // Write per-screen markdown + json
    const markdown = toMarkdown(extracted);
    await writeText(path.join(screenDir, "content.md"), markdown);
    await writeJson(path.join(screenDir, "meta.json"), {
      screenId,
      url: item.url,
      normalizedUrl: normUrl,
      depth: item.depth,
      discoveredVia: item.discoveredVia,
      title: extracted.title,
      httpStatus: status,
      crawledAt: new Date().toISOString(),
    });

    nodes.push({
      id: screenId,
      url: item.url,
      title: extracted.title,
      depth: item.depth,
    });

    if (item.parentScreenId) {
      edges.push({ from: item.parentScreenId, to: screenId, label: item.discoveredVia });
    }

    pagesDone += 1;

    // Queue up new links found on this page
    if (item.depth < maxDepth) {
      for (const link of extracted.links) {
        if (sameOriginOnly && !sameOrigin(link.href, startUrl)) continue;
        const normLink = normalizeUrl(link.href);
        if (visited.has(normLink)) continue;
        // Skip obvious non-navigable / file-download links
        if (/\.(pdf|zip|jpg|jpeg|png|gif|svg|mp4|mp3|csv|docx?|xlsx?)(\?|$)/i.test(normLink)) continue;

        visited.add(normLink);
        queue.push({
          url: link.href,
          depth: item.depth + 1,
          discoveredVia: `link: "${link.text}"`,
          parentScreenId: screenId,
        });
      }

      // SPA fallback: probe non-anchor clickables (routers without real hrefs) in a scratch page.
      const candidates = (extracted.navCandidates || []).slice(0, maxClickCandidates);
      for (let i = 0; i < candidates.length; i++) {
        let probeResult;
        try {
          probeResult = await probeClickNavigation(context, item.url, i);
        } catch (err) {
          console.warn(`[crawl] click-nav probe failed for "${candidates[i]}" on ${item.url}: ${err.message}`);
          continue;
        }
        if (!probeResult) continue;

        if (probeResult.type === "modal") {
          if (pagesDone >= maxPages) {
            await probeResult.page.close().catch(() => { });
            continue;
          }
          await persistModalScreen({
            modalPage: probeResult.page,
            modal: probeResult.modal,
            baseUrl: item.url,
            label: candidates[i],
            depth: item.depth + 1,
            parentScreenId: screenId,
          });
          continue;
        }

        const resultUrl = probeResult.url;
        const normResult = normalizeUrl(resultUrl);
        if (normResult === normUrl || visited.has(normResult)) continue;
        if (sameOriginOnly && !sameOrigin(resultUrl, startUrl)) continue;
        if (/\.(pdf|zip|jpg|jpeg|png|gif|svg|mp4|mp3|csv|docx?|xlsx?)(\?|$)/i.test(normResult)) continue;

        visited.add(normResult);
        queue.push({
          url: resultUrl,
          depth: item.depth + 1,
          discoveredVia: `click: "${candidates[i]}"`,
          parentScreenId: screenId,
        });
      }

      // Query-driven content: safely probe GET forms (search/filter/pagination) for their result URL.
      // POST/PUT/etc. forms and anything with a password field are never auto-submitted.
      const forms = extracted.forms.slice(0, maxFormsPerPage);
      for (let i = 0; i < forms.length; i++) {
        const form = forms[i];
        if ((form.method || "get").toLowerCase() !== "get") continue;
        if (form.fields.some((f) => f.type === "password")) continue;

        let resultUrl;
        try {
          resultUrl = await probeFormSubmission(context, item.url, i);
        } catch (err) {
          console.warn(`[crawl] form probe failed on ${item.url}: ${err.message}`);
          continue;
        }
        if (!resultUrl) continue;

        const normResult = normalizeUrl(resultUrl);
        if (normResult === normUrl || visited.has(normResult)) continue;
        if (sameOriginOnly && !sameOrigin(resultUrl, startUrl)) continue;
        if (/\.(pdf|zip|jpg|jpeg|png|gif|svg|mp4|mp3|csv|docx?|xlsx?)(\?|$)/i.test(normResult)) continue;

        visited.add(normResult);
        queue.push({
          url: resultUrl,
          depth: item.depth + 1,
          discoveredVia: `form: "${form.action || item.url}"`,
          parentScreenId: screenId,
        });
      }
    }
  }

  await context.close();

  // Write the navigation graph + top-level index
  await writeJson(path.join(outDir, "graph.json"), { nodes, edges });
  await writeText(path.join(outDir, "index.md"), buildIndex(nodes, edges, options));

  return { nodes, edges, pagesDone };
}

function buildIndex(nodes, edges, options) {
  const lines = [];
  lines.push(`# Knowledge base: ${options.startUrl}`);
  lines.push("");
  lines.push(`Crawled ${nodes.length} screen(s) starting from ${options.startUrl}.`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Screens");
  lines.push("");
  nodes
    .sort((a, b) => a.depth - b.depth)
    .forEach((n) => {
      lines.push(`- **${n.title || "(untitled)"}** (depth ${n.depth}) — \`${n.url}\``);
      lines.push(`  - content: \`screens/${n.id}/content.md\``);
      lines.push(`  - screenshot: \`screens/${n.id}/screenshot.png\``);
    });
  lines.push("");
  lines.push("## Navigation graph");
  lines.push("");
  lines.push("See `graph.json` for the full machine-readable node/edge graph. Summary:");
  lines.push("");
  edges.forEach((e) => lines.push(`- \`${e.from}\` --(${e.label})--> \`${e.to}\``));
  lines.push("");
  lines.push("## How to use this with an LLM");
  lines.push("");
  lines.push(
    "Concatenate the `content.md` files (or feed `graph.json` + individual files) into your LLM's " +
    "context, or embed each `content.md` chunk into a vector store for RAG. Each screen file is " +
    "self-contained: it names the URL, how it was reached, what's on it, and what actions/forms are available."
  );
  lines.push("");
  return lines.join("\n");
}
