// Installed once per browser context via context.addInitScript(), so it re-runs on every
// navigation/new document automatically. This is what every extraction/probe evaluate() call
// reaches for via `window.__crawlerHelpers` instead of redeclaring the same functions inline
// (page.evaluate bodies are serialized independently and can't share a JS closure otherwise).
export function installPageHelpers() {
  if (window.__crawlerHelpers) return;

  // Recurses into open shadow roots so web-component-based UIs aren't invisible to querySelectorAll.
  // Closed shadow roots are inherently inaccessible from page JS; that limitation can't be worked around.
  function deepQueryAll(sel, root = document) {
    const found = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) found.push(...deepQueryAll(sel, el.shadowRoot));
    }
    return found;
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  }

  // Bare <tr>/<li> are only real nav candidates if they look actually clickable themselves and
  // don't already contain their own <a>/button - which would already surface as its own
  // candidate/link, so clicking the row too would just be a redundant duplicate probe. Resting-
  // state cursor:pointer catches rows styled that way at all times, but many real tables only set
  // it on `:hover` (which computed style can't see without a real pointer over the element), so
  // we also accept the other common markers of a JS-bound clickable row/item: a keyboard-focusable
  // tabindex, or a data-* attribute frameworks commonly hang a row's id/key/link off of.
  const ROW_DATA_ATTRS = ["data-id", "data-row-id", "data-key", "data-href", "data-url", "data-navigate", "data-testid"];
  function isRowOrListCandidate(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (tag !== "tr" && tag !== "li" && !["row", "gridcell"].includes(role)) return true;
    if (el.querySelector('a[href], button, [role="button"], [role="menuitem"], [role="gridcell"]')) return false;
    if (window.getComputedStyle(el).cursor === "pointer") return true;
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    return ROW_DATA_ATTRS.some((attr) => el.hasAttribute(attr));
  }

  // Whether an element lives inside a table row/list item/grid cell - i.e. it represents one of
  // potentially many structurally-identical but semantically distinct data items (e.g. every row's
  // "Edit"/"Delete"/"..." action button shares the same visible label). Callers use this to avoid
  // ever treating those as "the same button already clicked once" just because the label matches.
  const ROW_CONTAINER_SELECTOR = 'tr, li, [role="row"], [role="option"], [role="gridcell"], [role="treeitem"], [role="listitem"]';
  function isInsideRow(el) {
    return el.closest(ROW_CONTAINER_SELECTOR) !== null;
  }

  function isSampledDataItem(el) {
    const container = el.closest('table, [role="grid"], [role="table"], [role="list"]');
    if (!container) return true;
    const rowSelector = container.getAttribute("role") === "list" ? '[role="listitem"], li' : 'tr, [role="row"]';
    const row = el.closest(rowSelector);
    if (!row) return true;
    const rows = [...container.querySelectorAll(rowSelector)]
      .filter(isVisible)
      .filter((candidate) => !candidate.closest("thead") && !candidate.querySelector('[role="columnheader"]'))
      .filter((candidate) => !candidate.querySelector("th") || candidate.querySelector("td"));
    return rows[0] === row;
  }

  // Centralizes the exact filter pipeline used to decide which non-anchor elements can trigger
  // SPA client-side routing (buttons, menu/tab/option/row/treeitem items, [onclick] handlers, or
  // clickable-looking table rows/list items). Shared by extraction and click-probing so the two
  // can never drift apart (previously duplicated inline in three separate places).
  function getNavCandidates(navSelector, destructiveSrc) {
    const destructiveRe = new RegExp(destructiveSrc, "i");
    const explicit = deepQueryAll(navSelector);
    const extra = getCursorPointerRowCandidates().filter((el) => !explicit.includes(el));
    return [...explicit, ...extra]
      .filter((el) => el.tagName.toLowerCase() !== "a")
      .filter((el) => !el.closest("form") || el.matches('button[type="button"], input[type="button"], [role="button"]:not(button):not(input)'))
      .filter(isRowOrListCandidate)
      .filter(isVisible)
      .filter(isSampledDataItem)
      .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true")
      .filter((el) => !destructiveRe.test(textOf(el) || el.getAttribute("aria-label") || ""));
  }

  // A plain <div>/<span> grid/table row (no role, no tag, no onclick attribute - the click
  // handler is bound via addEventListener, invisible to any selector) never matches
  // NAV_CANDIDATE_SELECTOR at all, so resting-state cursor:pointer is the only signal left that
  // it's clickable. Bounded to real table/ARIA-grid containers (popovers routinely render one for
  // a picklist) instead of scanning every div on the page, and to just the first data row - same
  // one-row sampling policy as isSampledDataItem applies downstream.
  function getCursorPointerRowCandidates() {
    const found = [];
    for (const container of deepQueryAll("table, [role='grid'], [role='table']")) {
      let rows = [...container.querySelectorAll("tbody tr, [role='row']")]
        .filter(isVisible)
        .filter((r) => !r.closest("thead") && !r.querySelector('[role="columnheader"]'));
      // A bare custom grid with no row markup at all - the container's own direct children are
      // the closest thing to "rows" left to look at.
      if (!rows.length) rows = [...container.children].filter(isVisible);

      const firstRow = rows[0];
      if (!firstRow || firstRow.closest('a[href], button, [role="button"], [onclick]')) continue;

      if (window.getComputedStyle(firstRow).cursor === "pointer") {
        found.push(firstRow);
        continue;
      }
      const clickableCell = [...firstRow.children].find((cell) => window.getComputedStyle(cell).cursor === "pointer");
      if (clickableCell) found.push(clickableCell);
    }
    return found;
  }

  // Best-effort ARIA role, close enough for locator descriptions (not a full HTML-AAM mapping).
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || (tag === "input" && ["submit", "button", "reset"].includes(type))) return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (tag === "input" && type === "radio") return "radio";
    if (tag === "input" && (!type || ["text", "email", "search", "password", "number", "tel", "url"].includes(type)))
      return "textbox";
    return null;
  }

  function quote(str) {
    return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  // Stamps a stable per-document id on an element (idempotent) so it can be re-targeted with a
  // Playwright locator (`[data-cw-id="..."]`) instead of a raw element handle - the counter lives
  // on `window` so every caller across the discovery layer shares one sequence per page/document.
  function ensureCwId(el) {
    if (!window.__cwNextId) window.__cwNextId = 1;
    if (!el.hasAttribute("data-cw-id")) el.setAttribute("data-cw-id", String(window.__cwNextId++));
    return el.getAttribute("data-cw-id");
  }

  // Coarse fingerprint of what's actually rendered (not just the URL) - title, visible heading
  // text, and a count of interactive elements. Cheap to compute on every screen and just precise
  // enough to tell "we've already seen this exact screen" apart from a genuinely different one,
  // which a URL-only visited-set can't do for SPA state changes that never touch the address bar.
  function domSignature() {
    const headingText = deepQueryAll("h1, h2, h3").filter(isVisible).map(textOf).join("|");
    const interactiveCount = deepQueryAll("button, a[href], input, select, textarea").filter(isVisible).length;
    return `${document.title}::${headingText}::${interactiveCount}`;
  }

  // Walks up from `el` looking for the nearest ancestor whose own overflow actually scrolls (as
  // opposed to the page/body) - the real container a virtualized table/grid library scrolls to
  // render more rows. Falls back to `el` itself if nothing scrollable is found within a few hops,
  // so callers always get back *something* to read scroll position off of.
  function findScrollContainer(el) {
    let node = el;
    for (let depth = 0; node && depth < 6; depth++) {
      const style = window.getComputedStyle(node);
      const scrollsY = /(auto|scroll)/.test(style.overflowY);
      if (scrollsY && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return el;
  }

  // One step of virtualized-table scrolling: reads whatever rows are *currently* rendered, then
  // advances the scroll container by one viewport so the next step's read picks up newly-rendered
  // rows. Virtualized libraries recycle their DOM nodes, so the caller must accumulate rows across
  // repeated calls rather than trust any single snapshot to contain everything.
  function readVirtualizedTableStep(tableSelector, tableIndex) {
    const table = deepQueryAll(tableSelector)[tableIndex];
    if (!table) return null;
    const container = findScrollContainer(table);

    const headers = [...table.querySelectorAll("thead th, tr:first-child th, [role='columnheader']")].map(textOf);
    const rows = [...table.querySelectorAll("tbody tr, [role='row']")]
      .filter((r) => !r.querySelector("th, [role='columnheader']"))
      .map((r) => [...r.querySelectorAll("td, [role='cell'], [role='gridcell']")].map(textOf))
      .filter((cells) => cells.length);

    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + container.clientHeight);

    return { headers, rows, atBottom, renderedRowCount: rows.length };
  }

  // Cheap row-count check (no full re-read) used to detect whether a scroll step actually caused
  // new rows to render, so the caller can wait for that instead of a fixed sleep.
  function peekVirtualizedTableRowCount(tableSelector, tableIndex) {
    const table = deepQueryAll(tableSelector)[tableIndex];
    if (!table) return null;
    return table.querySelectorAll("tbody tr, [role='row']").length;
  }

  // Short, human-readable CSS fallback (tag + nth-of-type chain, capped at 3 ancestors) for
  // elements with no id/name/testid/accessible-name to build a Playwright-style locator from.
  function cssFallback(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth++) {
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      const index = siblings.indexOf(node);
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function candidateKey(el) {
    if (el.id) return `id:${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const siblings = node.parentElement ? [...node.parentElement.children] : [node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${siblings.indexOf(node) + 1})`);
      node = node.parentElement || node.getRootNode().host;
    }
    return parts.join(" > ");
  }

  // Builds a short, human-readable locator hint for an element, preferring the same signals a
  // Playwright test would: test ids, then accessible role+name, then id/name/placeholder,
  // falling back to a positional CSS selector. Meant for documentation, not execution.
  function locatorOf(el) {
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-qa");
    if (testId) return `getByTestId('${quote(testId)}')`;

    const role = roleOf(el);
    const name = textOf(el) || el.getAttribute("aria-label") || el.value || "";
    if (role && name) return `getByRole('${role}', { name: '${quote(name)}' })`;

    if (el.id) return `#${el.id}`;

    const nameAttr = el.getAttribute("name");
    if (nameAttr) return `[name="${quote(nameAttr)}"]`;

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return `getByPlaceholder('${quote(placeholder)}')`;

    return cssFallback(el);
  }

  window.__crawlerHelpers = {
    deepQueryAll,
    isVisible,
    textOf,
    locatorOf,
    getNavCandidates,
    isInsideRow,
    isSampledDataItem,
    ensureCwId,
    candidateKey,
    domSignature,
    findScrollContainer,
    readVirtualizedTableStep,
    peekVirtualizedTableRowCount,
  };
}
