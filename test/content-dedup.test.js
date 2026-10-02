import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BrowserManager } from "../src/browser/browser-manager.js";
import { Crawler } from "../src/crawl/crawler.js";
import { createLogger } from "../src/core/logger.js";
import { computeStateFingerprint } from "../src/crawl/state-fingerprint.js";

test("fingerprint detects a new customer even when structure stays the same", () => {
  const empty = { title: "Customers", headings: [{ text: "Customers" }], bodyText: "No customers", links: [] };
  const populated = { ...empty, bodyText: "Customer 123", links: [{ href: "http://crawler.test/customers/123", text: "Customer 123" }] };
  assert.notEqual(computeStateFingerprint(empty), computeStateFingerprint(populated));
});

// Two different routes rendering byte-for-byte the same screen (title, heading, and button/link
// counts all match) - the click/form discovery pass should only ever run once across them.
const DUPLICATE_SCREEN = (otherHref) =>
  `<title>Same</title><h1>Same</h1><button id="dup-btn" onclick="recordClick(document.title + location.pathname)">Click</button><a href="${otherHref}">Other</a>`;

const PAGES = {
  "/": `<a href="/dup1">One</a><a href="/dup2">Two</a>`,
  "/dup1": DUPLICATE_SCREEN("/dup2"),
  "/dup2": DUPLICATE_SCREEN("/dup1"),
};

test("identical-content screens reached via different routes are only click-probed once", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-dedup-"));
  try {
    const clicks = [];
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.exposeFunction("recordClick", (id) => clicks.push(id));
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
      concurrency: 1, // deterministic ordering for this assertion
    });

    const urls = result.nodes.map((n) => n.url).sort();
    assert.deepEqual(urls, ["http://crawler.test/", "http://crawler.test/dup1", "http://crawler.test/dup2"]);
    // Both screens are still written/recorded, but the identical button is only ever clicked once.
    assert.equal(clicks.length, 1);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
