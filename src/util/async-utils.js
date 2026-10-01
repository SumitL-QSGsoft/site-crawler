export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `fn` over `items` with at most `limit` in flight at once - a bounded worker pool, same
// idea as Crawler's page-level workers but scoped to one screen's own click/form probes so a
// page with many buttons isn't probed one full scratch-page-navigation at a time.
export async function mapLimit(items, limit, fn) {
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
