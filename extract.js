// Elements that can trigger SPA client-side routing without a real <a href>.
// Shared with crawler.js so click-probing re-queries the exact same set/order.
export const NAV_CANDIDATE_SELECTOR = 'button, [role="link"], [role="button"], [role="menuitem"], [role="tab"], [onclick]';
// Skip anything that sounds like it mutates/logs out rather than navigates.
export const DESTRUCTIVE_TEXT_RE = /delete|remove|logout|log out|sign out|deactivate|disable|unsubscribe|discard|revoke/i;

// Overlay/dialog elements checked after a nav-candidate click that didn't change the URL.
export const MODAL_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal.show, .modal.in, .ReactModal__Content, .MuiDialog-root, .MuiModal-root';

// Extracts the content of a currently open modal/dialog from any frame, or null if none is visible.
export async function extractModal(page) {
  for (const frame of page.frames()) {
    let modal = null;
    try {
      modal = await frame.evaluate((selector) => {
        // Duplicated in every evaluate() below — evaluate bodies are serialized and can't share closures.
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
        function text(el) {
          return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        }

        const found = deepQueryAll(selector).filter(visible)[0];
        if (!found) return null;

        const title = found.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim() || document.title;

        const buttons = deepQueryAll('button, [role="button"]', found)
          .filter(visible)
          .map((b) => text(b) || b.getAttribute("aria-label") || "(unlabeled button)");

        const forms = deepQueryAll("form", found).map((form) => {
          const fields = [...form.querySelectorAll("input, select, textarea")]
            .filter(visible)
            .map((f) => ({
              tag: f.tagName.toLowerCase(),
              type: f.type || null,
              name: f.name || null,
              placeholder: f.placeholder || null,
              label: f.labels && f.labels.length ? text(f.labels[0]) : f.getAttribute("aria-label") || null,
              required: f.required || false,
            }));
          return { action: form.action || null, method: form.method || "get", fields };
        });

        return {
          title,
          bodyText: text(found).slice(0, 20000),
          buttons,
          forms,
          url: window.location.href,
        };
      }, MODAL_SELECTOR);
    } catch {
      modal = null; // frame navigated/detached mid-evaluation; skip it
    }
    if (modal) return modal;
  }
  return null;
}

// Runs inside a single frame (main page or iframe) to pull the same structured data extractScreen needs.
async function extractFrameContent(frameLike, cfg) {
  return frameLike.evaluate(
    ({ navSelector, destructiveSrc }) => {
      // Duplicated across evaluate() calls in this file/crawler.js — bodies are serialized, no shared closures.
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

      function text(el) {
        return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      }

      const title = document.title;
      const metaDescription = document.querySelector('meta[name="description"]')?.content || "";

      const headings = deepQueryAll("h1, h2, h3")
        .filter(visible)
        .map((h) => ({ level: h.tagName.toLowerCase(), text: text(h) }))
        .filter((h) => h.text);

      const links = deepQueryAll("a[href]")
        .filter(visible)
        .map((a) => ({ text: text(a) || "(no text)", href: a.href }))
        .filter((l) => l.href && !l.href.startsWith("javascript:"));

      const buttons = deepQueryAll('button, [role="button"], input[type="submit"], input[type="button"]')
        .filter(visible)
        .map((b) => text(b) || b.value || b.getAttribute("aria-label") || "(unlabeled button)");

      // Non-anchor elements that might trigger SPA client-side routing (e.g. onClick nav).
      // Form buttons are excluded so we never auto-submit forms while probing.
      const destructiveRe = new RegExp(destructiveSrc, "i");
      const navCandidates = deepQueryAll(navSelector)
        .filter((el) => el.tagName.toLowerCase() !== "a")
        .filter((el) => !el.closest("form"))
        .filter(visible)
        .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true")
        .map((el) => text(el) || el.getAttribute("aria-label") || "(unlabeled)")
        .filter((t) => !destructiveRe.test(t));

      const forms = deepQueryAll("form").map((form) => {
        const fields = [...form.querySelectorAll("input, select, textarea")]
          .filter(visible)
          .map((f) => ({
            tag: f.tagName.toLowerCase(),
            type: f.type || null,
            name: f.name || null,
            placeholder: f.placeholder || null,
            label:
              f.labels && f.labels.length
                ? text(f.labels[0])
                : f.getAttribute("aria-label") || null,
            required: f.required || false,
          }));
        return { action: form.action || null, method: form.method || "get", fields };
      });

      const tables = deepQueryAll("table").map((table) => {
        const headerCells = [...table.querySelectorAll("thead th, tr:first-child th")].map(text);
        const rows = [...table.querySelectorAll("tbody tr")].slice(0, 25).map((tr) => [...tr.querySelectorAll("td")].map(text));
        return { headers: headerCells, rows };
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
    cfg
  );
}

// Runs inside the browser page (page.evaluate) to pull a structured,
// noise-free representation of what's on screen: what it says, what you
// can click, and what you can fill in. This is what makes a "screen"
// machine-readable rather than just a screenshot. Same-page iframes are
// included so content/links embedded in them aren't silently missed.
export async function extractScreen(page) {
  const cfg = { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source };
  // frames()[0] is always the main frame; the rest are (same- or cross-origin) iframes.
  const perFrame = await Promise.all(
    page.frames().map((frame) => extractFrameContent(frame, cfg).catch(() => null))
  );
  const [main] = perFrame;
  const ok = perFrame.filter(Boolean);
  const merge = (key) => ok.flatMap((r) => r[key]);

  return {
    title: main?.title || "",
    metaDescription: main?.metaDescription || "",
    headings: merge("headings"),
    links: merge("links"),
    buttons: merge("buttons"),
    navCandidates: merge("navCandidates"),
    forms: merge("forms"),
    tables: merge("tables"),
    bodyText: ok
      .map((r) => r.bodyText)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20000),
    url: main?.url || page.url(),
  };
}


// Turns extracted data into a clean markdown document for the knowledge base.
export function toMarkdown(screen) {
  const { title, url, metaDescription, headings, links, buttons, forms, tables, bodyText, discoveredVia, screenId } = screen;

  const lines = [];
  lines.push(`# ${title || "(untitled)"}`);
  lines.push("");
  lines.push(`- **URL**: ${url}`);
  if (discoveredVia) lines.push(`- **Reached via**: ${discoveredVia}`);
  if (metaDescription) lines.push(`- **Meta description**: ${metaDescription}`);
  lines.push(`- **Screen ID**: ${screenId}`);
  lines.push("");

  if (headings.length) {
    lines.push("## Headings");
    headings.forEach((h) => lines.push(`- (${h.level}) ${h.text}`));
    lines.push("");
  }

  if (buttons.length) {
    lines.push("## Actions available (buttons)");
    [...new Set(buttons)].forEach((b) => lines.push(`- ${b}`));
    lines.push("");
  }

  if (forms.length) {
    lines.push("## Forms");
    forms.forEach((f, i) => {
      lines.push(`### Form ${i + 1} (${f.method.toUpperCase()} ${f.action || url})`);
      f.fields.forEach((field) => {
        const desc = [field.tag, field.type, field.name].filter(Boolean).join(" / ");
        lines.push(`- ${field.label || field.placeholder || "(unlabeled)"} — \`${desc}\`${field.required ? " *required*" : ""}`);
      });
      lines.push("");
    });
  }

  if (tables.length) {
    lines.push("## Tables");
    tables.forEach((t, i) => {
      lines.push(`### Table ${i + 1}`);
      if (t.headers.length) lines.push(`| ${t.headers.join(" | ")} |`);
      if (t.headers.length) lines.push(`| ${t.headers.map(() => "---").join(" | ")} |`);
      t.rows.forEach((row) => lines.push(`| ${row.join(" | ")} |`));
      lines.push("");
    });
  }

  if (links.length) {
    lines.push("## Links on this screen");
    links.slice(0, 200).forEach((l) => lines.push(`- [${l.text}](${l.href})`));
    lines.push("");
  }

  lines.push("## Page text");
  lines.push("");
  lines.push(bodyText || "(no extractable text)");
  lines.push("");

  return lines.join("\n");
}
