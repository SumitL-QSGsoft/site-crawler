// Minimal, dependency-free escaping for values embedded in CSS attribute selectors
// (e.g. `[name="..."]`). Node has no built-in `CSS.escape` (that's a browser-only API), and these
// values come straight from a crawled page's own DOM attributes, so they can't be trusted to be
// selector-safe as-is (a stray `"` or `\` in a `name`/`id`/`placeholder` would break the selector).
export function escapeAttributeValue(value) {
  return String(value).replace(/[\\"]/g, (ch) => `\\${ch}`);
}

// Builds the best available CSS selector for a form field extracted from the page, preferring
// name > id > placeholder. Deliberately uses an attribute selector for id (`[id="..."]`) instead
// of `#id` so it never needs a full CSS.escape()-style identifier-escaping algorithm for edge
// cases (ids starting with a digit, containing `:`/`.`, etc.) - Node has no built-in CSS.escape to
// fall back on anyway. Returns null if the field has none of these attributes.
export function selectorForField(field) {
  if (!field) return null;
  if (field.name) return `[name="${escapeAttributeValue(field.name)}"]`;
  if (field.id) return `[id="${escapeAttributeValue(field.id)}"]`;
  if (field.placeholder) return `[placeholder="${escapeAttributeValue(field.placeholder)}"]`;
  return null;
}
