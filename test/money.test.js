import test from "node:test";
import assert from "node:assert/strict";

import {
  computeTotalsCents, formatCents, lineAmountCents, parseCents,
} from "../js/domain/money.js";

test("money parses and formats integer cents", () => {
  assert.equal(parseCents("1000"), 100000);
  assert.equal(parseCents("1234.5"), 123450);
  assert.equal(formatCents(123450), "$1,234.50");
  assert.throws(() => parseCents("1.001"), /two decimal places/);
});

test("line totals use deterministic integer arithmetic", () => {
  assert.equal(lineAmountCents({ qty: "0.3", rate: "0.10", amount: "" }), 3);
  assert.equal(lineAmountCents({ qty: "99", rate: "99", amount: "0.30" }), 30);
  assert.deepEqual(computeTotalsCents([
    { amount: "0.10" },
    { amount: "0.20" },
  ]), {
    subtotalCents: 30,
    gstCents: 3,
    totalCents: 33,
  });
});
