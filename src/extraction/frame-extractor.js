import { NAV_CANDIDATE_SELECTOR, DESTRUCTIVE_TEXT_RE, TABLE_SELECTOR } from "./selectors.js";

// Runs inside a single frame (main page or iframe) to pull the structured data a "screen" needs.
// Accepts a page or a Frame — both expose .evaluate() with an identical signature.
export async function extractFrameContent(frameLike) {
  return frameLike.evaluate(
    ({ navSelector, destructiveSrc, tableSelector }) => {
      const { deepQueryAll, isVisible, textOf, locatorOf, findScrollContainer } = window.__crawlerHelpers;

      const title = document.title;
      const metaDescription = document.querySelector('meta[name="description"]')?.content || "";

      const headings = deepQueryAll("h1, h2, h3")
        .filter(isVisible)
        .map((h) => ({ level: h.tagName.toLowerCase(), text: textOf(h) }))
        .filter((h) => h.text);

      const links = deepQueryAll("a[href]")
        .filter(isVisible)
        .map((a) => ({ text: textOf(a) || "(no text)", href: a.href }))
        .filter((l) => l.href && !l.href.startsWith("javascript:"));

      const buttons = deepQueryAll('button, [role="button"], input[type="submit"], input[type="button"]')
        .filter(isVisible)
        .map((b) => ({
          text: textOf(b) || b.value || b.getAttribute("aria-label") || "(unlabeled button)",
          locator: locatorOf(b),
        }));

      // Non-anchor elements that might trigger SPA client-side routing (e.g. onClick nav, or a
      // clickable table row/list item). Form buttons are excluded so we never auto-submit forms.
      // The shared filter samples the first data row; keys distinguish its actions and
      // same-label buttons elsewhere without relying on a global label-based visited set.
      const navCandidates = window.__crawlerHelpers
        .getNavCandidates(navSelector, destructiveSrc)
        .map((el) => ({
          key: window.__crawlerHelpers.candidateKey(el),
          label: textOf(el) || el.value || el.getAttribute("aria-label") || "(unlabeled)",
          insideRow: window.__crawlerHelpers.isInsideRow(el),
        }));

      const forms = deepQueryAll("form").map((form) => {
        const fields = [...form.querySelectorAll("input, select, textarea")].filter(isVisible).map((f) => ({
          tag: f.tagName.toLowerCase(),
          type: f.type || null,
          name: f.name || null,
          id: f.id || null,
          placeholder: f.placeholder || null,
          label: f.labels && f.labels.length ? textOf(f.labels[0]) : f.getAttribute("aria-label") || null,
          required: f.required || false,
          locator: locatorOf(f),
        }));
        return { action: form.action || null, method: form.method || "get", fields };
      });

      const tables = deepQueryAll(tableSelector).map((table) => {
        const container = findScrollContainer(table);
        const headerCells = [...table.querySelectorAll("thead th, tr:first-child th, [role='columnheader']")].map(textOf);
        const rows = [...table.querySelectorAll("tbody tr, [role='row']")]
          .filter((r) => !r.querySelector("th, [role='columnheader']"))
          .slice(0, 25)
          .map((tr) => [...tr.querySelectorAll("td, [role='cell'], [role='gridcell']")].map(textOf));
        // Flagged so the caller (screen-extractor.js) knows to run the deeper, scroll-driven
        // virtualized-grid pass on this one instead of trusting this quick 25-row sample.
        return { headers: headerCells, rows, scrollable: container.scrollHeight > container.clientHeight + 4 };
      });

      // Main readable body text, with scripts/styles/nav chrome stripped as best effort.
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg").forEach((el) => el.remove());
      const bodyText = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

      return {
        title,
        metaDescription,
        headings,
        links,
        buttons,
        navCandidates,
        forms,
        tables,
        bodyText: bodyText.slice(0, 20000), // cap to keep files sane
        url: window.location.href,
      };
    },
    { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source, tableSelector: TABLE_SELECTOR }
  );
}
