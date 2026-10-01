// Turns extracted screen data into a markdown document. Section names/order (URL, Page
// heading(s), Sub-navigation, Form fields, Buttons, Table/grid columns, ARIA snapshot) mirror
// AutoQA's own OrangeHRM crawler (scripts/crawl-orangehrm.js) so both tools produce a knowledge
// base a test-generation AI can read the same way. Locators and the trailing Links/Page text
// sections are additive extras beyond that format.
export function toMarkdown(screen) {
  const {
    title,
    url,
    metaDescription,
    headings,
    links,
    buttons,
    navCandidates,
    forms,
    tables,
    ariaSnapshot,
    bodyText,
    discoveredVia,
    screenId,
  } = screen;

  const lines = [];
  lines.push(`# ${title || "(untitled)"}`);
  lines.push("");
  lines.push(`- **URL:** \`${url}\``);
  if (discoveredVia) lines.push(`- **Reached via:** ${discoveredVia}`);
  if (metaDescription) lines.push(`- **Meta description:** ${metaDescription}`);
  if (headings.length)
    lines.push(`- **Page heading(s):** ${headings.map((h) => `${h.level.toUpperCase()}: ${h.text}`).join(" | ")}`);
  lines.push(`- **Screen ID:** ${screenId}`);
  lines.push("");

  if (navCandidates?.length) {
    lines.push("## Sub-navigation", "");
    [...new Set(navCandidates.map((c) => (typeof c === "string" ? c : c.label)))].forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }

  const allFields = forms.flatMap((f) => f.fields);
  if (allFields.length) {
    lines.push("## Form fields", "");
    lines.push("| Label | Tag | name | type | placeholder | Locator |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    allFields.forEach((f) =>
      lines.push(
        `| ${f.label || ""} | ${f.tag} | ${f.name || ""} | ${f.type || ""} | ${f.placeholder || ""} | \`${f.locator}\` |`
      )
    );
    lines.push("");
  }

  if (buttons.length) {
    lines.push("## Buttons", "");
    const seen = new Set();
    buttons.forEach((b) => {
      const key = `${b.text}|${b.locator}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(`- ${b.text} — \`${b.locator}\``);
    });
    lines.push("");
  }

  const columns = [...new Set(tables.flatMap((t) => t.headers))];
  if (columns.length) {
    lines.push("## Table / grid columns", "");
    columns.forEach((c) => lines.push(`- ${c}`));
    lines.push("");
  }

  const MAX_TABLE_ROWS = 200;
  tables.forEach((t, i) => {
    if (!t.rows.length) return;
    lines.push(`### Table data${tables.length > 1 ? ` #${i + 1}` : ""}`, "");
    const headerRow = t.headers.length ? t.headers : t.rows[0].map((_, ci) => `Column ${ci + 1}`);
    lines.push(`| ${headerRow.join(" | ")} |`);
    lines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);
    t.rows.slice(0, MAX_TABLE_ROWS).forEach((row) => {
      lines.push(`| ${row.map((cell) => (cell || "").replace(/\|/g, "\\|")).join(" | ")} |`);
    });
    if (t.rows.length > MAX_TABLE_ROWS) {
      lines.push("", `_...${t.rows.length - MAX_TABLE_ROWS} more row(s) captured but omitted here for size._`);
    }
    lines.push("");
  });

  if (ariaSnapshot) {
    lines.push("## ARIA snapshot", "");
    lines.push("```yaml", ariaSnapshot.trim(), "```", "");
  }

  if (links.length) {
    lines.push("## Links on this screen", "");
    links.slice(0, 200).forEach((l) => lines.push(`- [${l.text}](${l.href})`));
    lines.push("");
  }

  lines.push("## Page text", "");
  lines.push(bodyText || "(no extractable text)");
  lines.push("");

  return lines.join("\n");
}
