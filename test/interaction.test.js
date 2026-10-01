import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installPageHelpers } from "../src/browser/page-helpers.js";
import { NAV_CANDIDATE_SELECTOR, DESTRUCTIVE_TEXT_RE } from "../src/extraction/selectors.js";
import { probeClickNavigation } from "../src/discovery/click-probe.js";
import { getCandidateSnapshot, getPageLinks } from "../src/discovery/dom-snapshot.js";

test("click probe visits each disclosed item once, including dialog actions and links", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installPageHelpers);
    const clicks = [];
    await context.exposeFunction("recordClick", (id) => clicks.push(id));
    await context.route("http://crawler.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<button id="trigger" aria-haspopup="menu" onclick="menu.hidden=false;recordClick(this.id)">Actions</button>
        <div id="menu" role="menu" hidden>
          <button id="one" role="menuitem" onclick="recordClick(this.id)">Inspect</button>
          <button id="two" role="menuitem" onclick="recordClick(this.id)">Inspect</button>
          <button id="dialog-action" role="menuitem" onclick="recordClick(this.id);dialog.showModal()">Preview</button>
          <a id="link" role="menuitem" href="/detail" onclick="recordClick(this.id)">Detail</a>
          <button role="menuitem" onclick="recordClick('delete')">Delete</button>
        </div><dialog id="dialog"><h2>Preview</h2><p>Item details</p></dialog>`,
    }));
    const results = [];
    await probeClickNavigation(context, "http://crawler.test/", 0, {
      expectedLabel: "Actions",
      onResult: (result) => results.push({ type: result.type, label: result.label, url: result.url }),
    });
    assert.deepEqual(clicks, ["trigger", "one", "two", "dialog-action", "link"]);
    assert.deepEqual(results.map((result) => result.type), ["modal", "url"]);
    assert.equal(results[1].url, "http://crawler.test/detail");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("candidate sampling keeps distinct buttons and only the first table data item", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="first">Details</button><button id="second">Details</button>
      <form><button type="button" id="form-action">Preview</button><button>Submit</button></form>
      <table><thead><tr><th>Name</th></tr></thead><tbody>
        <tr><th scope="row">First</th><td><button id="row-first">Open</button><button id="row-menu">Actions</button><a href="http://crawler.test/first">First</a></td></tr>
        <tr><td><button id="row-second">Open</button><a href="http://crawler.test/second">Second</a></td></tr>
      </tbody></table>
      <div role="grid"><div role="row"><div role="columnheader">Name</div></div>
        <div role="row"><div role="gridcell"><button id="grid-first">Open</button></div></div>
        <div role="row"><div role="gridcell"><button id="grid-second">Open</button></div></div>
      </div>
      <div role="menu"><button role="menuitem" id="menu-first">Inspect</button>
        <button role="menuitem" id="menu-second">Export</button></div>
      <button id="delete">Delete</button><button disabled>Disabled</button>
    `);
    await page.evaluate(installPageHelpers);
    const ids = await page.evaluate(({ selector, destructive }) =>
      window.__crawlerHelpers.getNavCandidates(selector, destructive).map((element) => element.id),
      { selector: NAV_CANDIDATE_SELECTOR, destructive: DESTRUCTIVE_TEXT_RE.source });
    assert.deepEqual(ids, ["first", "second", "form-action", "row-first", "row-menu", "grid-first", "menu-first", "menu-second"]);
    const candidates = await getCandidateSnapshot(page);
    assert.notEqual(candidates[0].key, candidates[1].key);
    assert.deepEqual((await getPageLinks(page)).map((link) => link.href), ["http://crawler.test/first"]);
  } finally {
    await browser.close();
  }
});

test("a bare div-based grid row with only cursor:pointer (no role/onclick) is still picked up", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="grid">
        <div style="cursor:pointer" id="pointer-row">Row one</div>
        <div style="cursor:pointer" id="pointer-row-2">Row two</div>
      </div>
      <table><tbody>
        <tr><td style="cursor:pointer" id="pointer-cell">Cell row one</td></tr>
        <tr><td style="cursor:pointer" id="pointer-cell-2">Cell row two</td></tr>
      </tbody></table>
    `);
    await page.evaluate(installPageHelpers);
    const ids = await page.evaluate(({ selector, destructive }) =>
      window.__crawlerHelpers.getNavCandidates(selector, destructive).map((element) => element.id),
      { selector: NAV_CANDIDATE_SELECTOR, destructive: DESTRUCTIVE_TEXT_RE.source });
    // Only the first row of each container - "row-2"/"cell-2" are the same repeated data shape.
    assert.deepEqual(ids, ["pointer-row", "pointer-cell"]);
  } finally {
    await browser.close();
  }
});