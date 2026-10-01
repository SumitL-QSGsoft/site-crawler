// Builds the top-level, human-readable index.md summarizing everything the crawl found.
export function buildIndex(nodes, edges, options) {
  const lines = [];
  lines.push(`# Knowledge base: ${options.startUrl}`);
  lines.push("");
  lines.push(`Crawled ${nodes.length} screen(s) starting from ${options.startUrl}.`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Screens");
  lines.push("");
  nodes
    .slice()
    .sort((a, b) => a.depth - b.depth)
    .forEach((n) => {
      lines.push(`- **${n.title || "(untitled)"}** (depth ${n.depth}) — \`${n.url}\``);
      lines.push(`  - content: \`screens/${n.id}/content.md\``);
      lines.push(`  - screenshot: \`screens/${n.id}/screenshot.png\``);
    });
  lines.push("");
  lines.push("## Navigation graph");
  lines.push("");
  lines.push("See `graph.json` for the full machine-readable node/edge graph. Summary:");
  lines.push("");
  edges.forEach((e) => lines.push(`- \`${e.from}\` --(${e.label})--> \`${e.to}\``));
  lines.push("");
  lines.push("## How to use this with an LLM");
  lines.push("");
  lines.push(
    "Concatenate the `content.md` files (or feed `graph.json` + individual files) into your LLM's " +
    "context, or embed each `content.md` chunk into a vector store for RAG. Each screen file is " +
    "self-contained: it names the URL, how it was reached, what's on it, and what actions/forms are available."
  );
  lines.push("");
  return lines.join("\n");
}
