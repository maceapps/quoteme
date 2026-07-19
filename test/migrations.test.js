import test from "node:test";
import assert from "node:assert/strict";
import {
  REGISTER_SCHEMAS, TIMESHEET_SCHEMAS, decodeDataEnvelope, encodeDataEnvelope,
} from "../js/domain/data-schema.js";
import {
  buildMigrationPlan, deterministicUuid, verifyOperation,
} from "../js/domain/migration-plan.js";

const json = (value) => JSON.stringify(value);

function legacyFixture() {
  const quoteHeaders = REGISTER_SCHEMAS.Quotes.slice(0, 15);
  const invoiceHeaders = REGISTER_SCHEMAS.Invoices.slice(0, 17);
  const jobHeaders = TIMESHEET_SCHEMAS.Jobs.slice(0, 13);
  const workerHeaders = TIMESHEET_SCHEMAS.Workers.slice(0, 8);
  const timesheetHeaders = TIMESHEET_SCHEMAS.Timesheets.slice(0, 28);
  return {
    datasetId: "dataset-1",
    register: {
      spreadsheetId: "register-sheet",
      tabs: {
        Quotes: [
          quoteHeaders,
          [
            "QTE-0001", "2026-07-01", "Client", "Site", "Scope", 100, 10, 110,
            "2026-07-31", "Accepted", "INV-0001", "", "https://docs.google.com/document/d/doc1/edit",
            "https://drive.google.com/file/d/pdf1/view",
            json({ type: "quote", number: "QTE-0001", jobId: "JOB-1" }),
          ],
        ],
        Invoices: [
          invoiceHeaders,
          [
            "INV-0001", "2026-07-02", "Client", "Site", "Scope", 100, 10, 110,
            "2026-07-16", "Unpaid", "", "", "", "QTE-0001",
            "https://docs.google.com/document/d/doc2/edit",
            "https://drive.google.com/file/d/pdf2/view",
            json({ type: "invoice", number: "INV-0001", jobId: "JOB-1", quoteRef: "QTE-0001" }),
          ],
        ],
      },
    },
    timesheets: {
      spreadsheetId: "timesheet-sheet",
      tabs: {
        Jobs: [
          jobHeaders,
          [
            "JOB-1", "Active", "Job", "Client", "", "", "", "", "Site",
            "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z",
            json({ id: "JOB-1", status: "Active", name: "Job", client: {}, jobSite: "Site" }),
            "[]",
          ],
        ],
        Workers: [
          workerHeaders,
          [
            "WORKER-1", "Active", "Alex", "Worker", "", "2026-07-01T00:00:00.000Z",
            "2026-07-01T00:00:00.000Z",
            json({ id: "WORKER-1", status: "Active", firstName: "Alex", lastName: "Worker" }),
          ],
        ],
        Timesheets: [
          timesheetHeaders,
          [
            "TS-1", "2026-07-13", "2026-07-19", "JOB-1", "Job", "Alex Worker",
            "2026-07-13", 8, "2026-07-14", 8, "2026-07-15", 8,
            "2026-07-16", 8, "2026-07-17", 8, "2026-07-18", 0,
            "2026-07-19", 0, 40, "", "", "", "2026-07-19T00:00:00.000Z",
            "2026-07-19T00:00:00.000Z",
            json({ id: "TS-1", jobId: "JOB-1", workerId: "WORKER-1" }),
            "WORKER-1",
          ],
        ],
      },
    },
    now: "2026-07-19T09:00:00.000Z",
  };
}

test("DataJSON codecs read legacy payloads and round-trip v2 envelopes", () => {
  assert.deepEqual(decodeDataEnvelope('{"id":"JOB-1"}', "job").payload, { id: "JOB-1" });
  const encoded = encodeDataEnvelope("job", { id: "JOB-1" });
  const decoded = decodeDataEnvelope(encoded, "job");
  assert.equal(decoded.schemaVersion, 2);
  assert.deepEqual(decoded.payload, { id: "JOB-1" });
  assert.equal(
    decodeDataEnvelope('{"schemaVersion":99,"entityType":"job","payload":{}}', "job").error,
    "unsupported-schema-version",
  );
});

test("migration resolves a unique legacy worker name", async () => {
  const fixture = legacyFixture();
  fixture.timesheets.tabs.Timesheets[1][27] = "";
  const payload = JSON.parse(fixture.timesheets.tabs.Timesheets[1][26]);
  delete payload.workerId;
  fixture.timesheets.tabs.Timesheets[1][26] = JSON.stringify(payload);
  const plan = await buildMigrationPlan(fixture);
  const timesheet = plan.operations.find((operation) => operation.entityType === "timesheet");
  assert.equal(plan.summary.quarantine, 0);
  assert.equal(
    timesheet.target[TIMESHEET_SCHEMAS.Timesheets.indexOf("Worker ID")],
    "WORKER-1",
  );
});

test("migration plan adds stable document IDs, foreign keys, and file IDs", async () => {
  const plan = await buildMigrationPlan(legacyFixture());
  assert.deepEqual(plan.summary, {
    scanned: 5, apply: 5, unchanged: 0, quarantine: 0, blocking: 0,
  });

  const quote = plan.operations.find((operation) => operation.entityType === "quote");
  const invoice = plan.operations.find((operation) => operation.entityType === "invoice");
  const quoteId = quote.target[REGISTER_SCHEMAS.Quotes.indexOf("Record ID")];
  assert.equal(quoteId, await deterministicUuid(
    "dataset-1:register-sheet:Quotes:QTE-0001",
  ));
  assert.equal(
    invoice.target[REGISTER_SCHEMAS.Invoices.indexOf("Source Quote ID")],
    quoteId,
  );
  assert.equal(quote.target[REGISTER_SCHEMAS.Quotes.indexOf("Doc File ID")], "doc1");
  assert.equal(quote.target[REGISTER_SCHEMAS.Quotes.indexOf("PDF File ID")], "pdf1");
  assert.equal((await verifyOperation(quote, quote.target)).postimage, true);
});

test("migration planning is idempotent on its own target rows", async () => {
  const fixture = legacyFixture();
  const first = await buildMigrationPlan(fixture);
  const migrated = legacyFixture();
  migrated.register.tabs.Quotes = [
    REGISTER_SCHEMAS.Quotes,
    first.operations.find((operation) => operation.entityType === "quote").target,
  ];
  migrated.register.tabs.Invoices = [
    REGISTER_SCHEMAS.Invoices,
    first.operations.find((operation) => operation.entityType === "invoice").target,
  ];
  for (const [tab, entityType] of [["Jobs", "job"], ["Workers", "worker"], ["Timesheets", "timesheet"]]) {
    migrated.timesheets.tabs[tab] = [
      TIMESHEET_SCHEMAS[tab],
      first.operations.find((operation) => operation.entityType === entityType).target,
    ];
  }
  const second = await buildMigrationPlan(migrated);
  assert.equal(second.summary.apply, 0);
  assert.equal(second.summary.unchanged, 5);
  assert.equal(second.summary.quarantine, 0);
});

test("duplicate business numbers and malformed payloads are quarantined", async () => {
  const fixture = legacyFixture();
  fixture.register.tabs.Quotes.push([...fixture.register.tabs.Quotes[1]]);
  fixture.timesheets.tabs.Workers[1][7] = "{broken";
  const plan = await buildMigrationPlan(fixture);
  assert.equal(plan.summary.quarantine, 5);
  assert.ok(plan.quarantined.some((item) => item.reasons.includes("duplicate-human-number")));
  assert.ok(plan.quarantined.some((item) => item.reasons.includes("malformed-json")));
});

test("missing entity tabs block migration instead of creating empty replacements", async () => {
  const fixture = legacyFixture();
  fixture.register.tabs.Invoices = [];
  const plan = await buildMigrationPlan(fixture);
  assert.equal(plan.summary.blocking, 1);
  assert.equal(plan.blockingIssues[0].code, "missing-entity-tab");
});

test("foreign keys to duplicate jobs are quarantined as ambiguous", async () => {
  const fixture = legacyFixture();
  fixture.timesheets.tabs.Jobs.push([...fixture.timesheets.tabs.Jobs[1]]);
  const plan = await buildMigrationPlan(fixture);
  assert.ok(plan.quarantined.some((item) => item.entityType === "quote"
    && item.reasons.includes("unresolved-job-id")));
  assert.ok(plan.quarantined.some((item) => item.entityType === "timesheet"
    && item.reasons.includes("unresolved-job-id")));
});
