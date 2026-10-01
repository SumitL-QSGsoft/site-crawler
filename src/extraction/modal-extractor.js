import { MODAL_SELECTOR } from "./selectors.js";

// Extracts the content of a currently open modal/dialog from any frame, or null if none is visible.
export async function extractModal(page) {
  for (const frame of page.frames()) {
    let modal = null;
    try {
      modal = await frame.evaluate((selector) => {
        const { deepQueryAll, isVisible, textOf, locatorOf } = window.__crawlerHelpers;

        const found = deepQueryAll(selector).filter(isVisible)[0];
        if (!found) return null;

        const title = found.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim() || document.title;

        // Real links inside the modal (e.g. a row in a "users" list dialog linking to /user/123)
        // so the crawler can follow them just like it does for links on a normal page.
        const links = deepQueryAll("a[href]", found)
          .filter(isVisible)
          .map((a) => ({ text: textOf(a) || "(no text)", href: a.href }))
          .filter((l) => l.href && !l.href.startsWith("javascript:"));

        const buttons = deepQueryAll('button, [role="button"]', found)
          .filter(isVisible)
          .map((b) => ({ text: textOf(b) || b.getAttribute("aria-label") || "(unlabeled button)", locator: locatorOf(b) }));

        const forms = deepQueryAll("form", found).map((form) => {
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

        return {
          title,
          bodyText: textOf(found).slice(0, 20000),
          links,
          buttons,
          forms,
          url: window.location.href,
        };
      }, MODAL_SELECTOR);
    } catch {
      modal = null; // frame navigated/detached mid-evaluation; skip it
    }
    if (modal) {
      // Best-effort only: locator.ariaSnapshot() is a Playwright API (not reachable from inside
      // the page.evaluate above) and only resolves elements in the frame it's called against.
      modal.ariaSnapshot = await frame
        .locator(MODAL_SELECTOR)
        .first()
        .ariaSnapshot({ timeout: 2000 })
        .catch(() => "");
      return modal;
    }
  }
  return null;
}
