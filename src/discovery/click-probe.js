import { gotoAndSettle, settleAfterAction, blockHeavyResources } from "../browser/navigation.js";
import { extractModal } from "../extraction/modal-extractor.js";
import { getCandidateSnapshot } from "./dom-snapshot.js";
import { normalizeUrl } from "../util/url-utils.js";
import { MODAL_SELECTOR } from "../extraction/selectors.js";

export async function probeClickNavigation(
  context,
  url,
  index,
  { expectedLabel, expectedKey, maxNestedClicks = 5, maxPopoverItems = Infinity, onResult, visitedActions = new Set() } = {}
) {
  const scratchPage = await context.newPage();
  await blockHeavyResources(scratchPage);
  let keepPageOpen = false;
  let firstResult = null;

  async function findCandidate(key) {
    return (await getCandidateSnapshot(scratchPage, { includeLinks: true })).find((candidate) => candidate.key === key);
  }

  async function restoreCandidate(candidate, ancestors) {
    let current = await findCandidate(candidate.key);
    if (current && normalizeUrl(scratchPage.url()) === normalizeUrl(url)) return current;
    await gotoAndSettle(scratchPage, url);
    // A closing menu needs its disclosure path replayed, but never its sibling actions.
    for (const ancestor of ancestors) {
      const trigger = await findCandidate(ancestor.key);
      if (!trigger) return null;
      await scratchPage.locator(`[data-cw-id="${trigger.id}"]`).click({ timeout: 3000 });
      await settleAfterAction(scratchPage, url);
    }
    current = await findCandidate(candidate.key);
    return current;
  }

  async function visit(candidate, ancestors) {
    if (visitedActions.has(candidate.key)) return;
    visitedActions.add(candidate.key);
    const current = await restoreCandidate(candidate, ancestors);
    if (!current || current.label !== candidate.label) return;
    const before = await getCandidateSnapshot(scratchPage, { includeLinks: true });
    const beforeKeys = new Set(before.map((entry) => entry.key));
    const initialUrl = scratchPage.url();
    await scratchPage.locator(`[data-cw-id="${current.id}"]`).click({ timeout: 3000 });
    await settleAfterAction(scratchPage, initialUrl);

    if (normalizeUrl(scratchPage.url()) !== normalizeUrl(initialUrl)) {
      const result = { type: "url", url: scratchPage.url(), label: candidate.label, key: candidate.key };
      firstResult ||= result;
      if (onResult) await onResult(result);
      return;
    }
    const modal = await extractModal(scratchPage);
    if (modal) {
      const result = { type: "modal", modal, page: scratchPage, label: candidate.label, key: candidate.key };
      firstResult ||= result;
      if (!onResult) {
        keepPageOpen = true;
        return;
      }
      await onResult(result);
      await scratchPage.keyboard.press("Escape").catch(() => { });
      const closed = await scratchPage.waitForFunction((selector) => {
        const { deepQueryAll, isVisible } = window.__crawlerHelpers;
        return !deepQueryAll(selector).some(isVisible);
      }, MODAL_SELECTOR, { timeout: 1500 }).then(() => true).catch(() => false);
      if (!closed) await gotoAndSettle(scratchPage, url);
      return;
    }
    if (ancestors.length >= maxNestedClicks) return;
    const revealed = (await getCandidateSnapshot(scratchPage, { includeLinks: true }))
      .filter((entry) => !beforeKeys.has(entry.key) && !visitedActions.has(entry.key))
      .slice(0, maxPopoverItems);
    // Distinct identities retain same-label siblings; the table sampler applies here too.
    for (const nested of revealed) {
      if (keepPageOpen) break;
      await visit(nested, [...ancestors, candidate]).catch(() => { });
    }
  }

  try {
    await gotoAndSettle(scratchPage, url);
    const candidates = await getCandidateSnapshot(scratchPage);
    const candidate = expectedKey ? candidates.find((entry) => entry.key === expectedKey) : candidates[index];
    if (!candidate || (expectedLabel !== undefined && candidate.label !== expectedLabel)) return null;
    await visit(candidate, []);
    return firstResult;
  } finally {
    if (!keepPageOpen) await scratchPage.close().catch(() => { });
  }
}
