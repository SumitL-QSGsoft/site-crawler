import { gotoAndSettle, settleAfterAction, blockHeavyResources } from "../browser/navigation.js";
import { extractModal } from "../extraction/modal-extractor.js";
import { getCandidateSnapshot } from "./dom-snapshot.js";
import { normalizeUrl } from "../util/url-utils.js";
import { pageSignature } from "../crawl/state-fingerprint.js";
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

  async function findCandidate(candidate) {
    return (await getCandidateSnapshot(scratchPage, { includeLinks: true }))
      .find((entry) => entry.key === candidate.key && entry.label === candidate.label);
  }

  async function restoreCandidate(candidate, ancestors, expectedState) {
    let current = await findCandidate(candidate);
    if (current && normalizeUrl(scratchPage.url()) === normalizeUrl(url)
      && await pageSignature(scratchPage) === expectedState) return current;
    await gotoAndSettle(scratchPage, url, { idleTimeout: 750 });
    // A closing menu needs its disclosure path replayed, but never its sibling actions.
    for (const ancestor of ancestors) {
      const trigger = await findCandidate(ancestor);
      if (!trigger) return null;
      await scratchPage.locator(`[data-cw-id="${trigger.id}"]`).click({ timeout: 3000 });
      await settleAfterAction(scratchPage, url);
    }
    current = await findCandidate(candidate);
    return current;
  }

  async function visit(candidate, ancestors, expectedState) {
    const identity = `${expectedState}:${candidate.key}:${candidate.label}`;
    if (visitedActions.has(identity)) return;
    visitedActions.add(identity);
    const current = await restoreCandidate(candidate, ancestors, expectedState);
    if (!current || current.label !== candidate.label) return;
    const before = await getCandidateSnapshot(scratchPage, { includeLinks: true });
    const beforeKeys = new Set(before.map((entry) => `${entry.key}:${entry.label}`));
    const initialUrl = scratchPage.url();
    const beforeState = await pageSignature(scratchPage);
    const disclosure = await scratchPage.locator(`[data-cw-id="${current.id}"]`).evaluate((element) =>
      element.hasAttribute("aria-haspopup") || element.hasAttribute("aria-expanded") ||
      Boolean(element.closest('[role="menu"], [role="listbox"]')));
    await scratchPage.locator(`[data-cw-id="${current.id}"]`).click({ timeout: 3000 });
    await settleAfterAction(scratchPage, initialUrl);

    if (normalizeUrl(scratchPage.url()) !== normalizeUrl(initialUrl)) {
      const result = { type: "url", url: scratchPage.url(), label: candidate.label, key: candidate.key,
        path: [...ancestors, candidate] };
      firstResult ||= result;
      if (onResult) await onResult(result);
      return;
    }
    const modal = await extractModal(scratchPage);
    if (modal) {
      const result = { type: "modal", modal, page: scratchPage, label: candidate.label, key: candidate.key,
        path: [...ancestors, candidate] };
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
      if (!closed) await gotoAndSettle(scratchPage, url, { idleTimeout: 750 });
      return;
    }
    const afterState = await pageSignature(scratchPage);
    if (!disclosure && afterState !== beforeState) {
      const result = { type: "state", page: scratchPage, label: candidate.label, key: candidate.key,
        depth: ancestors.length + 1, path: [...ancestors, candidate], signature: afterState };
      firstResult ||= result;
      if (onResult) await onResult(result);
    }
    if (ancestors.length >= maxNestedClicks) return;
    const revealed = (await getCandidateSnapshot(scratchPage, { includeLinks: true }))
      .filter((entry) => !beforeKeys.has(`${entry.key}:${entry.label}`) || (!disclosure && afterState !== beforeState))
      .slice(0, maxPopoverItems);
    // Distinct identities retain same-label siblings; the table sampler applies here too.
    for (const nested of revealed) {
      if (keepPageOpen) break;
      await visit(nested, [...ancestors, candidate], afterState).catch(() => { });
    }
  }

  try {
    await gotoAndSettle(scratchPage, url, { idleTimeout: 750 });
    const candidates = await getCandidateSnapshot(scratchPage);
    const candidate = expectedKey ? candidates.find((entry) => entry.key === expectedKey) : candidates[index];
    if (!candidate || (expectedLabel !== undefined && candidate.label !== expectedLabel)) return null;
    await visit(candidate, [], await pageSignature(scratchPage));
    return firstResult;
  } finally {
    if (!keepPageOpen) await scratchPage.close().catch(() => { });
  }
}
