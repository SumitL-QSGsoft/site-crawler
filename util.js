import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

export function shortId(str, len = 10) {
  return sha1(str).slice(0, len);
}

export function slugify(str) {
  return (str || "")
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "page";
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf-8");
}

// Normalize a URL for dedup purposes: strip fragment (unless it's a hash-router route
// like #/path or #!/path), sort query params, drop common tracking params.
export function normalizeUrl(rawUrl, { stripQuery = false } = {}) {
  try {
    const u = new URL(rawUrl);
    if (!/^#[!/]/.test(u.hash)) {
      u.hash = "";
    }
    const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
    trackingParams.forEach((p) => u.searchParams.delete(p));
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

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
