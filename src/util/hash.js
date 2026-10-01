import crypto from "node:crypto";

export function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

export function shortId(str, len = 10) {
  return sha1(str).slice(0, len);
}

// Turns an arbitrary string (usually a URL) into a filesystem/URL-safe slug for screen IDs.
export function slugify(str) {
  return (
    (str || "")
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  );
}
