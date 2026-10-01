import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, sameOrigin, sameSite, isNavigable } from "../src/util/url-utils.js";

test("normalizeUrl strips plain in-page anchors", () => {
  assert.equal(normalizeUrl("https://example.com/page#section"), "https://example.com/page");
});

test("normalizeUrl preserves hash-router routes", () => {
  assert.equal(normalizeUrl("https://example.com/#/dashboard"), "https://example.com/#/dashboard");
  assert.equal(normalizeUrl("https://example.com/#!/legacy"), "https://example.com/#!/legacy");
});

test("normalizeUrl drops tracking params and sorts the rest", () => {
  const result = normalizeUrl("https://example.com/?b=2&utm_source=x&a=1");
  assert.equal(result, "https://example.com/?a=1&b=2");
});

test("normalizeUrl strips a trailing slash from the path", () => {
  assert.equal(normalizeUrl("https://example.com/page/"), "https://example.com/page");
});

test("normalizeUrl returns the input unchanged if it isn't a valid URL", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("sameOrigin compares scheme+host+port", () => {
  assert.equal(sameOrigin("https://example.com/a", "https://example.com/b"), true);
  assert.equal(sameOrigin("https://example.com/a", "https://other.com/b"), false);
  assert.equal(sameOrigin("not a url", "https://example.com"), false);
});

test("sameSite treats subdomains as the same site but rejects other domains", () => {
  assert.equal(sameSite("https://app.example.com/a", "https://example.com/b"), true);
  assert.equal(sameSite("https://example.com/a", "https://cdn.example.com/b"), true);
  assert.equal(sameSite("https://example.com/a", "https://example.org/b"), false);
  assert.equal(sameSite("http://example.com/a", "https://example.com/b"), false);
  assert.equal(sameSite("https://localhost/a", "https://localhost:3000/b"), true);
});

test("isNavigable filters out obvious file downloads", () => {
  assert.equal(isNavigable("https://example.com/report.pdf"), false);
  assert.equal(isNavigable("https://example.com/image.png?x=1"), false);
  assert.equal(isNavigable("https://example.com/page"), true);
});
