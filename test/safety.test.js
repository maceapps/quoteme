import test from "node:test";
import assert from "node:assert/strict";

import { beginRender } from "../js/rendering.js";
import { escapeAttr, escapeHtml, safeGoogleUrl } from "../js/security.js";

test("security helpers render hostile values inert", () => {
  assert.equal(escapeHtml("<script>&"), "&lt;script&gt;&amp;");
  assert.equal(escapeAttr("\"'<>"), "&quot;&#39;&lt;&gt;");
  assert.equal(safeGoogleUrl("javascript:alert(1)"), "");
  assert.equal(safeGoogleUrl("https://drive.google.com.evil.example/file"), "");
  assert.equal(
    safeGoogleUrl("https://drive.google.com/file/d/test/view"),
    "https://drive.google.com/file/d/test/view",
  );
});

test("render tokens invalidate stale async views", () => {
  const container = { dataset: {}, hidden: false };
  const first = beginRender(container);
  const second = beginRender(container);
  assert.equal(first(), false);
  assert.equal(second(), true);
  container.hidden = true;
  assert.equal(second(), false);
});
