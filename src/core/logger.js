const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// A tiny leveled logger so call sites don't sprinkle raw console.* calls everywhere and so
// output can be silenced/redirected in tests without stubbing the global console.
export function createLogger(namespace, { level = "info" } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const prefix = namespace ? `[${namespace}]` : "";

  const log = (lvl, method, args) => {
    if (LEVELS[lvl] < threshold) return;
    console[method](prefix, ...args);
  };

  return {
    debug: (...args) => log("debug", "debug", args),
    info: (...args) => log("info", "log", args),
    warn: (...args) => log("warn", "warn", args),
    error: (...args) => log("error", "error", args),
    child(childNamespace) {
      return createLogger(namespace ? `${namespace}:${childNamespace}` : childNamespace, { level });
    },
  };
}
