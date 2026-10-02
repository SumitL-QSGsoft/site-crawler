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

test("idle workers pick up pages discovered after the seed", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-workers-"));
  let active = 0;
  let peak = 0;
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname !== "/") {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 100));
          active -= 1;
        }
        await route.fulfill({ contentType: "text/html", body: PAGES[pathname] || "" });
      });
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    await crawler.run({ startUrl: "http://crawler.test/", maxPages: 5, maxDepth: 1,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 3 });
    assert.ok(peak >= 2, `expected parallel page loads, saw ${peak}`);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("incremental crawl skips unchanged screens and explores a new customer", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-incremental-"));
  const nextDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-incremental-next-"));
  let hasCustomer = false;
  let dashboardLoads = 0;
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/") dashboardLoads += 1;
        const body = pathname === "/" ? '<h1>Dashboard</h1><a href="/customers">Customers</a>'
          : pathname === "/customers" ? `<h1>Customers</h1>${hasCustomer
            ? '<a href="/customers/123">Customer 123</a>' : '<p>No customers</p>'}`
          : '<h1>Customer 123</h1><p>Details</p>';
        return route.fulfill({ contentType: "text/html", body });
      });
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const config = { startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 };
    const first = await crawler.run(config);
    assert.equal(first.pagesDone, 2);
    const dashboardBefore = await fs.readFile(path.join(outDir, "screens", first.nodes.find((node) => node.url === config.startUrl).id, "meta.json"), "utf8");
    hasCustomer = true;
    dashboardLoads = 0;
    const second = await crawler.run(config);
    assert.equal(second.pagesDone, 2);
    assert.equal(dashboardLoads, 1);
    assert.deepEqual(second.nodes.map((node) => node.url).sort(), [
      "http://crawler.test/", "http://crawler.test/customers", "http://crawler.test/customers/123",
    ]);
    assert.equal(await fs.readFile(path.join(outDir, "screens", first.nodes.find((node) => node.url === config.startUrl).id, "meta.json"), "utf8"), dashboardBefore);
    const third = await crawler.run(config);
    assert.equal(third.pagesDone, 0);
    assert.equal(third.nodes.length, 3);
    const fourth = await crawler.run({ ...config, outDir: nextDir, baselineDir: outDir });
    assert.equal(fourth.pagesDone, 0);
    assert.equal(fourth.nodes.length, 3);
    assert.equal(await fs.readFile(path.join(nextDir, "screens", first.nodes.find((node) => node.url === config.startUrl).id, "meta.json"), "utf8"), dashboardBefore);
    hasCustomer = false;
    const afterRemoval = await crawler.run({ ...config, outDir: nextDir });
    assert.equal(afterRemoval.pagesDone, 1);
    assert.deepEqual(afterRemoval.nodes.map((node) => node.url).sort(), [
      "http://crawler.test/", "http://crawler.test/customers",
    ]);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(nextDir, { recursive: true, force: true });
  }
});

test("incremental crawl refreshes content changed at the same URL", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-content-update-"));
  let customerText = "No customers";
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: `<h1>Customers</h1><p>${customerText}</p>`,
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const config = { startUrl: "http://crawler.test/", maxPages: 5, maxDepth: 2,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 };
    const first = await crawler.run(config);
    customerText = "Customer 123";
    const second = await crawler.run(config);
    assert.equal(second.pagesDone, 1);
    assert.equal(second.nodes.length, 1);
    const updated = await fs.readFile(path.join(outDir, "screens", first.nodes[0].id, "content.md"), "utf8");
    assert.match(updated, /Customer 123/);
    assert.equal((await crawler.run(config)).pagesDone, 0);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("incremental checkpoint keeps URLs normalized without losing their original screen IDs", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-tracked-url-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: "<h1>Dashboard</h1>",
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const config = { startUrl: "http://crawler.test/?utm_source=example", maxPages: 5, maxDepth: 2,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 1 };
    await crawler.run(config);
    assert.equal((await crawler.run(config)).pagesDone, 0);
    assert.equal((await crawler.run(config)).pagesDone, 0);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler captures nested conditional views at one URL", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-conditional-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html",
        body: `<main id="view"><h1>Start</h1><button onclick="show(1)">Open first</button></main>
          <script>function show(level) {
            document.querySelector('#view').innerHTML = '<h1>Level ' + level + '</h1>' +
              (level < 6 ? '<button onclick="show(' + (level + 1) + ')">Open next</button>' : '<p>Final details</p>');
          }</script>`,
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 8,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 1 });
    assert.equal(result.pagesDone, 7);
    assert.equal(result.nodes.length, 7);
    assert.deepEqual(result.nodes.map((node) => node.depth).sort(), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(result.edges.length, 6);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler follows links from later table rows", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-table-links-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: new URL(route.request().url()).pathname === "/"
          ? '<table><tbody><tr><td><a href="/one">One</a></td></tr><tr><td><a href="/two">Two</a></td></tr></tbody></table>'
          : '<h1>Detail</h1>',
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 });
    assert.deepEqual(result.nodes.map((node) => node.url).sort(), [
      "http://crawler.test/", "http://crawler.test/one", "http://crawler.test/two",
    ]);
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler replays conditional views to reach a client-only deep link", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-client-route-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => {
        if (new URL(route.request().url()).pathname !== "/") return route.fulfill({ status: 404, body: "missing" });
        return route.fulfill({ contentType: "text/html", body: `<main id="view">
          <button onclick="show(1)">First</button></main><script>
          function show(level) {
            const view = document.querySelector('#view');
            if (level === 1) {
              view.innerHTML = '<h1>One</h1><button onclick="show(2)">Next</button>';
              return;
            }
            view.innerHTML = '<h1>Two</h1>';
            const link = document.createElement('a');
            link.href = '/deep';
            link.textContent = 'Details';
            link.addEventListener('click', (event) => {
              event.preventDefault();
              history.pushState({}, '', link.href);
              view.innerHTML = '<h1>Deep detail</h1>';
            });
            view.appendChild(link);
          }</script>` });
      });
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 5,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 1 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/deep" && node.title !== "missing"),
      JSON.stringify(result.nodes));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler waits for delayed route content before discovering child links", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-delayed-render-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: new URL(route.request().url()).pathname === "/"
          ? '<nav><a href="/loading">Area</a></nav>'
          : new URL(route.request().url()).pathname === "/loading"
            ? '<nav>Area</nav><div id="app"></div><script>setTimeout(() => { document.querySelector("#app").innerHTML = \'<main><h1>Ready</h1><a href="/detail">Detail</a></main>\'; }, 3200)</script>'
            : '<main><h1>Detail</h1></main>',
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 5,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/detail"), JSON.stringify(result.nodes));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler does not save a loading shell before slower data reveals a route", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-slow-data-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: new URL(route.request().url()).pathname === "/"
          ? '<main><a href="/slow">Slow page</a></main>'
          : new URL(route.request().url()).pathname === "/slow"
            ? `<main aria-busy="true"><p>Loading data...</p></main><script>
                setTimeout(() => { document.querySelector('main').innerHTML = '<h1>Ready</h1><a href="/detail">Detail</a>';
                  document.querySelector('main').removeAttribute('aria-busy'); }, 7000);
              </script>`
            : '<main><h1>Detail</h1></main>',
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/detail"), JSON.stringify(result.nodes));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler waits for content outside navigation in a SPA shell", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-spa-shell-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => route.fulfill({
        contentType: "text/html", body: new URL(route.request().url()).pathname === "/"
          ? '<nav><a href="/area">Area</a></nav>'
          : new URL(route.request().url()).pathname === "/area"
            ? `<div id="app"><nav><a href="/">Home</a></nav><section id="content"></section></div>
              <script>setTimeout(() => { document.querySelector('#content').innerHTML =
                '<h1>Area</h1><a href="/detail">Detail</a>'; }, 3200)</script>`
            : '<main><h1>Detail</h1></main>',
      }));
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/detail"), JSON.stringify(result.nodes));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler waits for an outstanding data request after the heading renders", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-api-hydration-"));
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/data") {
          await new Promise((resolve) => setTimeout(resolve, 3300));
          return route.fulfill({ contentType: "application/json", body: '{"ready":true}' });
        }
        return route.fulfill({ contentType: "text/html", body: pathname === "/"
          ? '<main><a href="/area">Area</a></main>'
          : `<div id="app"><nav>Site</nav><section><h1>Area</h1><div id="data"></div></section></div>
              <script>fetch('/data').then((response) => response.json()).then(() => {
                document.querySelector('#data').innerHTML = '<a href="/detail">Detail</a>'; });</script>` });
      });
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: createLogger("test", { level: "error" }) });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 2 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/detail"), JSON.stringify(result.nodes));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("crawler retries a redirected route through its in-app link", async () => {
  const browserManager = await BrowserManager.launch({ headless: true });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawler-redirected-route-"));
  const events = [];
  try {
    const originalNewContext = browserManager.newContext.bind(browserManager);
    browserManager.newContext = async (opts) => {
      const ctx = await originalNewContext(opts);
      await ctx.route("http://crawler.test/**", (route) => {
        if (new URL(route.request().url()).pathname === "/area") {
          return route.fulfill({ contentType: "text/html", body: "<script>location.replace('/')</script>" });
        }
        return route.fulfill({ contentType: "text/html", body: `<main id="view"><h1>Home</h1>
          <a href="/area" onclick="event.preventDefault();history.pushState({}, '', '/area');
            document.querySelector('#view').innerHTML='<h1>Area</h1><a href=/detail>Detail</a>'">Area</a></main>` });
      });
      return ctx;
    };
    const crawler = new Crawler({ browserManager, logger: {
      info: (message) => events.push(message), warn: (message) => events.push(message),
      debug: () => {}, error: () => {},
    } });
    const result = await crawler.run({ startUrl: "http://crawler.test/", maxPages: 10, maxDepth: 3,
      delayMs: 0, sameOriginOnly: true, outDir, headless: true, interactive: false, concurrency: 1 });
    assert.ok(result.nodes.some((node) => node.url === "http://crawler.test/area" && node.title !== "Home"),
      JSON.stringify({ nodes: result.nodes, events }));
  } finally {
    await browserManager.close();
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
