export const LEGACY_SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 2;
export const MIGRATION_ID = "schema-v1-to-v2";
export const APP_SCHEMA_LABEL = "refactor-phase-3";

const DOCUMENT_COMMON = [
  "Record ID", "Revision", "Row Schema", "Job ID",
];

export const REGISTER_SCHEMAS = Object.freeze({
  Quotes: Object.freeze([
    "Quote No.", "Date Issued", "Client", "Job / Site", "Description",
    "Amount (ex GST)", "GST (10%)", "Total (inc GST)", "Valid Until", "Status",
    "Converted to Inv.", "Notes", "DocLink", "PdfLink", "DataJSON",
    ...DOCUMENT_COMMON, "Converted Invoice ID", "Doc File ID", "PDF File ID",
    "Created", "Updated", "Deleted At",
  ]),
  Invoices: Object.freeze([
    "Invoice No.", "Date Issued", "Client", "Job / Site", "Description",
    "Amount (ex GST)", "GST (10%)", "Total (inc GST)", "Due Date", "Status",
    "Date Paid", "Received", "Notes", "Quote Ref", "DocLink", "PdfLink", "DataJSON",
    ...DOCUMENT_COMMON, "Source Quote ID", "Doc File ID", "PDF File ID",
    "Created", "Updated", "Deleted At",
  ]),
});

export const TIMESHEET_SCHEMAS = Object.freeze({
  Jobs: Object.freeze([
    "Job ID", "Status", "Job Name", "Client", "Attn", "Address",
    "Suburb / State / Postcode", "Phone", "Job / Site", "Created", "Updated", "DataJSON",
    "Legacy Worker IDs (unused)", "Revision", "Row Schema", "Deleted At",
  ]),
  Workers: Object.freeze([
    "Worker ID", "Status", "First Name", "Last Name", "Mobile", "Created", "Updated", "DataJSON",
    "Revision", "Row Schema", "Deleted At",
  ]),
  Timesheets: Object.freeze([
    "Timesheet ID", "Week Start", "Week End", "Job ID", "Job Name", "Worker",
    "Monday Date", "Monday Hours", "Tuesday Date", "Tuesday Hours",
    "Wednesday Date", "Wednesday Hours", "Thursday Date", "Thursday Hours",
    "Friday Date", "Friday Hours", "Saturday Date", "Saturday Hours",
    "Sunday Date", "Sunday Hours", "Total Hours", "Weekly Note",
    "DocLink", "PdfLink", "Created", "Updated", "DataJSON", "Worker ID",
    "Revision", "Row Schema", "Doc File ID", "PDF File ID", "Deleted At",
  ]),
});

export const SYSTEM_SCHEMAS = Object.freeze({
  Metadata: Object.freeze(["Key", "Value", "Updated", "DataJSON"]),
  Migrations: Object.freeze([
    "Run ID", "Migration ID", "From Version", "To Version", "Started", "Completed",
    "Status", "Checkpoint", "Plan File ID", "Backup File ID", "DataJSON",
  ]),
  "Migration Quarantine": Object.freeze([
    "Run ID", "Workbook", "Tab", "Row", "Logical Key", "Reason", "Created", "DataJSON",
  ]),
});

export const WORKBOOK_SCHEMAS = Object.freeze({
  register: Object.freeze({ ...REGISTER_SCHEMAS, ...SYSTEM_SCHEMAS }),
  timesheets: Object.freeze({ ...TIMESHEET_SCHEMAS, ...SYSTEM_SCHEMAS }),
});

export const FIELD_AUTHORITY = Object.freeze({
  columns: Object.freeze([
    "identity", "revision", "row schema", "foreign keys", "status",
    "created/updated/deleted timestamps", "Drive file IDs",
  ]),
  dataJSON: "structured editable payload",
  legacyColumns: "display projections retained during dual-read",
});

export const PURGE_POLICY = Object.freeze({
  automaticPurge: false,
  restoreWindowDays: 90,
  retainedRecordYears: 7,
  requirements: Object.freeze([
    "verified backup",
    "expired retention period",
    "no retained references",
    "successful dry-run reconciliation",
    "explicit user confirmation",
  ]),
});

export function headerIndex(headers) {
  const index = new Map();
  headers.forEach((header, position) => {
    if (header && !index.has(header)) index.set(header, position);
  });
  return index;
}

export function encodeDataEnvelope(entityType, payload) {
  return JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    entityType,
    payload,
  });
}

export function decodeDataEnvelope(raw, expectedType = "") {
  if (!raw) return { payload: null, schemaVersion: 0, entityType: expectedType, error: "missing" };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { payload: null, schemaVersion: 0, entityType: expectedType, error: "not-object" };
    }
    const isEnvelope = Object.prototype.hasOwnProperty.call(parsed, "schemaVersion")
      || Object.prototype.hasOwnProperty.call(parsed, "entityType")
      || Object.prototype.hasOwnProperty.call(parsed, "payload");
    if (isEnvelope) {
      if (!Number.isInteger(parsed.schemaVersion)
        || parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        return {
          payload: null,
          schemaVersion: Number(parsed.schemaVersion) || 0,
          entityType: parsed.entityType || expectedType,
          error: "unsupported-schema-version",
        };
      }
      if (!parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
        return {
          payload: null,
          schemaVersion: parsed.schemaVersion,
          entityType: parsed.entityType || expectedType,
          error: "invalid-envelope-payload",
        };
      }
      if (expectedType && parsed.entityType !== expectedType) {
        return {
          payload: null,
          schemaVersion: parsed.schemaVersion,
          entityType: parsed.entityType,
          error: "entity-type-mismatch",
        };
      }
      return {
        payload: parsed.payload,
        schemaVersion: Number(parsed.schemaVersion),
        entityType: parsed.entityType || expectedType,
        error: "",
      };
    }
    return {
      payload: parsed,
      schemaVersion: LEGACY_SCHEMA_VERSION,
      entityType: expectedType,
      error: "",
    };
  } catch {
    return { payload: null, schemaVersion: 0, entityType: expectedType, error: "malformed-json" };
  }
}

export function fileIdFromDriveLink(link) {
  const text = String(link || "");
  const pathMatch = /\/d\/([-\w]+)/.exec(text);
  if (pathMatch) return pathMatch[1];
  try {
    const url = new URL(text);
    return url.searchParams.get("id") || "";
  } catch {
    return "";
  }
}
