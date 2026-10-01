import { extractFrameContent } from "./frame-extractor.js";
import { extractVirtualizedTable } from "./virtualized-grid.js";

const BODY_TEXT_CAP = 20000;

// Runs the deep, scroll-driven capture (see virtualized-grid.js) on every table the quick scan
// flagged as scrollable, replacing its 25-row sample with the full set of rows it can reveal.
// Guards against the table list having shifted between the quick scan and this pass (e.g. a
// re-render added/removed a table) by discarding the deep result if its headers don't match what
// the quick scan saw at that same index - better to keep the shallow sample than merge the wrong
// table's data in.
async function deepenScrollableTables(frameLike, tables) {
  const deepened = [...tables];
  for (let i = 0; i < tables.length; i++) {
    if (!tables[i].scrollable) continue;
    const deep = await extractVirtualizedTable(frameLike, i).catch(() => null);
    if (deep && headersRoughlyMatch(deep.headers, tables[i].headers)) {
      deepened[i] = { headers: deep.headers.length ? deep.headers : tables[i].headers, rows: deep.rows };
    }
  }
  return deepened.map(({ headers, rows }) => ({ headers, rows })); // drop the internal `scrollable` flag
}

function headersRoughlyMatch(a, b) {
  if (!a.length || !b.length) return true; // nothing to compare against - trust the deep pass
  return a.join("|") === b.join("|");
}

// Pulls a structured, noise-free representation of what's on screen: what it says, what you can
// click, and what you can fill in. This is what makes a "screen" machine-readable rather than just
// a screenshot. Same-page iframes are included so content/links embedded in them aren't missed.
export async function extractScreen(page) {
  // frames()[0] is always the main frame; the rest are (same- or cross-origin) iframes. Each frame
  // is wrapped so a cross-origin/detached/mid-navigation frame can't fail the whole extraction.
  const perFrame = await Promise.all(
    page.frames().map(async (frame) => {
      const content = await extractFrameContent(frame).catch(() => null);
      if (!content) return null;
      content.tables = await deepenScrollableTables(frame, content.tables).catch(() => content.tables);
      return content;
    })
  );
  const [main] = perFrame;
  const ok = perFrame.filter(Boolean);
  const merge = (key) => ok.flatMap((r) => r[key]);

  // Playwright's accessibility-tree snapshot, in the same yaml shape AutoQA's own crawler
  // captures - the closest thing to a ground-truth locator map for a test-generation AI to read.
  const ariaSnapshot = await page
    .locator("body")
    .ariaSnapshot()
    .catch(() => "");

  return {
    title: main?.title || "",
    metaDescription: main?.metaDescription || "",
    headings: merge("headings"),
    links: merge("links"),
    buttons: merge("buttons"),
    navCandidates: merge("navCandidates"),
    forms: merge("forms"),
    tables: merge("tables"),
    ariaSnapshot,
    bodyText: ok
      .map((r) => r.bodyText)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, BODY_TEXT_CAP),
    url: main?.url || page.url(),
  };
}
