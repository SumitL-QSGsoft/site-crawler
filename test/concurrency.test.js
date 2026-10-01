import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BrowserManager } from "../src/browser/browser-manager.js";
import { Crawler } from "../src/crawl/crawler.js";
import { createLogger } from "../src/core/logger.js";

// A handful of plain, interlinked pages - enough to exercise several workers pulling from the
// shared DFS stack at once without any one worker draining it before the others start.
const PAGES = {
  "/": `<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a>`,
  "/a": `<a href="/">Home</a><p>Page A</p>`,
  "/b": `<a href="/">Home</a><p>Page B</p>`,
  "/c": `<a href="/">Home</a><p>Page C</p>`,
  "/d": `<a href="/">Home</a><p>Page D</p>`,
};

test("concurrent workers crawl every page exactly once via the shared DFS stack", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-concurrency-"));
  try {
    const context = await browserManager.raw.newContext();
    await context.route("http://crawler.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = PAGES[pathname];
      if (!body) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ contentType: "text/html", body });
    });
    await context.close();

    // BrowserManager has no route-registration hook of its own, so patch newContext just for
    // this test to apply the same route to every context a worker opens (including the one
    // created after any auth swap, though none happens in this fixture).
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const body = PAGES[pathname];
        if (!body) return route.fulfill({ status: 404, body: "not found" });
        return route.fulfill({ contentType: "text/html", body });
      });
      return ctx;
    };

    const logger = createLogger("test", { level: "error" });
    const crawler = new Crawler({ browserManager, logger });
    const result = await crawler.run({
      startUrl: "http://crawler.test/",
      maxPages: 10,
      maxDepth: 3,
      delayMs: 0,
      sameOriginOnly: true,
      outDir,
      headless: true,
      interactive: false,
      concurrency: 3,
    });

    assert.equal(result.pagesDone, 5);
    const urls = result.nodes.map((n) => n.url).sort();
    assert.deepEqual(urls, [
      "http://crawler.test/",
      "http://crawler.test/a",
      "http://crawler.test/b",
      "http://crawler.test/c",
      "http://crawler.test/d",
    ]);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
