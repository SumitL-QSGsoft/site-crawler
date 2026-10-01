import { gotoAndSettle } from "../browser/navigation.js";
import { getCandidateSnapshot, getPageLinks, domSignature } from "./dom-snapshot.js";
import { POPOVER_TRIGGER_SELECTOR, DESTRUCTIVE_TEXT_RE } from "../extraction/selectors.js";

const DEFAULT_MAX_TRIGGERS = 15;
const DEFAULT_MAX_ITEMS_PER_MENU = 20;

/**
 * Hunts for hidden menus/dropdowns/popovers via their ARIA disclosure signals (`aria-haspopup`,
 * `aria-expanded="false"`), opens each one in isolation, captures every link and nav-candidate
 * item it revealed, then closes it again (Escape, falling back to an outside click) before moving
 * to the next trigger - so triggers never stack up or shadow each other's menus. Runs on its own
 * scratch page so it never disturbs the main crawl page's state.
 */
export async function probePopovers(context, url, { maxTriggers = DEFAULT_MAX_TRIGGERS, maxItemsPerMenu = DEFAULT_MAX_ITEMS_PER_MENU } = {}) {
  const scratchPage = await context.newPage();
  try {
    await gotoAndSettle(scratchPage, url);
    const triggerCount = await countTriggers(scratchPage);
    const results = [];

    for (let i = 0; i < Math.min(triggerCount, maxTriggers); i++) {
      const outcome = await probeOneTrigger(scratchPage, i, maxItemsPerMenu).catch(() => null);
      if (outcome) results.push(outcome);
    }
    return results;
  } finally {
    await scratchPage.close().catch(() => { });
  }
}

async function countTriggers(page) {
  return page.evaluate((selector) => {
    const { deepQueryAll, isVisible } = window.__crawlerHelpers;
    return deepQueryAll(selector).filter(isVisible).length;
  }, POPOVER_TRIGGER_SELECTOR);
}

// Stamps a stable id on the nth popover trigger (same selector/order as countTriggers) so it can
// be re-targeted with a Playwright locator, returning its id, visible label, and current
// aria-expanded state.
async function stampTrigger(page, index) {
  return page.evaluate(
    ({ selector, index }) => {
      const { deepQueryAll, isVisible, textOf, ensureCwId } = window.__crawlerHelpers;
      const el = deepQueryAll(selector).filter(isVisible)[index];
      if (!el) return null;
      return {
        id: ensureCwId(el),
        label: textOf(el) || el.getAttribute("aria-label") || "",
        alreadyOpen: el.getAttribute("aria-expanded") === "true",
      };
    },
    { selector: POPOVER_TRIGGER_SELECTOR, index }
  );
}

async function probeOneTrigger(page, index, maxItemsPerMenu) {
  const trigger = await stampTrigger(page, index);
  if (!trigger || trigger.alreadyOpen || DESTRUCTIVE_TEXT_RE.test(trigger.label)) return null;

  const beforeCandidates = await getCandidateSnapshot(page);
  const beforeLinks = await getPageLinks(page);
  const beforeIds = new Set(beforeCandidates.map((c) => c.id));
  const beforeSignature = await domSignature(page);

  const clicked = await page
    .locator(`[data-cw-id="${trigger.id}"]`)
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) return null;

  const opened = await waitForDisclosure(page, trigger.id, beforeSignature);
  if (!opened) {
    await closePopover(page, trigger.id);
    return null;
  }

  const afterLinks = await getPageLinks(page);
  const afterCandidates = await getCandidateSnapshot(page);
  const newLinks = afterLinks.filter((l) => !beforeLinks.some((b) => b.href === l.href));
  const newItems = afterCandidates.filter((c) => !beforeIds.has(c.id)).slice(0, maxItemsPerMenu);

  await closePopover(page, trigger.id);

  if (!newLinks.length && !newItems.length) return null;
  return { trigger: trigger.label, links: newLinks, items: newItems.map((c) => ({ label: c.label })) };
}

// Waits for the disclosure to actually happen - aria-expanded flipping to "true", or (for widgets
// that don't bother updating it) the page's overall interactive-element signature changing -
// instead of a fixed sleep. Bounded so a trigger that silently does nothing can't hang the crawl.
async function waitForDisclosure(page, triggerId, beforeSignature) {
  return page
    .waitForFunction(
      ({ id, beforeSignature }) => {
        const el = document.querySelector(`[data-cw-id="${id}"]`);
        if (el?.getAttribute("aria-expanded") === "true") return true;
        return window.__crawlerHelpers.domSignature() !== beforeSignature;
      },
      { id: triggerId, beforeSignature },
      { timeout: 2000 }
    )
    .then(() => true)
    .catch(() => false);
}

// Closes an open popover/menu the way a real user would: Escape first (closes the vast majority
// of ARIA menus/listboxes/dialogs), falling back to a click on a neutral corner of the page
// (outside the popover) for the minority that only close on an outside click.
async function closePopover(page, triggerId) {
  await page.keyboard.press("Escape").catch(() => { });
  const closed = await page
    .waitForFunction(
      (id) => document.querySelector(`[data-cw-id="${id}"]`)?.getAttribute("aria-expanded") !== "true",
      triggerId,
      { timeout: 1000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    await page.mouse.click(2, 2).catch(() => { });
  }
}
