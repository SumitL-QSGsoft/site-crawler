// A DFS work stack with its own visited-URL bookkeeping, so the crawler doesn't juggle two loose
// collections (stack array + visited Set) itself. LIFO rather than FIFO: whatever a screen
// discovers (query-param variants from its own forms, modals/popovers from its own clicks, then
// plain same-page links to other routes) is explored immediately - fully draining that route's
// own state space - before backtracking to a sibling route queued earlier. See crawler.js's
// discovery order (links, then clicks, then forms) for how that maps to "root, then params, then
// click-screens" priority: whatever is pushed *last* sits on top and is popped *next*.
export class CrawlQueue {
  #items = [];
  #visited = new Set();
  #visitedStates = new Set();
  #probedContent = new Set();

  seed(item, normalizedUrl) {
    this.#items.push(item);
    this.#visited.add(normalizedUrl);
  }

  hasVisited(normalizedUrl) {
    return this.#visited.has(normalizedUrl);
  }

  markVisited(normalizedUrl) {
    this.#visited.add(normalizedUrl);
  }

  // Tracks *rendered state* fingerprints (see util/state-fingerprint.js), separate from the
  // URL-based visited set above - guards against SPA state changes that loop back to an
  // already-seen screen without ever touching the URL (a plain URL visited-set can't catch that).
  hasVisitedState(signature) {
    return this.#visitedStates.has(signature);
  }

  markVisitedState(signature) {
    this.#visitedStates.add(signature);
  }

  // Tracks a screen's content alone (no URL) - different routes that happen to render an
  // identical screen (templated placeholder pages, a route that never actually swapped content,
  // etc.) share one entry here. Each one still gets its own written screen/node, but only the
  // first is ever click/form-probed - every button on an identical screen would just rediscover
  // the same candidates again, so repeating that per route is pure wasted time.
  hasProbedContent(signature) {
    return this.#probedContent.has(signature);
  }

  markProbedContent(signature) {
    this.#probedContent.add(signature);
  }

  // Appends to the top of the stack - the next item popped, diving deeper into the current
  // branch rather than fanning out breadth-first.
  push(item) {
    this.#items.push(item);
  }

  // Puts an already-dequeued item back on top for immediate reprocessing (e.g. retrying the
  // current URL right after authenticating) - same end as push() since that's "next" now.
  unshift(item) {
    this.#items.push(item);
  }

  shift() {
    return this.#items.pop();
  }

  get length() {
    return this.#items.length;
  }
}
