import { test } from "node:test";
import assert from "node:assert/strict";

import { journalSince } from "../src/lib/duration.js";

test("minutes unit", () => {
  assert.equal(journalSince("30m"), "30 minutes ago");
});

test("hours unit", () => {
  assert.equal(journalSince("2h"), "2 hours ago");
});

test("days unit", () => {
  assert.equal(journalSince("1d"), "1 days ago"); // current contract always pluralizes
});

test("seconds unit", () => {
  assert.equal(journalSince("45s"), "45 seconds ago");
});

test("default unit is minutes when none given", () => {
  assert.equal(journalSince("30"), "30 minutes ago");
});

test("default argument is 30m", () => {
  assert.equal(journalSince(), "30 minutes ago");
});

test("whitespace is trimmed", () => {
  assert.equal(journalSince("  10m  "), "10 minutes ago");
});

test("zero value is valid", () => {
  assert.equal(journalSince("0s"), "0 seconds ago");
});

test("non-numeric input passes through unchanged", () => {
  assert.equal(journalSince("abc"), "abc");
});

test("decimal value is not matched and passes through", () => {
  assert.equal(journalSince("1.5h"), "1.5h");
});

test("empty string passes through", () => {
  assert.equal(journalSince(""), "");
});
