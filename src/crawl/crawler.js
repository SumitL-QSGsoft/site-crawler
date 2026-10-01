import path from "node:path";
import { gotoAndSettle, settleAfterAction } from "../browser/navigation.js";
import { extractScreen } from "../extraction/screen-extractor.js";
import { probeClickNavigation } from "../discovery/click-probe.js";
import { probeFormSubmission } from "../discovery/form-probe.js";
import { looksLikeLoginPage, verifyLoginSucceeded } from "../auth/login-wall.js";
import { promptAndAuthenticate } from "../auth/interactive-prompter.js";
import { resolveAuth } from "../auth/auth-service.js";
import { normalizeUrl, sameSite, isNavigable } from "../util/url-utils.js";
import { shortId, slugify } from "../util/hash.js";
import { writeJson, writeText } from "../util/fs-utils.js";
import { selectorForField } from "../util/selector-utils.js";
import { sleep, mapLimit } from "../util/async-utils.js";
import { GraphStore } from "./graph-store.js";
import { ScreenWriter } from "./screen-writer.js";
import { CrawlQueue } from "./crawl-queue.js";
import { buildIndex } from "./index-builder.js";
import { buildAppMapEntry, buildKnowledgeBaseMarkdown, buildManifest } from "./app-map-builder.js";
import { computeStateFingerprint } from "./state-fingerprint.js";

const DEFAULT_MAX_CLICK_CANDIDATES = Infinity;
const DEFAULT_MAX_FORMS_PER_PAGE = 10;

/**
 * DFS crawl of a site starting at config.startUrl: each route is drained depth-first (its own
 * query-param variants, then every click/popover-revealed screen) before backtracking to a
 * sibling route discovered earlier - see CrawlQueue's stack ordering. Orchestrates navigation,
 * extraction, SPA click/form discovery, modal capture, and an interactive login-wall handshake,
 * delegating each concern to a dedicated collaborator instead of doing it all inline.
 */
export class Crawler {
  #browserManager;
  #logger;

  constructor({ browserManager, logger }) {
    this.#browserManager = browserManager;
    this.#logger = logger;
  }

  async run(config) {
    const {
      startUrl,
      maxPages,
      maxDepth,
      sameOriginOnly,
      delayMs,
      outDir,
      storageState,
      headless,
      interactive = true,
      onAuthRequired,
      maxClickCandidates = DEFAULT_MAX_CLICK_CANDIDATES,
      maxFormsPerPage = DEFAULT_MAX_FORMS_PER_PAGE,
      concurrency = 1,
    } = config;

    const initialContext = await this.#browserManager.newContext({ storageState });
    // All workers share one browser context (one cookie jar) via this mutable holder, so a
    // mid-crawl login performed by any single worker is instantly visible to every other worker's
    // next page - no stop-the-world pause/resync needed. A superseded context is never force-
    // closed (that would break any worker mid-navigation on one of its pages); it's simply
    // abandoned and closed alongside every other context once the whole crawl finishes.
    const contextRef = { current: initialContext };
    const allContexts = [initialContext];

    const queue = new CrawlQueue();
    const graph = new GraphStore();
    const screenWriter = new ScreenWriter(outDir, this.#logger);
    const appMap = []; // AutoQA-style app-map.json entries, one per screen/modal written
    const modules = []; // { title, markdown } per screen/modal, for the consolidated knowledge base
    const authState = { probeDone: false }; // only ask to authenticate once per crawl run, across all workers
    const counters = { pagesDone: 0 }; // shared mutable count, since plain numbers can't be passed by reference across workers

    queue.seed({ url: startUrl, depth: 0, discoveredVia: "seed" }, normalizeUrl(startUrl));
    await screenWriter.init();

    const shared = {
      startUrl,
      maxPages,
      maxDepth,
      sameOriginOnly,
      delayMs,
      outDir,
      headless,
      interactive,
      onAuthRequired,
      maxClickCandidates,
      maxFormsPerPage,
      contextRef,
      allContexts,
      queue,
      graph,
      screenWriter,
      appMap,
      modules,
      authState,
      counters,
    };

    const workerCount = Math.max(1, concurrency);
    if (workerCount > 1) this.#logger.info(`crawling with ${workerCount} parallel workers`);
    shared.concurrency = workerCount; // also used to bound concurrent click/form probing within one screen
    await Promise.all(Array.from({ length: workerCount }, () => this.#runWorker(shared)));

    await Promise.all(allContexts.map((ctx) => ctx.close().catch(() => { })));

    await writeJson(path.join(outDir, "graph.json"), graph.toJSON());
    await writeText(path.join(outDir, "index.md"), buildIndex(graph.nodes, graph.edges, config));

    const generatedAt = new Date().toISOString();
    await writeJson(path.join(outDir, "app-map.json"), appMap);
    await writeText(path.join(outDir, "knowledge-base.md"), buildKnowledgeBaseMarkdown(modules, { startUrl, generatedAt }));
    await writeJson(
      path.join(outDir, "index.json"),
      buildManifest(appMap, { startUrl, generatedAt, pagesDone: counters.pagesDone, maxPages, maxDepth })
    );

    return { nodes: graph.nodes, edges: graph.edges, pagesDone: counters.pagesDone };
  }

  // Keeps pulling the next item off the shared DFS stack until it's drained or the page budget
  // runs out. Safe to run several of these concurrently: the check-then-pop in CrawlQueue#shift
  // is synchronous (no `await` in between), so two workers can never race for the same item.
  async #runWorker(shared) {
    const { queue, counters, maxPages } = shared;
    while (queue.length && counters.pagesDone < maxPages) {
      const item = queue.shift();
      if (!item) break;
      await this.#processItem(item, shared);
    }
  }

  // Everything that used to be the body of the single-threaded while-loop, now parameterized so
  // any number of workers can run it concurrently against the same shared queue/graph/counters.
  async #processItem(item, shared) {
    const {
      contextRef,
      allContexts,
      queue,
      graph,
      screenWriter,
      appMap,
      modules,
      authState,
      counters,
      startUrl,
      maxPages,
      maxDepth,
      sameOriginOnly,
      delayMs,
      outDir,
      headless,
      interactive,
      onAuthRequired,
      maxClickCandidates,
      maxFormsPerPage,
    } = shared;

    const normUrl = normalizeUrl(item.url);
    const context = contextRef.current; // snapshot once - stays valid for this item even if auth swaps it out for the next one
    const page = await context.newPage();

    try {
      this.#logger.info(`(${counters.pagesDone + 1}/${maxPages}, depth ${item.depth}) ${item.url}`);

      let response;
      try {
        response = await gotoAndSettle(page, item.url);
      } catch (err) {
        if (!(await this.#retryViaClientNav(page, item))) {
          this.#logger.warn(`failed to load ${item.url}: ${err.message}`);
          return;
        }
        response = null; // already settled on the real content via a client-side nav replay below
      }

      const status = response ? response.status() : null;
      if (status && status >= 400 && !(await this.#retryViaClientNav(page, item))) {
        this.#logger.warn(`skipping ${item.url} (HTTP ${status})`);
        return;
      }

      await sleep(delayMs);

      const screenId = `${slugify(item.url)}-${shortId(normUrl)}`;
      const extracted = await extractScreen(page);
      extracted.screenId = screenId;
      extracted.discoveredVia = item.discoveredVia;

      // Guards against SPA state changes that loop back to an already-seen screen without ever
      // changing the URL (e.g. a "close" action that just re-renders the same list) - a URL-only
      // visited set can't catch that and would otherwise keep re-processing/re-clicking it forever.
      const contentFingerprint = computeStateFingerprint(extracted);
      const stateFingerprint = `${normUrl}::${contentFingerprint}`;
      if (item.discoveredVia !== "seed" && queue.hasVisitedState(stateFingerprint)) {
        this.#logger.debug(`skipping ${item.url} - already captured this exact screen state`);
        return;
      }
      queue.markVisitedState(stateFingerprint);

      if (!authState.probeDone && looksLikeLoginPage(extracted, item.url)) {
        // Setting this synchronously (before any `await` below) means only the first worker to
        // reach this line ever performs the handshake, even with several running concurrently.
        authState.probeDone = true;
        if (interactive) {
          const newStorageState = await promptAndAuthenticate({
            browserManager: this.#browserManager,
            headless,
            url: item.url,
            extracted,
            logger: this.#logger,
          });
          if (newStorageState) {
            const newContext = await this.#browserManager.newContext({ storageState: newStorageState });
            allContexts.push(newContext);
            contextRef.current = newContext;
            queue.unshift(item); // retry this same URL now that we're authenticated
            return;
          }
        } else if (onAuthRequired) {
          // No terminal to prompt (e.g. driven by the web server) - ask the caller-supplied
          // callback instead, which is expected to resolve with { username, password } (from a
          // web form) once the user submits them, or null if they skip/it times out.
          const credentials = await onAuthRequired({ url: item.url, extracted }).catch((err) => {
            this.#logger.warn(`auth callback failed: ${err.message}`);
            return null;
          });

          if (credentials) {
            const fields = extracted.forms.flatMap((f) => f.fields);
            // Prefer a `name` attribute, but fall back to id/placeholder since many SPA forms
            // (React/Vue controlled inputs) skip `name` entirely.
            const userField = fields.find((f) => f.type !== "password" && selectorForField(f));
            const passField = fields.find((f) => f.type === "password" && selectorForField(f));

            if (!passField || !userField) {
              this.#logger.warn(`Couldn't find a username+password field pair on ${item.url} - can't auto-fill login, continuing without it.`);
            } else {
              const { storageState } = await resolveAuth({
                mode: "credentials",
                browserManager: this.#browserManager,
                loginUrl: item.url,
                credentials: {
                  username: credentials.username,
                  password: credentials.password,
                  usernameSelector: selectorForField(userField),
                  passwordSelector: selectorForField(passField),
                  // Don't require a literal type="submit" attribute - lots of real forms rely on
                  // the browser's implicit default (a <button> with no type inside a <form> submits
                  // it) and won't match a strict `button[type="submit"]` selector.
                  submitSelector: 'button[type="submit"], input[type="submit"], form button:not([type="button"]):not([type="reset"])',
                },
                storageStatePath: path.join(outDir, ".auth-state.json"),
                logger: this.#logger,
              }).catch((err) => {
                this.#logger.warn(`Login attempt failed for ${item.url}: ${err.message}`);
                return { storageState: undefined };
              });

              if (storageState) {
                const ok = await verifyLoginSucceeded(this.#browserManager, storageState, item.url);
                if (!ok) this.#logger.warn(`Login may not have succeeded for ${item.url} (still looks like a login page).`);
                const newContext = await this.#browserManager.newContext({ storageState });
                allContexts.push(newContext);
                contextRef.current = newContext;
                queue.unshift(item); // retry this same URL now that we're authenticated
                return;
              }
            }
          } else {
            this.#logger.warn(`Login required for ${item.url} but no credentials were provided - continuing without it.`);
          }
        } else {
          // No terminal to prompt (e.g. driven by the web server) - never block on stdin, just
          // note it once and keep crawling/writing this screen as-is.
          this.#logger.warn(`Looks like a login page (${item.url}) - skipping interactive auth prompt.`);
        }
      }

      const { markdown } = await screenWriter.writeScreen({
        page,
        extracted,
        screenId,
        url: item.url,
        normalizedUrl: normUrl,
        depth: item.depth,
        discoveredVia: item.discoveredVia,
        status,
      });
      appMap.push(buildAppMapEntry(extracted, { url: item.url, screenId }));
      modules.push({ title: extracted.title || screenId, markdown });

      graph.addNode({ id: screenId, url: item.url, title: extracted.title, depth: item.depth });
      graph.addEdge({ from: item.parentScreenId, to: screenId, label: item.discoveredVia });
      counters.pagesDone += 1;

      if (item.depth < maxDepth) {
        this.#enqueueLinks({ queue, extracted, item, screenId, startUrl, sameOriginOnly });

        // A different route rendering byte-for-byte the same screen (templated placeholder
        // pages, a nav link whose route never actually swapped content, ...) would otherwise
        // get every one of its buttons/menus/forms probed all over again for no new discovery -
        // only the first route to show this exact content gets the expensive probing pass.
        if (queue.hasProbedContent(contentFingerprint)) {
          this.#logger.debug(`skipping click/form discovery on ${item.url} - identical content already probed elsewhere`);
        } else {
          queue.markProbedContent(contentFingerprint);

          await this.#discoverClicks({
            context,
            extracted,
            item,
            screenId,
            startUrl,
            sameOriginOnly,
            maxClickCandidates,
            maxDepth,
            queue,
            graph,
            screenWriter,
            counters,
            maxPages,
            appMap,
            modules,
            probeConcurrency: shared.concurrency,
          });

          await this.#discoverForms({
            context,
            extracted,
            item,
            screenId,
            startUrl,
            sameOriginOnly,
            maxFormsPerPage,
            queue,
            probeConcurrency: shared.concurrency,
          });
        }
      }
    } finally {
      await page.close().catch(() => { });
    }
  }

  // Queues up same-page <a href> links found on this screen.
  #enqueueLinks({ queue, extracted, item, screenId, startUrl, sameOriginOnly }) {
    for (const link of extracted.links) {
      if (sameOriginOnly && !sameSite(link.href, startUrl)) continue;
      const normLink = normalizeUrl(link.href);
      if (queue.hasVisited(normLink) || !isNavigable(normLink)) continue;

      queue.markVisited(normLink);
      queue.push({
        url: link.href,
        depth: item.depth + 1,
        discoveredVia: `link: "${link.text}"`,
        parentScreenId: screenId,
        fromUrl: item.url,
      });
    }
  }

  // A deep-linked route can 404 (or redirect away) on a direct goto() even though it's perfectly
  // reachable by clicking through the app - common for client-only SPAs the host serves with no
  // history-API fallback, where only an in-app client-side navigation actually resolves the route.
  // Replays just the one hop that discovered it: reload the referring screen, then click the exact
  // anchor instead of hard-navigating, so the SPA's own router (not a fresh server request) handles it.
  async #retryViaClientNav(page, item) {
    if (!item.fromUrl) return false;
    try {
      await gotoAndSettle(page, item.fromUrl);
      const escapedHref = item.url.replace(/"/g, '\\"');
      const link = page.locator(`a[href="${escapedHref}"]`).first();
      if (!(await link.count())) return false;
      const before = page.url();
      await link.click({ timeout: 3000 });
      await settleAfterAction(page, before);
      return normalizeUrl(page.url()) !== normalizeUrl(before);
    } catch {
      return false;
    }
  }

  // SPA fallback: probes non-anchor clickables (routers without real hrefs) in scratch pages,
  // queuing real navigations and persisting any modals opened along the way.
  async #discoverClicks({
    context,
    extracted,
    item,
    screenId,
    startUrl,
    sameOriginOnly,
    maxClickCandidates,
    maxDepth,
    queue,
    graph,
    screenWriter,
    counters,
    maxPages,
    appMap,
    modules,
    probeConcurrency = 1,
  }) {
    const candidates = (extracted.navCandidates || []).slice(0, maxClickCandidates);
    const visitedActions = new Set();

    if (candidates.length) {
      this.#logger.debug(`probing ${candidates.length} clickable candidate(s) on ${item.url}`);
    }

    const captureResult = async (probeResult) => {
      const label = probeResult.label;
      if (probeResult.type === "modal") {
        if (counters.pagesDone >= maxPages) return;
        const syntheticUrl = `${item.url}#modal:${slugify(label)}-${shortId(probeResult.key)}`;
        const modalScreenId = `${slugify(syntheticUrl)}-${shortId(syntheticUrl)}`;
        const discoveredVia = `modal: "${label}"`;

        const { extracted: modalExtracted, markdown: modalMarkdown } = await screenWriter.writeModalScreen({
          modalPage: probeResult.page,
          modal: probeResult.modal,
          screenId: modalScreenId,
          baseUrl: item.url,
          syntheticUrl,
          depth: item.depth + 1,
          discoveredVia,
          label,
          closePage: false,
        });
        appMap.push(buildAppMapEntry(modalExtracted, { url: syntheticUrl, screenId: modalScreenId }));
        modules.push({ title: modalExtracted.title || modalScreenId, markdown: modalMarkdown });

        graph.addNode({ id: modalScreenId, url: syntheticUrl, title: modalExtracted.title, depth: item.depth + 1 });
        graph.addEdge({ from: screenId, to: modalScreenId, label: discoveredVia });
        counters.pagesDone += 1;

        // Real links inside the modal (e.g. a row in a "users" list dialog) so items like
        // /user/123 opened from a modal get crawled too, not just links on the plain page.
        if (item.depth + 1 < maxDepth) {
          for (const link of modalExtracted.links) {
            if (sameOriginOnly && !sameSite(link.href, startUrl)) continue;
            const normLink = normalizeUrl(link.href);
            if (queue.hasVisited(normLink) || !isNavigable(normLink)) continue;

            queue.markVisited(normLink);
            queue.push({
              url: link.href,
              depth: item.depth + 2,
              discoveredVia: `modal link: "${link.text}"`,
              parentScreenId: modalScreenId,
              fromUrl: item.url,
            });
          }
        }
        return;
      }

      const resultUrl = probeResult.url;
      const normResult = normalizeUrl(resultUrl);
      if (normResult === normalizeUrl(item.url) || queue.hasVisited(normResult)) return;
      if (sameOriginOnly && !sameSite(resultUrl, startUrl)) return;
      if (!isNavigable(normResult)) return;

      queue.markVisited(normResult);
      queue.push({
        url: resultUrl,
        depth: item.depth + 1,
        discoveredVia: `click: "${label}"`,
        parentScreenId: screenId,
        fromUrl: item.url,
      });
    };

    // A per-page identity set is shared with nested menu probes, not a global label set.
    // This clicks same-label buttons separately without repeating items exposed by a prior click.
    // Each candidate is its own scratch-page navigation, so several run concurrently (bounded by
    // probeConcurrency) rather than paying for one full page load/settle at a time.
    await mapLimit(candidates, probeConcurrency, async ({ label, key }, index) => {
      if (visitedActions.has(key)) return;
      this.#logger.debug(`  click-probe ${index + 1}/${candidates.length}: "${label}"`);
      try {
        await probeClickNavigation(context, item.url, index, {
          expectedLabel: label,
          expectedKey: key,
          visitedActions,
          onResult: captureResult,
        });
      } catch (err) {
        this.#logger.warn(`click-nav probe failed for "${label}" on ${item.url}: ${err.message}`);
      }
    });
  }

  // Query-driven content: safely probes GET forms (search/filter/pagination) for their result URL.
  // POST/PUT/etc. forms and anything with a password field are never auto-submitted.
  async #discoverForms({ context, extracted, item, screenId, startUrl, sameOriginOnly, maxFormsPerPage, queue, probeConcurrency = 1 }) {
    const forms = extracted.forms.slice(0, maxFormsPerPage);
    const normUrl = normalizeUrl(item.url);

    if (forms.length) {
      this.#logger.debug(`probing ${forms.length} form(s) on ${item.url}`);
    }

    await mapLimit(forms, probeConcurrency, async (form, i) => {
      if ((form.method || "get").toLowerCase() !== "get") return;
      if (form.fields.some((f) => f.type === "password")) return;

      this.#logger.debug(`  form-probe ${i + 1}/${forms.length}`);
      let resultUrl;
      try {
        resultUrl = await probeFormSubmission(context, item.url, i);
      } catch (err) {
        this.#logger.warn(`form probe failed on ${item.url}: ${err.message}`);
        return;
      }
      if (!resultUrl) return;

      const normResult = normalizeUrl(resultUrl);
      if (normResult === normUrl || queue.hasVisited(normResult)) return;
      if (sameOriginOnly && !sameSite(resultUrl, startUrl)) return;
      if (!isNavigable(normResult)) return;

      queue.markVisited(normResult);
      queue.push({
        url: resultUrl,
        depth: item.depth + 1,
        discoveredVia: `form: "${form.action || item.url}"`,
        parentScreenId: screenId,
        fromUrl: item.url,
      });
    });
  }

}
