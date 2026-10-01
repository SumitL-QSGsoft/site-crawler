import { NAV_CANDIDATE_SELECTOR, DESTRUCTIVE_TEXT_RE } from "../extraction/selectors.js";

// Shared DOM-snapshot/click primitives used by both click-probe.js and popover-probe.js, so the
// two discovery strategies can never drift apart on what counts as "the same candidate."

// Snapshots every current nav candidate (buttons, menu items, clickable rows, ...), stamping a
// stable id on each first so two items sharing the same visible label (e.g. a repeated
// "Edit"/"Delete" button on every row) can still be told apart reliably after a click.
export async function getCandidateSnapshot(page, { includeLinks = false } = {}) {
  return page.evaluate(
    ({ navSelector, destructiveSrc, includeLinks }) => {
      const { getNavCandidates, deepQueryAll, isVisible, isSampledDataItem, candidateKey, textOf, ensureCwId } = window.__crawlerHelpers;
      const candidates = getNavCandidates(navSelector, destructiveSrc);
      if (includeLinks) {
        const destructive = new RegExp(destructiveSrc, "i");
        candidates.push(...deepQueryAll("a[href]").filter(isVisible).filter(isSampledDataItem)
          .filter((el) => !destructive.test(textOf(el) || el.getAttribute("aria-label") || "")));
      }
      return candidates.map((el) => ({
        id: ensureCwId(el),
        key: candidateKey(el),
        label: textOf(el) || el.value || el.getAttribute("aria-label") || "(unlabeled)",
      }));
    },
    { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source, includeLinks }
  );
}

// Same a[href] pipeline as extractFrameContent's links - used to spot links a popover/dropdown
// only renders once it's opened (so they weren't part of the page's original link set).
export async function getPageLinks(page) {
  return page.evaluate(() => {
    const { deepQueryAll, isVisible, isSampledDataItem, textOf } = window.__crawlerHelpers;
    return deepQueryAll("a[href]")
      .filter(isVisible)
      .filter(isSampledDataItem)
      .map((a) => ({ text: textOf(a) || "(no text)", href: a.href }))
      .filter((l) => l.href && !l.href.startsWith("javascript:"));
  });
}

// Clicks the nth nav candidate (same selector/order/filters as getCandidateSnapshot/extractFrameContent).
// Stamps a stable id on it, then clicks through a Playwright locator - not a raw DOM el.click() from
// inside page.evaluate() - so real actionability checks (visible, stable, enabled, not obscured by
// an overlay) and trusted pointer/mouse events apply, exactly like a real user click. A raw DOM
// click also only ever fires a synthetic "click" event, which some component libraries don't react
// to since they bind their handlers to pointerdown/mousedown instead.
export async function clickCandidateAt(page, index) {
  const id = await page.evaluate(
    ({ navSelector, destructiveSrc, index }) => {
      const { getNavCandidates, ensureCwId } = window.__crawlerHelpers;
      const el = getNavCandidates(navSelector, destructiveSrc)[index];
      return el ? ensureCwId(el) : null;
    },
    { navSelector: NAV_CANDIDATE_SELECTOR, destructiveSrc: DESTRUCTIVE_TEXT_RE.source, index }
  );
  if (!id) return false;

  try {
    await page.locator(`[data-cw-id="${id}"]`).click({ timeout: 3000 });
    return true;
  } catch {
    return false; // element became detached/covered/disabled between the snapshot and the click
  }
}

export async function domSignature(page) {
  return page.evaluate(() => window.__crawlerHelpers.domSignature());
}
