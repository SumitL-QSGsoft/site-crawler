const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];

// Normalizes a URL for dedup purposes: strips the fragment (unless it's a hash-router route like
// #/path or #!/path, which some SPAs use as their only routing signal), sorts query params for
// stable comparison, and drops common tracking params so ?utm_source=... doesn't fork the graph.
export function normalizeUrl(rawUrl, { stripQuery = false } = {}) {
  try {
    const u = new URL(rawUrl);
    if (!/^#[!/]/.test(u.hash)) {
      u.hash = "";
    }
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    if (stripQuery) {
      u.search = "";
    } else {
      const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
      u.search = "";
      sorted.forEach(([k, v]) => u.searchParams.append(k, v));
    }
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function sameOrigin(url, originUrl) {
  try {
    return new URL(url).origin === new URL(originUrl).origin;
  } catch {
    return false;
  }
}

function registrableDomain(hostname) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === "localhost") return hostname;
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

// Looser than sameOrigin(): app.example.com and example.com count as the same site (naive,
// no public-suffix-list), so a SPA/SSR app split across subdomains isn't excluded by
// sameOriginOnly the way a strict origin (scheme+host+port) comparison would.
export function sameSite(url, originUrl) {
  try {
    const a = new URL(url);
    const b = new URL(originUrl);
    return a.protocol === b.protocol && registrableDomain(a.hostname) === registrableDomain(b.hostname);
  } catch {
    return false;
  }
}

// File extensions we never want to treat as crawlable HTML screens.
const NON_NAVIGABLE_RE = /\.(pdf|zip|jpg|jpeg|png|gif|svg|mp4|mp3|csv|docx?|xlsx?)(\?|$)/i;

export function isNavigable(url) {
  return !NON_NAVIGABLE_RE.test(url);
}
