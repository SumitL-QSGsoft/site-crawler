// A lightweight fingerprint of what's rendered (not just the URL) so an SPA state change that
// lands back on an already-seen screen without a URL change (e.g. closing a panel re-renders the
// same list) can be recognized as a repeat instead of being processed - and looped on - forever.
// Deliberately coarse (title + heading text + interactive-element counts): exact enough to catch
// real repeats, cheap enough to compute from data already extracted for every single screen.
export function computeStateFingerprint(extracted) {
  const headingText = (extracted.headings || []).map((h) => h.text).join("|");
  const counts = `${(extracted.links || []).length}:${(extracted.buttons || []).length}:${(extracted.forms || []).length}`;
  return `${extracted.title || ""}::${headingText}::${counts}`;
}
