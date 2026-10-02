import path from "node:path";
import fs from "node:fs/promises";
import { gotoAndSettle, settleAfterAction, waitForContentReady } from "../browser/navigation.js";
import { extractScreen } from "../extraction/screen-extractor.js";
import { probeClickNavigation } from "../discovery/click-probe.js";
import { getCandidateSnapshot } from "../discovery/dom-snapshot.js";
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
import { computeStateFingerprint, computeProbeFingerprint, pageSignature } from "./state-fingerprint.js";

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

    const baselineDir = config.baselineDir || outDir;
    const checkpointPath = path.join(baselineDir, "crawl-state.json");
    const checkpoint = await fs.readFile(checkpointPath, "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (checkpoint && (checkpoint.version !== 1 || normalizeUrl(checkpoint.startUrl) !== normalizeUrl(startUrl))) {
      throw new Error("Saved crawl does not match this starting URL or checkpoint version.");
    }
    const incremental = checkpoint && checkpoint.maxDepth === maxDepth && checkpoint.sameOriginOnly === sameOriginOnly;
    if (checkpoint && !incremental) this.#logger.warn("Crawl settings changed; running a fresh crawl.");
    const previousPages = new Map(incremental ? checkpoint.pages.map((entry) => [normalizeUrl(entry.url), entry]) : []);
    const priorGraph = incremental ? JSON.parse(await fs.readFile(path.join(baselineDir, "graph.json"), "utf8")) : {};
    const queue = new CrawlQueue();
    const graph = new GraphStore(priorGraph);
    const screenWriter = new ScreenWriter(outDir, this.#logger);
    const appMap = incremental ? JSON.parse(await fs.readFile(path.join(baselineDir, "app-map.json"), "utf8")) : [];
    const modules = incremental ? await Promise.all(graph.nodes.map(async (node) => ({
      title: node.title || node.id,
      markdown: await fs.readFile(path.join(baselineDir, "modules", `${node.id}.md`), "utf8"),
      id: node.id,
    }))) : [];
    const authState = { probeDone: false }; // only ask to authenticate once per crawl run, across all workers
    const counters = { pagesDone: 0 }; // shared mutable count, since plain numbers can't be passed by reference across workers

    await screenWriter.init();
    if (incremental && baselineDir !== outDir) {
      await fs.cp(path.join(baselineDir, "screens"), path.join(outDir, "screens"), { recursive: true });
      await fs.cp(path.join(baselineDir, "modules"), path.join(outDir, "modules"), { recursive: true });
    }
    for (const entry of previousPages.values()) {
      if (normalizeUrl(entry.url) === normalizeUrl(startUrl)) continue;
      queue.markVisited(normalizeUrl(entry.url));
      queue.push({ url: entry.url, depth: entry.depth, discoveredVia: entry.discoveredVia,
        parentScreenId: entry.parentScreenId, fromUrl: entry.fromUrl });
    }
    queue.seed({ url: startUrl, depth: 0, discoveredVia: "seed" }, normalizeUrl(startUrl));

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
      previousPages,
    };

    const workerCount = Math.max(1, concurrency);
    if (workerCount > 1) this.#logger.info(`crawling with ${workerCount} parallel workers`);
    shared.concurrency = workerCount; // also used to bound concurrent click/form probing within one screen
    try {
      if (incremental) {
        let retryAuth;
        do {
          const item = await queue.next();
          const contextBefore = contextRef.current;
          try {
            await this.#processItem(item, shared);
          } finally {
            queue.finish();
          }
          retryAuth = contextBefore !== contextRef.current;
        } while (retryAuth);
      }
      await Promise.all(Array.from({ length: workerCount }, () => this.#runWorker(shared)));
    } finally {
      queue.stop();
      await Promise.all(allContexts.map((ctx) => ctx.close().catch(() => { })));
    }

    graph.retainReachable(`${slugify(startUrl)}-${shortId(normalizeUrl(startUrl))}`);
    const retained = new Set(graph.nodes.map((node) => node.id));
    for (const [url] of previousPages) {
      if (!graph.nodes.some((node) => normalizeUrl(node.url) === url)) previousPages.delete(url);
    }
    for (let index = appMap.length - 1; index >= 0; index--) {
      if (!retained.has(appMap[index].slug)) appMap.splice(index, 1);
    }
    for (let index = modules.length - 1; index >= 0; index--) {
      if (!retained.has(modules[index].id)) modules.splice(index, 1);
    }

    await writeJson(path.join(outDir, "graph.json"), graph.toJSON());
    await writeText(path.join(outDir, "index.md"), buildIndex(graph.nodes, graph.edges, config));

    const generatedAt = new Date().toISOString();
    await writeJson(path.join(outDir, "app-map.json"), appMap);
    await writeText(path.join(outDir, "knowledge-base.md"), buildKnowledgeBaseMarkdown(modules, { startUrl, generatedAt }));
    await writeJson(
      path.join(outDir, "index.json"),
      buildManifest(appMap, { startUrl, generatedAt, pagesDone: counters.pagesDone, maxPages, maxDepth })
    );
    await writeJson(path.join(outDir, "crawl-state.json"), {
      version: 1, startUrl, maxDepth, sameOriginOnly, pages: [...previousPages.values()],
    });

    return { nodes: graph.nodes, edges: graph.edges, pagesDone: counters.pagesDone };
  }

  // Idle workers wait for pages discovered by other workers instead of exiting when the stack
  // is briefly empty. The queue hands each item to exactly one worker.
  async #runWorker(shared) {
    const { queue, counters, maxPages } = shared;
    while (counters.pagesDone < maxPages) {
      const item = await queue.next();
      if (!item) break;
      try {
        await this.#processItem(item, shared);
      } catch (error) {
        queue.stop();
        throw error;
      } finally {
        if (counters.pagesDone >= maxPages) queue.stop();
        queue.finish();
      }
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
      previousPages,
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
      if (item.fromUrl && normalizeUrl(page.url()) !== normUrl) {
        if (!(await this.#retryViaClientNav(page, item)) || normalizeUrl(page.url()) !== normUrl) {
          this.#logger.warn(`skipping ${item.url} (redirected to ${page.url()})`);
          return;
        }
        response = null;
      }

      if (!(await waitForContentReady(page)) && !(await waitForContentReady(page))) {
        this.#logger.warn(`content still unavailable for ${item.url}; leaving it uncaptured for a later crawl`);
        return;
      }

      const previous = previousPages.get(normUrl);
      if (previous && normalizeUrl(page.url()) === normUrl && !(await page.locator('input[type="password"]').count())) {
        const signature = await pageSignature(page);
        if (signature === previous.signature) {
          this.#logger.info(`unchanged: ${item.url}`);
          return;
        }
      }

      if (!previous) await sleep(delayMs);

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

      const signature = await pageSignature(page);

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

      if (previous && looksLikeLoginPage(extracted, item.url)) {
        throw new Error(`Login is required to refresh ${item.url}; previous crawl was left unchanged.`);
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
      const mapEntry = buildAppMapEntry(extracted, { url: item.url, screenId });
      const mapIndex = appMap.findIndex((entry) => entry.slug === screenId);
      if (mapIndex === -1) appMap.push(mapEntry);
      else appMap[mapIndex] = mapEntry;
      const moduleEntry = { id: screenId, title: extracted.title || screenId, markdown };
      const moduleIndex = modules.findIndex((entry) => entry.id === screenId);
      if (moduleIndex === -1) modules.push(moduleEntry);
      else modules[moduleIndex] = moduleEntry;

      graph.addNode({ id: screenId, url: item.url, title: extracted.title, depth: item.depth });
      graph.addEdge({ from: item.parentScreenId, to: screenId, label: item.discoveredVia });
      if (previous) graph.clearOutgoing(screenId);
      previousPages.set(normUrl, { url: item.url, depth: item.depth, discoveredVia: item.discoveredVia,
        parentScreenId: item.parentScreenId, fromUrl: item.fromUrl, signature });
      counters.pagesDone += 1;

      if (item.depth < maxDepth) {
        this.#enqueueLinks({ queue, graph, extracted, item, screenId, startUrl, sameOriginOnly });

        // A different route rendering byte-for-byte the same screen (templated placeholder
        // pages, a nav link whose route never actually swapped content, ...) would otherwise
        // get every one of its buttons/menus/forms probed all over again for no new discovery -
        // only the first route to show this exact content gets the expensive probing pass.
        const probeFingerprint = computeProbeFingerprint(extracted);
        if (!previous && queue.hasProbedContent(probeFingerprint)) {
          this.#logger.debug(`skipping click/form discovery on ${item.url} - identical content already probed elsewhere`);
        } else {
          queue.markProbedContent(probeFingerprint);

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
            graph,
            probeConcurrency: shared.concurrency,
          });
        }
      }
    } finally {
      await page.close().catch(() => { });
    }
  }

  // Queues up same-page <a href> links found on this screen.
  #enqueueLinks({ queue, graph, extracted, item, screenId, startUrl, sameOriginOnly }) {
    for (const link of extracted.links) {
      if (sameOriginOnly && !sameSite(link.href, startUrl)) continue;
      const normLink = normalizeUrl(link.href);
      if (!isNavigable(normLink)) continue;
      const known = graph.nodes.find((node) => normalizeUrl(node.url) === normLink);
      if (known) graph.addEdge({ from: screenId, to: known.id, label: `link: "${link.text}"` });
      if (queue.hasVisited(normLink)) continue;

      queue.markVisited(normLink);
      queue.push({
        url: link.href,
        depth: item.depth + 1,
        discoveredVia: `link: "${link.text}"`,
        parentScreenId: screenId,
        fromUrl: item.url,
        actionPath: item.actionPath,
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
      for (const action of item.actionPath || []) {
        const current = (await getCandidateSnapshot(page)).find((entry) => entry.key === action.key && entry.label === action.label);
        if (!current) return false;
        const before = page.url();
        await page.locator(`[data-cw-id="${current.id}"]`).click({ timeout: 3000 });
        await settleAfterAction(page, before);
      }
      const linkId = await page.evaluate((target) => {
        const link = window.__crawlerHelpers.deepQueryAll("a[href]").find((anchor) => anchor.href === target);
        return link ? window.__crawlerHelpers.ensureCwId(link) : null;
      }, item.url);
      if (!linkId) return false;
      const before = page.url();
      await page.locator(`[data-cw-id="${linkId}"]`).click({ timeout: 3000 });
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
    const stateIds = new Map();

    const parentFor = (path) => {
      for (let length = path.length - 1; length > 0; length--) {
        const id = stateIds.get(JSON.stringify(path.slice(0, length).map(({ key, label }) => [key, label])));
        if (id) return id;
      }
      return screenId;
    };

    if (candidates.length) {
      this.#logger.debug(`probing ${candidates.length} clickable candidate(s) on ${item.url}`);
    }

    const captureResult = async (probeResult) => {
      const label = probeResult.label;
      const parentScreenId = parentFor(probeResult.path || []);
      if (probeResult.type === "state") {
        const depth = item.depth + probeResult.depth;
        if (depth > maxDepth || counters.pagesDone >= maxPages) return;
        const syntheticUrl = `${item.url}#state:${shortId(probeResult.signature)}`;
        const stateScreenId = `${slugify(syntheticUrl)}-${shortId(syntheticUrl)}`;
        const pathKey = JSON.stringify(probeResult.path.map(({ key, label }) => [key, label]));
        stateIds.set(pathKey, stateScreenId);
        graph.addEdge({ from: parentScreenId, to: stateScreenId, label: `click: "${label}"` });
        if (graph.nodes.some((node) => node.id === stateScreenId)) return;

        const stateExtracted = await extractScreen(probeResult.page);
        stateExtracted.screenId = stateScreenId;
        stateExtracted.discoveredVia = `click: "${label}"`;
        const { markdown } = await screenWriter.writeScreen({
          page: probeResult.page, extracted: stateExtracted, screenId: stateScreenId,
          url: syntheticUrl, normalizedUrl: syntheticUrl, depth,
          discoveredVia: stateExtracted.discoveredVia, status: null,
        });
        appMap.push(buildAppMapEntry(stateExtracted, { url: syntheticUrl, screenId: stateScreenId }));
        modules.push({ id: stateScreenId, title: stateExtracted.title || stateScreenId, markdown });
        graph.addNode({ id: stateScreenId, url: syntheticUrl, title: stateExtracted.title, depth });
        counters.pagesDone += 1;
        if (depth < maxDepth) {
          this.#enqueueLinks({ queue, graph, extracted: stateExtracted,
            item: { ...item, depth, actionPath: probeResult.path.map(({ key, label }) => ({ key, label })) },
            screenId: stateScreenId, startUrl, sameOriginOnly });
        }
        return;
      }
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
        const modalEntry = buildAppMapEntry(modalExtracted, { url: syntheticUrl, screenId: modalScreenId });
        const modalIndex = appMap.findIndex((entry) => entry.slug === modalScreenId);
        if (modalIndex === -1) appMap.push(modalEntry);
        else appMap[modalIndex] = modalEntry;
        const modalModule = { id: modalScreenId, title: modalExtracted.title || modalScreenId, markdown: modalMarkdown };
        const moduleIndex = modules.findIndex((entry) => entry.id === modalScreenId);
        if (moduleIndex === -1) modules.push(modalModule);
        else modules[moduleIndex] = modalModule;

        graph.addNode({ id: modalScreenId, url: syntheticUrl, title: modalExtracted.title, depth: item.depth + 1 });
        graph.addEdge({ from: parentScreenId, to: modalScreenId, label: discoveredVia });
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
      if (normResult === normalizeUrl(item.url)) return;
      if (sameOriginOnly && !sameSite(resultUrl, startUrl)) return;
      if (!isNavigable(normResult)) return;
      const known = graph.nodes.find((node) => normalizeUrl(node.url) === normResult);
      if (known) graph.addEdge({ from: parentScreenId, to: known.id, label: `click: "${label}"` });
      if (queue.hasVisited(normResult)) return;

      queue.markVisited(normResult);
      queue.push({
        url: resultUrl,
        depth: item.depth + (probeResult.path?.length || 1),
        discoveredVia: `click: "${label}"`,
        parentScreenId,
        fromUrl: item.url,
        actionPath: probeResult.path?.map(({ key, label }) => ({ key, label })),
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
          maxNestedClicks: Math.max(0, maxDepth - item.depth),
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
  async #discoverForms({ context, extracted, item, screenId, startUrl, sameOriginOnly, maxFormsPerPage, queue, graph, probeConcurrency = 1 }) {
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
      if (normResult === normUrl) return;
      if (sameOriginOnly && !sameSite(resultUrl, startUrl)) return;
      if (!isNavigable(normResult)) return;
      const known = graph.nodes.find((node) => normalizeUrl(node.url) === normResult);
      if (known) graph.addEdge({ from: screenId, to: known.id, label: `form: "${form.action || item.url}"` });
      if (queue.hasVisited(normResult)) return;

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
