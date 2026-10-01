// Builds the AutoQA-style knowledge-base artifacts (app-map.json, knowledge-base.md, index.json)
// from the same per-screen `extracted` data already written to screens/<id>/ and modules/<id>.md.
// Mirrors AutoQA/knowledge/orangehrm/app-map.json's shape exactly: an array of
// { name, url, slug, headings, fields, buttons } objects, one per crawled screen/modal.

// One entry per screen, in the same shape as AutoQA's app-map.json.
export function buildAppMapEntry(extracted, { url, screenId }) {
  return {
    name: extracted.title || screenId,
    url,
    slug: screenId,
    headings: (extracted.headings || []).map((h) => `${h.level.toUpperCase()}: ${h.text}`),
    fields: (extracted.forms || []).flatMap((f) => f.fields).map((f) => ({
      label: f.label || null,
      tag: f.tag,
      name: f.name || null,
      type: f.type || null,
      placeholder: f.placeholder || null,
      locator: f.locator,
    })),
    buttons: (extracted.buttons || []).map((b) => ({ text: b.text, locator: b.locator })),
  };
}

// Demotes every ATX heading in a markdown blob by `n` levels, skipping fenced code blocks -
// so each module's own "#" title becomes a subsection when concatenated into one document.
function demote(md, n) {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = /^(#{1,6})\s/.exec(line);
      return m ? "#".repeat(Math.min(6, m[1].length + n)) + line.slice(m[1].length) : line;
    })
    .join("\n");
}

// Merges every module's markdown into one self-contained document with a table of contents -
// the generic equivalent of AutoQA's consolidate-knowledge.js (no fixed MODULE_GROUPS since an
// arbitrary crawled site has no curated sidebar taxonomy to group by).
export function buildKnowledgeBaseMarkdown(modules, { startUrl, generatedAt }) {
  const lines = [];
  lines.push(`# Knowledge base: ${startUrl}`);
  lines.push("");
  lines.push(`Crawled ${modules.length} screen(s) starting from ${startUrl}.`);
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  modules.forEach((m) => lines.push(`- [${m.title}](#${slugAnchor(m.title)})`));
  lines.push("");

  modules.forEach((m) => {
    lines.push(`<a id="${slugAnchor(m.title)}"></a>`);
    lines.push("");
    lines.push(demote(m.markdown, 1));
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}

function slugAnchor(title) {
  return (title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A small machine-readable manifest describing the run, similar in spirit to the mega-spec's
// index.json but scoped to what this crawler actually captures.
export function buildManifest(appMap, { startUrl, generatedAt, pagesDone, maxPages, maxDepth }) {
  const modals = appMap.filter((e) => e.url.includes("#modal:"));
  const withForms = appMap.filter((e) => e.fields.length);
  const totalButtons = appMap.reduce((n, e) => n + e.buttons.length, 0);
  const totalFields = appMap.reduce((n, e) => n + e.fields.length, 0);

  return {
    schemaVersion: "1.0",
    generatedAt,
    source: startUrl,
    config: { maxPages, maxDepth },
    counts: {
      screens: appMap.length - modals.length,
      modals: modals.length,
      totalScreens: appMap.length,
      pagesVisited: pagesDone,
      formsCapturedOn: withForms.length,
      fields: totalFields,
      buttons: totalButtons,
    },
  };
}
