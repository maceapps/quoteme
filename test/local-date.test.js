import test from "node:test";
import assert from "node:assert/strict";

import {
  addLocalDays, formatLocalDate, localDateISO, mondayFor, parseLocalDate, todayISO,
} from "../js/domain/local-date.js";

test("LocalDate validates leap years and rejects rollover dates", () => {
  assert.equal(localDateISO(parseLocalDate("2024-02-29")), "2024-02-29");
  assert.throws(() => parseLocalDate("2025-02-29"), /not a valid date/);
});

test("LocalDate arithmetic crosses Australian DST without losing a day", () => {
  assert.equal(localDateISO(addLocalDays("2026-09-15", 30)), "2026-10-15");
  assert.equal(localDateISO(addLocalDays("2026-10-04", -1)), "2026-10-03");
});

test("LocalDate derives Monday weeks and local today", () => {
  assert.equal(localDateISO(mondayFor("2026-07-19")), "2026-07-13");
  assert.equal(todayISO(new Date(2026, 6, 20, 1, 30)), "2026-07-20");
  assert.equal(formatLocalDate("2026-07-20"), "20 / 07 / 2026");
});
