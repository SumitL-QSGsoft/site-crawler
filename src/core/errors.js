// Thrown for bad/missing CLI flags or environment configuration (fails fast, before a browser launches).
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// Thrown for unrecoverable failures during a crawl run (as opposed to per-page issues, which are
// logged and skipped so one bad page doesn't kill the whole run).
export class CrawlError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "CrawlError";
  }
}
