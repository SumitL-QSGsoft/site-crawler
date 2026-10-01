import { TABLE_SELECTOR } from "./selectors.js";

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_PLATEAU_LIMIT = 3;
const DEFAULT_STEP_TIMEOUT = 1500;
const DEFAULT_MAX_ROWS = 2000;

/**
 * Scrolls a table/grid's scrollable container step by step to force virtualized rows to render,
 * accumulating every unique row it sees along the way. Virtualized libraries recycle their DOM
 * nodes as you scroll, so reading only the final scroll position would silently drop everything
 * scrolled past - this keeps every row it has ever seen, keyed by its own cell contents.
 *
 * `pageOrFrame` is any Playwright Page or Frame; `tableIndex` is the position of the table within
 * `TABLE_SELECTOR`'s match order on that page/frame (the same order the quick per-screen table
 * scan uses, so callers can correlate the two).
 */
export async function extractVirtualizedTable(
  pageOrFrame,
  tableIndex,
  { maxSteps = DEFAULT_MAX_STEPS, plateauLimit = DEFAULT_PLATEAU_LIMIT, stepTimeout = DEFAULT_STEP_TIMEOUT, maxRows = DEFAULT_MAX_ROWS } = {}
) {
  const rows = new Map(); // row fingerprint -> cells, preserves first-seen order
  let headers = [];
  let consecutiveNoNewRows = 0;

  for (let step = 0; step < maxSteps; step++) {
    const snapshot = await pageOrFrame.evaluate(
      ({ tableSelector, tableIndex }) => window.__crawlerHelpers.readVirtualizedTableStep(tableSelector, tableIndex),
      { tableSelector: TABLE_SELECTOR, tableIndex }
    );
    if (!snapshot) break; // table/container no longer found (detached) - stop, keep what we have so far

    if (snapshot.headers.length) headers = snapshot.headers;

    let newRowCount = 0;
    for (const row of snapshot.rows) {
      const key = row.join("\u0001");
      if (!rows.has(key)) {
        rows.set(key, row);
        newRowCount += 1;
      }
    }
    if (rows.size >= maxRows) break; // safety valve for an effectively-unbounded grid

    if (snapshot.atBottom) break; // scrolled container has no more content left to reveal
    consecutiveNoNewRows = newRowCount === 0 ? consecutiveNoNewRows + 1 : 0;
    if (consecutiveNoNewRows >= plateauLimit) break; // scrolling further isn't revealing anything new

    // Give the framework a bounded, event-driven chance to react to the scroll (fetch the next
    // page of data, render new rows) before reading again - waits for the rendered row count to
    // actually change instead of a fixed sleep. If nothing changes within the window, the next
    // iteration's plateau check above is what eventually stops the loop.
    await pageOrFrame
      .waitForFunction(
        ({ tableSelector, tableIndex, previousRowCount }) => {
          const current = window.__crawlerHelpers.peekVirtualizedTableRowCount(tableSelector, tableIndex);
          return current === null || current !== previousRowCount;
        },
        { tableSelector: TABLE_SELECTOR, tableIndex, previousRowCount: snapshot.renderedRowCount },
        { timeout: stepTimeout }
      )
      .catch(() => { });
  }

  return { headers, rows: [...rows.values()] };
}
