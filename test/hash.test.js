import { test } from "node:test";
import assert from "node:assert/strict";
import { sha1, shortId, slugify } from "../src/util/hash.js";

test("sha1 is deterministic", () => {
  assert.equal(sha1("hello"), sha1("hello"));
  assert.notEqual(sha1("hello"), sha1("world"));
});

test("shortId truncates the hash to the requested length", () => {
  assert.equal(shortId("hello").length, 10);
  assert.equal(shortId("hello", 6).length, 6);
});

test("slugify produces a safe, lowercase, length-capped slug", () => {
  assert.equal(slugify("https://Example.com/Path?x=1"), "example-com-path-x-1");
  assert.equal(slugify(""), "page");
});
