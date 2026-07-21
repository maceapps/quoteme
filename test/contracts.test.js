import test from "node:test";
import assert from "node:assert/strict";

import { validateBusinessDetails } from "../js/domain/business.js";
import {
  validateConversionCommand, validateDocument, validateInvoiceStatusCommand,
} from "../js/domain/documents.js";
import { assertJobNameAvailable, validateJob } from "../js/domain/jobs.js";
import { validateTimesheet } from "../js/domain/timesheets.js";
import { validateWorker } from "../js/domain/workers.js";

const invoice = {
  type: "invoice",
  number: "INV-0001",
  jobId: "JOB-1",
  client: { name: "Example Client" },
  jobSite: "Site",
  lineItems: [{ description: "Labour", qty: "2", rate: "50.00", amount: "" }],
  issueDate: "2026-07-19",
  dueDate: "2026-08-18",
  status: "Unpaid",
};

test("entity contracts reject unsupported statuses", () => {
  assert.throws(() => validateJob({ name: "Job", status: "Deleted" }), /Job status/);
  assert.throws(() => validateWorker({
    firstName: "Ada",
    lastName: "Lovelace",
    status: "Away",
  }), /Worker status/);
});

test("job names must be unique across previous jobs", () => {
  const jobs = [
    { id: "JOB-1", name: "Smith Street" },
    { id: "JOB-2", name: "Old Site", deletedAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.throws(
    () => assertJobNameAvailable("smith street", jobs),
    /already exists/,
  );
  assert.throws(
    () => assertJobNameAvailable("Old Site", jobs),
    /already exists/,
  );
  assert.doesNotThrow(() =>
    assertJobNameAvailable("Smith Street", jobs, { excludeId: "JOB-1" }));
  assert.doesNotThrow(() => assertJobNameAvailable("New Site", jobs));
});

test("document contracts normalize cents and enforce date order", () => {
  const result = validateDocument(invoice);
  assert.equal(result.lineItems[0].rateCents, 5000);
  assert.equal(result.lineItems[0].amountCents, 10000);
  assert.throws(() => validateDocument({
    ...invoice,
    dueDate: "2026-07-18",
  }), /cannot be before/);
});

test("payment commands require consistent paid fields", () => {
  assert.deepEqual(validateInvoiceStatusCommand("INV-0001", "Paid", {
    datePaid: "2026-07-20",
    received: "110.00",
  }), {
    number: "INV-0001",
    status: "Paid",
    datePaid: "2026-07-20",
    receivedCents: 11000,
  });
  assert.throws(() => validateInvoiceStatusCommand("INV-0001", "Paid"), /Date paid/);
});

test("quote conversion rejects incomplete linkage before writes", () => {
  assert.deepEqual(validateConversionCommand("QTE/2026 #1", "INV/2026 #1"), {
    quoteNumber: "QTE/2026 #1",
    invoiceNumber: "INV/2026 #1",
  });
  assert.throws(() => validateConversionCommand("QTE-0001", ""), /Invoice number is required/);
});

test("timesheet contracts retain integer hour hundredths", () => {
  const result = validateTimesheet({
    jobId: "JOB-1",
    jobName: "Job",
    workerId: "WORKER-1",
    workerName: "Grace Hopper",
    weekStart: "2026-07-13",
    days: ["13", "14", "15", "16", "17", "18", "19"].map((day, index) => ({
      date: `2026-07-${day}`,
      hours: index === 0 ? "7.25" : "0",
    })),
  });
  assert.equal(result.days[0].hoursHundredths, 725);
  assert.equal(result.totalHoursHundredths, 725);
  assert.equal(result.weekEnd, "2026-07-19");
});

test("business details validate before persistence", () => {
  assert.equal(validateBusinessDetails({
    name: "Example Pty Ltd",
    email: "office@example.com",
    abn: "12 345 678 901",
  }).name, "Example Pty Ltd");
  assert.throws(() => validateBusinessDetails({ name: "", email: "bad" }), /Business email|Business name/);
});
