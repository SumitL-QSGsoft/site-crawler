import { sha1 } from "../util/hash.js";

// Include visible content and link targets: counts alone cannot distinguish an empty customer
// list from a list with one row, or two records rendered by the same detail template.
export function computeStateFingerprint(extracted) {
  return sha1(JSON.stringify({
    title: extracted.title || "",
    headings: (extracted.headings || []).map((heading) => heading.text),
    text: extracted.bodyText || "",
    links: (extracted.links || []).map((link) => [link.href, link.text]),
    buttons: (extracted.buttons || []).map((button) => button.text),
    forms: (extracted.forms || []).map((form) => [form.action, form.method, form.fields?.map((field) => field.name)]),
    tables: (extracted.tables || []).map((table) => [table.headers, table.rows]),
  }));
}

export function computeProbeFingerprint(extracted) {
  const headingText = (extracted.headings || []).map((heading) => heading.text).join("|");
  const counts = `${(extracted.links || []).length}:${(extracted.buttons || []).length}:${(extracted.forms || []).length}`;
  return `${extracted.title || ""}::${headingText}::${counts}`;
}

export async function pageSignature(page) {
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40000),
    links: [...document.querySelectorAll("a[href]")]
      .filter((link) => link.getClientRects().length)
      .map((link) => [link.href, link.innerText.trim()]),
    fields: [...document.querySelectorAll("input, select, textarea")]
      .filter((field) => field.getClientRects().length)
      .map((field) => [field.name, field.type, field.placeholder]),
  }));
  return sha1(JSON.stringify(snapshot));
}
