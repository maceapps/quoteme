// ============================================================================
//  store.js — the data layer.
//  Turns form data into: a saved Google Doc + PDF in Drive, and a row in the
//  register Sheet. Also reads the register back for the list views, and works
//  out the next document number.
// ============================================================================
import {
  QUOTE_PREFIX, INVOICE_PREFIX, NUMBER_PAD, DELETED_FOLDER_NAME,
  TIMESHEETS_FOLDER_NAME,
} from "./config.js";
import {
  ensureFolder, ensureRegisterSheet, ensureSubFolder, moveFile,
  uploadHtmlAsDoc, exportDocAsPdf,
  appendRow, readRows, updateValues, clearValues,
  getSheetId, trashFile, fetchDriveFile,
  ensureBusinessSheet, readBusinessDetails, writeBusinessDetails, BUSINESS_TAB,
  sendGmailWithPdf, ensureTimesheetSheet,
} from "./google.js";
import { buildDocumentHtml, buildTimesheetHtml, computeTotals } from "./documents.js";
import { validateBusinessDetails } from "./domain/business.js";
import {
  validateConversionCommand, validateDocument, validateDocumentStateCommand,
  validateInvoiceStatusCommand, validateQuoteStatusCommand, validateStatusTransition,
} from "./domain/documents.js";
import {
  assertJobNameAvailable, validateJob, validateJobDeleteCommand,
} from "./domain/jobs.js";
import { hoursFromHundredths } from "./domain/hours.js";
import { dollarsFromCents } from "./domain/money.js";
import { validateTimesheet, validateTimesheetDeleteCommand } from "./domain/timesheets.js";
import { validateWorker, validateWorkerId } from "./domain/workers.js";
import {
  commitWithReconciliation, generateFilesWithCleanup, runDeletedStateChange,
} from "./domain/workflows.js";
import {
  CURRENT_SCHEMA_VERSION, decodeDataEnvelope, encodeDataEnvelope, fileIdFromDriveLink,
} from "./domain/data-schema.js";

let ctx = {
  folderId: null,
  sheetId: null,
  company: null,
  deletedFolderId: null,
  timesheetsFolderId: null,
  timesheetsSheetId: null,
};

// Called once after sign-in so store.js knows where things live and who we are.
export async function initStore() {
  ctx.folderId = await ensureFolder();
  ctx.sheetId = await ensureRegisterSheet(ctx.folderId);
  await ensureBusinessSheet(ctx.sheetId);
  ctx.company = await readBusinessDetails(ctx.sheetId);
  ctx.timesheetsFolderId = await ensureSubFolder(TIMESHEETS_FOLDER_NAME, ctx.folderId);
  ctx.timesheetsSheetId = await ensureTimesheetSheet(ctx.timesheetsFolderId);
  return ctx;
}

// Lazily create/find the "Deleted" subfolder inside the documents folder.
async function ensureDeletedFolder() {
  if (!ctx.deletedFolderId) ctx.deletedFolderId = await ensureSubFolder(DELETED_FOLDER_NAME, ctx.folderId);
  return ctx.deletedFolderId;
}

// Column letter for a 0-based index (A, B, … Z, AA, AB, …).
function columnLetter(i) {
  let out = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

function hasV2Schema(headers) {
  return headers.includes("Row Schema");
}

function payloadFromJson(raw, entityType) {
  const decoded = decodeDataEnvelope(raw, entityType);
  if (decoded.error || !decoded.payload) {
    throw new Error(
      `The ${entityType} row has invalid DataJSON (${decoded.error || "missing payload"}). ` +
      "No changes were made.",
    );
  }
  return decoded.payload;
}

function encodedPayload(entityType, payload, versioned) {
  return versioned ? encodeDataEnvelope(entityType, payload) : JSON.stringify(payload);
}

function setNamedCell(row, headers, name, value) {
  const index = headers.indexOf(name);
  if (index >= 0) row[index] = value ?? "";
}

function recordUuid() {
  return crypto.randomUUID();
}

// The company info loaded from the Business Details tab (or null before init).
export function getCompany() { return ctx.company; }

// True once the essential fields are filled in (used to prompt setup).
export function businessDetailsComplete() {
  return !!(ctx.company && ctx.company.name);
}

// Link to the Business Details tab so the user can edit it in Google Sheets.
export async function businessSheetUrl() {
  const gid = await getSheetId(ctx.sheetId, BUSINESS_TAB);
  return `https://docs.google.com/spreadsheets/d/${ctx.sheetId}/edit#gid=${gid ?? 0}`;
}

// Re-read business details (after the user edits the sheet).
export async function refreshCompany() {
  ctx.company = await readBusinessDetails(ctx.sheetId);
  return ctx.company;
}

// Save edited business details back to the sheet, then refresh the cache.
export async function saveBusinessDetails(company) {
  const validated = validateBusinessDetails(company);
  await writeBusinessDetails(ctx.sheetId, validated);
  ctx.company = await readBusinessDetails(ctx.sheetId);
  return ctx.company;
}

// ---------------------------------------------------------------------------
//  JOBS + TIMESHEETS
// ---------------------------------------------------------------------------
const JOBS_TAB = "Jobs";
const WORKERS_TAB = "Workers";
const TIMESHEETS_TAB = "Timesheets";

function makeId(prefix) {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function jobRow(job, legacyWorkerIds = "[]", headers = []) {
  const versioned = hasV2Schema(headers);
  const row = [
    job.id, job.status || "Active", job.name, job.client?.name || "",
    job.client?.attn || "", job.client?.address || "", job.client?.suburb || "",
    job.client?.phone || "", job.jobSite || "", job.createdAt, job.updatedAt,
    encodedPayload("job", job, versioned),
    legacyWorkerIds, // Retained only while unresolved legacy timesheets need migration.
  ];
  if (versioned) {
    row.length = headers.length;
    setNamedCell(row, headers, "Revision", job.revision || 1);
    setNamedCell(row, headers, "Row Schema", CURRENT_SCHEMA_VERSION);
    setNamedCell(row, headers, "Deleted At", job.deletedAt || "");
  }
  return row.map((value) => value ?? "");
}

function jobFromRow(row) {
  const data = row._data || {};
  const { workerIds: _legacyWorkerIds, ...job } = data;
  return {
    ...job,
    id: row["Job ID"] || job.id,
    status: row.Status || job.status || "Active",
    name: row["Job Name"] || job.name || "",
    client: {
      ...(job.client || {}),
      name: row.Client || job.client?.name || "",
      attn: row.Attn || job.client?.attn || "",
      address: row.Address || job.client?.address || "",
      suburb: row["Suburb / State / Postcode"] || job.client?.suburb || "",
      phone: row.Phone || job.client?.phone || "",
    },
    jobSite: row["Job / Site"] || job.jobSite || "",
    createdAt: row.Created || job.createdAt || "",
    updatedAt: row.Updated || job.updatedAt || "",
    revision: Number(row.Revision || job.revision) || 1,
    deletedAt: row["Deleted At"] || job.deletedAt || "",
  };
}

export async function listJobs({ includeArchived = false } = {}) {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, JOBS_TAB));
  return rows.map(jobFromRow)
    .filter((job) => !job.deletedAt)
    .filter((job) => includeArchived || job.status !== "Archived");
}

export async function saveJob(input) {
  const now = new Date().toISOString();
  const validated = validateJob(input);
  const job = validateJob({
    ...validated,
    id: validated.id || makeId("JOB"),
    createdAt: validated.createdAt || now,
    updatedAt: now,
  });

  const rows = await readRows(ctx.timesheetsSheetId, JOBS_TAB);
  assertJobNameAvailable(
    job.name,
    rowsToObjects(rows).map(jobFromRow),
    { excludeId: job.id },
  );
  const idx = rows.findIndex((row, i) => i > 0 && row[0] === job.id);
  const headers = rows[0] || [];
  let legacyWorkerIds = idx >= 0 ? (rows[idx][12] || "[]") : "[]";
  if (idx >= 0 && legacyWorkerIds === "[]") {
    try {
      const ids = JSON.parse(rows[idx][11] || "{}").workerIds;
      if (Array.isArray(ids) && ids.length) legacyWorkerIds = JSON.stringify(ids);
    } catch {}
  }
  if (idx >= 0) {
    const existing = rowsToObjects([headers, rows[idx]])[0] || {};
    job.revision = (Number(existing.Revision) || 1) + 1;
    job.deletedAt = existing["Deleted At"] || "";
  } else {
    job.revision = 1;
    job.deletedAt = "";
  }
  const values = jobRow(job, legacyWorkerIds, headers);
  if (idx < 0) {
    await appendRow(ctx.timesheetsSheetId, JOBS_TAB, values);
  } else {
    const sheetRow = idx + 1;
    await updateValues(
      ctx.timesheetsSheetId,
      `${JOBS_TAB}!A${sheetRow}:${columnLetter(values.length - 1)}${sheetRow}`,
      [values],
    );
  }
  return job;
}

export async function archiveJob(id) {
  id = validateJobDeleteCommand(id).id;
  const jobs = await listJobs({ includeArchived: true });
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new Error("Job could not be found.");
  return saveJob({ ...job, status: "Archived" });
}

export async function deleteJob(id) {
  id = validateJobDeleteCommand(id).id;
  const rows = await readRows(ctx.timesheetsSheetId, JOBS_TAB);
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === id);
  if (index < 0) throw new Error("Job could not be found.");
  if ((rows[index][1] || "Active") !== "Archived") {
    throw new Error("A job must be archived before it can be deleted.");
  }
  const headers = rows[0] || [];
  const row = [...rows[index]];
  const dataIndex = headers.indexOf("DataJSON");
  const payload = payloadFromJson(row[dataIndex], "job");
  const deletedAt = new Date().toISOString();
  payload.deletedAt = deletedAt;
  row[dataIndex] = encodedPayload("job", payload, hasV2Schema(headers));
  setNamedCell(row, headers, "Deleted At", deletedAt);
  setNamedCell(row, headers, "Revision", (Number(row[headers.indexOf("Revision")]) || 1) + 1);
  await updateValues(
    ctx.timesheetsSheetId,
    `${JOBS_TAB}!A${index + 1}:${columnLetter(Math.max(row.length, headers.length) - 1)}${index + 1}`,
    [row.map((value) => value ?? "")],
  );
}

export async function listDeletedJobs() {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, JOBS_TAB));
  return rows.map(jobFromRow).filter((job) => !!job.deletedAt);
}

export async function restoreJob(id) {
  id = validateJobDeleteCommand(id).id;
  const rows = await readRows(ctx.timesheetsSheetId, JOBS_TAB);
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === id);
  if (index < 0) throw new Error("Job could not be found.");
  const headers = rows[0] || [];
  const row = [...rows[index]];
  const dataIndex = headers.indexOf("DataJSON");
  const payload = payloadFromJson(row[dataIndex], "job");
  if (!row[headers.indexOf("Deleted At")] && !payload.deletedAt) {
    throw new Error("This job is not deleted.");
  }
  delete payload.deletedAt;
  row[dataIndex] = encodedPayload("job", payload, hasV2Schema(headers));
  setNamedCell(row, headers, "Deleted At", "");
  setNamedCell(row, headers, "Revision", (Number(row[headers.indexOf("Revision")]) || 1) + 1);
  await updateValues(
    ctx.timesheetsSheetId,
    `${JOBS_TAB}!A${index + 1}:${columnLetter(Math.max(row.length, headers.length) - 1)}${index + 1}`,
    [row.map((value) => value ?? "")],
  );
}

function workerRow(worker, headers = []) {
  const versioned = hasV2Schema(headers);
  const row = [
    worker.id, worker.status || "Active", worker.firstName, worker.lastName,
    worker.mobile || "", worker.createdAt, worker.updatedAt,
    encodedPayload("worker", worker, versioned),
  ];
  if (versioned) {
    row.length = headers.length;
    setNamedCell(row, headers, "Revision", worker.revision || 1);
    setNamedCell(row, headers, "Row Schema", CURRENT_SCHEMA_VERSION);
    setNamedCell(row, headers, "Deleted At", worker.deletedAt || "");
  }
  return row.map((value) => value ?? "");
}

function workerFromRow(row) {
  const worker = row._data || {};
  return {
    ...worker,
    id: row["Worker ID"] || worker.id,
    status: row.Status || worker.status || "Active",
    firstName: row["First Name"] || worker.firstName || "",
    lastName: row["Last Name"] || worker.lastName || "",
    mobile: row.Mobile || worker.mobile || "",
    createdAt: row.Created || worker.createdAt || "",
    updatedAt: row.Updated || worker.updatedAt || "",
    revision: Number(row.Revision || worker.revision) || 1,
    deletedAt: row["Deleted At"] || worker.deletedAt || "",
  };
}

export async function listWorkers({ includeArchived = false } = {}) {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, WORKERS_TAB));
  return rows.map(workerFromRow)
    .filter((worker) => !worker.deletedAt)
    .filter((worker) => includeArchived || worker.status !== "Archived")
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
}

export async function saveWorker(input) {
  const now = new Date().toISOString();
  const validated = validateWorker(input);
  const worker = validateWorker({
    ...validated,
    id: validated.id || makeId("WORKER"),
    createdAt: validated.createdAt || now,
    updatedAt: now,
  });

  const rows = await readRows(ctx.timesheetsSheetId, WORKERS_TAB);
  const idx = rows.findIndex((row, i) => i > 0 && row[0] === worker.id);
  const headers = rows[0] || [];
  if (idx >= 0) {
    const existing = rowsToObjects([headers, rows[idx]])[0] || {};
    worker.revision = (Number(existing.Revision) || 1) + 1;
    worker.deletedAt = existing["Deleted At"] || "";
  } else {
    worker.revision = 1;
    worker.deletedAt = "";
  }
  const values = workerRow(worker, headers);
  if (idx < 0) {
    await appendRow(ctx.timesheetsSheetId, WORKERS_TAB, values);
  } else {
    const sheetRow = idx + 1;
    await updateValues(
      ctx.timesheetsSheetId,
      `${WORKERS_TAB}!A${sheetRow}:${columnLetter(values.length - 1)}${sheetRow}`,
      [values],
    );
  }
  return worker;
}

export async function archiveWorker(id) {
  id = validateWorkerId(id);
  const workers = await listWorkers({ includeArchived: true });
  const worker = workers.find((item) => item.id === id);
  if (!worker) throw new Error("Worker could not be found.");
  return saveWorker({ ...worker, status: "Archived" });
}

function timesheetRow(sheet, headers = []) {
  const versioned = hasV2Schema(headers);
  const days = sheet.days || [];
  const dayCells = [];
  for (let i = 0; i < 7; i++) {
    const hours = Number.isInteger(days[i]?.hoursHundredths)
      ? hoursFromHundredths(days[i].hoursHundredths)
      : Number(days[i]?.hours) || 0;
    dayCells.push(days[i]?.date || "", hours);
  }
  const totalHours = Number.isInteger(sheet.totalHoursHundredths)
    ? hoursFromHundredths(sheet.totalHoursHundredths)
    : Number(sheet.totalHours) || 0;
  const row = [
    sheet.id, sheet.weekStart, sheet.weekEnd, sheet.jobId, sheet.jobName,
    sheet.workerName, ...dayCells, totalHours,
    sheet.weeklyNote || "", sheet.docLink || "", sheet.pdfLink || "",
    sheet.createdAt, sheet.updatedAt, encodedPayload("timesheet", sheet, versioned),
    sheet.workerId || "",
  ];
  if (versioned) {
    row.length = headers.length;
    setNamedCell(row, headers, "Revision", sheet.revision || 1);
    setNamedCell(row, headers, "Row Schema", CURRENT_SCHEMA_VERSION);
    setNamedCell(row, headers, "Doc File ID", sheet.docFileId || "");
    setNamedCell(row, headers, "PDF File ID", sheet.pdfFileId || "");
    setNamedCell(row, headers, "Deleted At", sheet.deletedAt || "");
  }
  return row.map((value) => value ?? "");
}

function timesheetFromRow(row) {
  const data = row._data || {};
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    ...data,
    id: row["Timesheet ID"] || data.id,
    weekStart: row["Week Start"] || data.weekStart,
    weekEnd: row["Week End"] || data.weekEnd,
    jobId: row["Job ID"] || data.jobId,
    jobName: row["Job Name"] || data.jobName,
    workerName: row.Worker || data.workerName || "",
    days: data.days?.length === 7 ? data.days : dayNames.map((name) => ({
      date: row[`${name} Date`] || "",
      hours: Number(row[`${name} Hours`]) || 0,
    })),
    totalHours: Number(row["Total Hours"] || data.totalHours) || 0,
    weeklyNote: row["Weekly Note"] || data.weeklyNote || "",
    docLink: row.DocLink || data.docLink || "",
    pdfLink: row.PdfLink || data.pdfLink || "",
    docFileId: row["Doc File ID"] || data.docFileId || fileIdFromDriveLink(row.DocLink),
    pdfFileId: row["PDF File ID"] || data.pdfFileId || fileIdFromDriveLink(row.PdfLink),
    workerId: row["Worker ID"] || data.workerId || "",
    createdAt: row.Created || data.createdAt || "",
    updatedAt: row.Updated || data.updatedAt || "",
    revision: Number(row.Revision || data.revision) || 1,
    deletedAt: row["Deleted At"] || data.deletedAt || "",
  };
}

export async function listTimesheets() {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB));
  return rows.map(timesheetFromRow).filter((sheet) => !sheet.deletedAt).sort((a, b) =>
    (b.weekStart || "").localeCompare(a.weekStart || "")
    || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function deleteTimesheet(id) {
  id = validateTimesheetDeleteCommand(id).id;
  const rows = await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB);
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === id);
  if (index < 0) throw new Error("Timesheet could not be found.");
  const headers = rows[0] || [];
  const row = [...rows[index]];
  const dataIndex = headers.indexOf("DataJSON");
  const payload = payloadFromJson(row[dataIndex], "timesheet");
  const deletedAt = new Date().toISOString();
  payload.deletedAt = deletedAt;
  row[dataIndex] = encodedPayload("timesheet", payload, hasV2Schema(headers));
  setNamedCell(row, headers, "Deleted At", deletedAt);
  setNamedCell(row, headers, "Revision", (Number(row[headers.indexOf("Revision")]) || 1) + 1);
  await updateValues(
    ctx.timesheetsSheetId,
    `${TIMESHEETS_TAB}!A${index + 1}:${columnLetter(Math.max(row.length, headers.length) - 1)}${index + 1}`,
    [row.map((value) => value ?? "")],
  );
}

export async function listDeletedTimesheets() {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB));
  return rows.map(timesheetFromRow).filter((sheet) => !!sheet.deletedAt);
}

export async function restoreTimesheet(id) {
  id = validateTimesheetDeleteCommand(id).id;
  const rows = await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB);
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === id);
  if (index < 0) throw new Error("Timesheet could not be found.");
  const headers = rows[0] || [];
  const row = [...rows[index]];
  const dataIndex = headers.indexOf("DataJSON");
  const payload = payloadFromJson(row[dataIndex], "timesheet");
  if (!row[headers.indexOf("Deleted At")] && !payload.deletedAt) {
    throw new Error("This timesheet is not deleted.");
  }
  delete payload.deletedAt;
  row[dataIndex] = encodedPayload("timesheet", payload, hasV2Schema(headers));
  setNamedCell(row, headers, "Deleted At", "");
  setNamedCell(row, headers, "Revision", (Number(row[headers.indexOf("Revision")]) || 1) + 1);
  await updateValues(
    ctx.timesheetsSheetId,
    `${TIMESHEETS_TAB}!A${index + 1}:${columnLetter(Math.max(row.length, headers.length) - 1)}${index + 1}`,
    [row.map((value) => value ?? "")],
  );
}

export async function getTimesheet(jobId, workerId, weekStart) {
  const sheets = await listTimesheets();
  return sheets.find((sheet) =>
    sheet.jobId === jobId && sheet.workerId === workerId && sheet.weekStart === weekStart) || null;
}

export async function saveTimesheet(input, { allowDeletedJobForPdf = false } = {}) {
  input = validateTimesheet(input);
  const now = new Date().toISOString();
  const rows = await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB);
  const headers = rows[0] || [];
  const idIdx = input.id
    ? rows.findIndex((row, i) => i > 0 && row[0] === input.id)
    : -1;
  const keyIdx = rows.findIndex((row, i) =>
    i > 0
    && row[3] === input.jobId
    && row[1] === input.weekStart
    && (row[27] === input.workerId || (!row[27] && row[5] === input.workerName)));
  if (idIdx >= 0 && keyIdx >= 0 && idIdx !== keyIdx) {
    throw new Error("Another timesheet already exists for this job and week.");
  }
  const idx = idIdx >= 0 ? idIdx : keyIdx;

  let existing = null;
  if (idx >= 0) {
    existing = timesheetFromRow(rowsToObjects([rows[0], rows[idx]])[0]);
  }
  if (existing?.workerId && existing.workerId !== input.workerId) {
    throw new Error("A saved timesheet cannot be moved to another worker.");
  }
  if (existing?.jobId && existing.jobId !== input.jobId) {
    throw new Error("A saved timesheet cannot be moved to another job.");
  }
  const job = await listJobs({ includeArchived: true })
    .then((items) => items.find((item) => item.id === input.jobId));
  if (!job && (!existing || !allowDeletedJobForPdf)) {
    throw new Error("This timesheet cannot be edited because its job has been deleted.");
  }
  if (!existing) {
    const worker = await listWorkers()
      .then((items) => items.find((item) => item.id === input.workerId));
    if ((job.status || "Active") !== "Active") {
      throw new Error("Only active jobs can have new timesheets.");
    }
    if (!worker) throw new Error("The selected worker could not be found.");
  }
  const sheet = {
    ...existing,
    ...input,
    id: existing?.id || input.id || makeId("TS"),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
    docLink: input.docLink ?? existing?.docLink ?? "",
    pdfLink: input.pdfLink ?? existing?.pdfLink ?? "",
    revision: existing ? (Number(existing.revision) || 1) + 1 : 1,
    deletedAt: existing?.deletedAt || "",
  };
  sheet.docFileId = fileIdFromDriveLink(sheet.docLink);
  sheet.pdfFileId = fileIdFromDriveLink(sheet.pdfLink);
  const values = timesheetRow(sheet, headers);
  if (idx < 0) {
    await appendRow(ctx.timesheetsSheetId, TIMESHEETS_TAB, values);
  } else {
    const sheetRow = idx + 1;
    await updateValues(
      ctx.timesheetsSheetId,
      `${TIMESHEETS_TAB}!A${sheetRow}:${columnLetter(values.length - 1)}${sheetRow}`,
      [values],
    );
  }
  const clearedGeneratedFiles =
    (Object.prototype.hasOwnProperty.call(input, "docLink") && input.docLink === "")
    || (Object.prototype.hasOwnProperty.call(input, "pdfLink") && input.pdfLink === "");
  if (clearedGeneratedFiles && existing) {
    for (const [storedId, oldLink] of [
      [existing.docFileId, existing.docLink],
      [existing.pdfFileId, existing.pdfLink],
    ]) {
      const oldId = storedId || fileIdFromDriveLink(oldLink);
      if (oldId) {
        try { await trashFile(oldId); } catch (e) { console.warn("Could not trash stale timesheet file", e); }
      }
    }
  }
  return sheet;
}

export async function generateTimesheetPdf(input) {
  const sheet = await saveTimesheet(input, { allowDeletedJobForPdf: true });
  const job = sheet.jobSnapshot
    || (await listJobs({ includeArchived: true })).find((item) => item.id === sheet.jobId)
    || {};
  const html = buildTimesheetHtml(sheet, ctx.company, job);
  const safeJob = (sheet.jobName || "Job").replace(/[\\/:*?"<>|]/g, "-");
  const safeWorker = (sheet.workerName || "Worker").replace(/[\\/:*?"<>|]/g, "-");
  const baseName = `Timesheet — ${safeJob} — ${safeWorker} — ${sheet.weekStart}`;
  let doc = null;
  let pdf = null;
  let updated;
  try {
    doc = await uploadHtmlAsDoc(baseName, html, ctx.timesheetsFolderId);
    pdf = await exportDocAsPdf(doc.id, `${baseName}.pdf`, ctx.timesheetsFolderId);
    updated = await saveTimesheet(
      {
        ...sheet,
        docLink: doc.webViewLink,
        pdfLink: pdf.webViewLink,
      },
      { allowDeletedJobForPdf: true },
    );
  } catch (error) {
    if (doc && pdf) {
      try {
        const current = (await listTimesheets()).find((item) => item.id === sheet.id);
        if (current?.docLink === doc.webViewLink && current?.pdfLink === pdf.webViewLink) {
          updated = current;
        } else {
          await cleanupGeneratedFiles(doc, pdf);
          throw error;
        }
      } catch (reconcileError) {
        if (reconcileError === error) throw error;
        console.error("Could not reconcile an ambiguous timesheet PDF save", reconcileError);
        throw new Error(
          "Google did not confirm whether the timesheet PDF was saved. Refresh before trying again.",
          { cause: error },
        );
      }
    } else {
      await cleanupGeneratedFiles(doc, pdf);
      throw error;
    }
  }
  for (const [storedId, oldLink] of [
    [sheet.docFileId, sheet.docLink],
    [sheet.pdfFileId, sheet.pdfLink],
  ]) {
    const oldId = storedId || fileIdFromDriveLink(oldLink);
    if (oldId) {
      try { await trashFile(oldId); } catch (e) { console.warn("Could not trash old timesheet file", e); }
    }
  }

  let blob = null;
  let downloadError = null;
  try {
    blob = await fetchDriveFile(pdf.id);
  } catch (error) {
    console.error("Timesheet PDF was saved but could not be downloaded", error);
    downloadError = error.message || "Download failed";
  }
  return { sheet: updated, blob, downloadError, fileName: `${baseName}.pdf` };
}

const TAB = { quote: "Quotes", invoice: "Invoices" };
const PREFIX = { quote: QUOTE_PREFIX, invoice: INVOICE_PREFIX };

// --- next number, e.g. QTE-0007 -------------------------------------------
export async function nextNumber(type) {
  const rows = await readRows(ctx.sheetId, TAB[type]);
  const prefix = PREFIX[type];
  let max = 0;
  for (const r of rows.slice(1)) {
    const cell = (r[0] || "").trim();
    if (cell.startsWith(prefix)) {
      const n = parseInt(cell.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(NUMBER_PAD, "0");
}

// A short one-line description for the register row.
function summaryOf(data) {
  if (data.summary) return data.summary;
  if (data.type === "quote" && data.scope) return data.scope.split("\n")[0].slice(0, 80);
  const first = (data.lineItems || []).find((it) => it.description);
  return first ? first.description : "";
}

// --- save a quote or invoice ----------------------------------------------
//  1. build HTML  2. upload → Google Doc  3. export → PDF  4. append row.
//  Returns { docLink, pdfLink, number }.
// Generate the Doc + PDF in Drive for a document. Returns { doc, pdf }.
async function generateFiles(data) {
  const html = buildDocumentHtml(data, ctx.company);
  const baseName = `${data.number} — ${data.client.name || "Client"}`;
  return generateFilesWithCleanup({
    uploadDocument: () => uploadHtmlAsDoc(baseName, html, ctx.folderId),
    exportPdf: (doc) => exportDocAsPdf(doc.id, baseName + ".pdf", ctx.folderId),
    cleanupFile: (file) => trashFile(file.id),
  });
}

async function cleanupGeneratedFiles(doc, pdf) {
  for (const file of [doc, pdf]) {
    if (!file?.id) continue;
    try { await trashFile(file.id); } catch (error) {
      console.warn("Could not clean up generated file", error);
    }
  }
}

async function generatedLinksCommitted(type, number, docLink, pdfLink) {
  const rows = await readRows(ctx.sheetId, TAB[type]);
  const header = rows[0] || [];
  const docIndex = header.indexOf("DocLink");
  const pdfIndex = header.indexOf("PdfLink");
  return rows.slice(1).some((row) =>
    (row[0] || "").trim() === number
    && row[docIndex] === docLink
    && row[pdfIndex] === pdfLink);
}

async function assertNumberAvailable(data) {
  const rows = await readRows(ctx.sheetId, TAB[data.type]);
  if (rows.slice(1).some((row) => (row[0] || "").trim() === data.number)) {
    throw new Error(`${data.number} is already in use. Reopen the form to assign a new number.`);
  }
  return rows;
}

// Build the register row (array) for a quote or invoice.
function rowFor(data, totals, docLink, pdfLink, headers = [], metadata = {}) {
  const summary = summaryOf(data);
  const versioned = hasV2Schema(headers);
  const dataJson = encodedPayload(data.type, data, versioned);
  let row;
  if (data.type === "quote") {
    row = [
      data.number, data.dateIssued, data.client.name, data.jobSite, summary,
      totals.subtotal, totals.gst, totals.total, data.validUntil,
      data.status || "Pending", data.convertedTo || "", data.notes || "",
      docLink, pdfLink, dataJson,
    ];
  } else {
    row = [
      data.number, data.issueDate, data.client.name, data.jobSite, summary,
      totals.subtotal, totals.gst, totals.total, data.dueDate,
      data.status || "Unpaid", data.datePaid || "", data.received || "",
      data.notes || "", data.quoteRef || "",
      docLink, pdfLink, dataJson,
    ];
  }
  if (versioned) {
    row.length = headers.length;
    setNamedCell(row, headers, "Record ID", metadata.recordId);
    setNamedCell(row, headers, "Revision", metadata.revision || 1);
    setNamedCell(row, headers, "Row Schema", CURRENT_SCHEMA_VERSION);
    setNamedCell(row, headers, "Job ID", data.jobId);
    setNamedCell(row, headers,
      data.type === "quote" ? "Converted Invoice ID" : "Source Quote ID",
      metadata.relationshipId || "");
    setNamedCell(row, headers, "Doc File ID", metadata.docFileId);
    setNamedCell(row, headers, "PDF File ID", metadata.pdfFileId);
    setNamedCell(row, headers, "Created", metadata.createdAt);
    setNamedCell(row, headers, "Updated", metadata.updatedAt);
    setNamedCell(row, headers, "Deleted At", metadata.deletedAt || "");
  }
  return row.map((value) => value ?? "");
}

async function recordIdForNumber(tab, number) {
  if (!number) return "";
  const rows = await readRows(ctx.sheetId, tab);
  const headers = rows[0] || [];
  const idIndex = headers.indexOf("Record ID");
  const match = rows.slice(1).find((row) => row[0] === number);
  return idIndex >= 0 && match ? match[idIndex] || "" : "";
}

export async function saveDocument(data) {
  data = validateDocument(data);
  const rows = await assertNumberAvailable(data);
  const headers = rows[0] || [];
  const totals = computeTotals(data.lineItems);
  const relationshipId = data.type === "invoice"
    ? await recordIdForNumber("Quotes", data.quoteRef)
    : "";
  const { doc, pdf } = await generateFiles(data);
  const now = new Date().toISOString();
  const metadata = {
    recordId: recordUuid(),
    revision: 1,
    relationshipId,
    docFileId: doc.id,
    pdfFileId: pdf.id,
    createdAt: now,
    updatedAt: now,
  };
  const result = {
    docLink: doc.webViewLink,
    pdfLink: pdf.webViewLink,
    docFileId: doc.id,
    pdfFileId: pdf.id,
    recordId: metadata.recordId,
    number: data.number,
  };
  await commitWithReconciliation({
    write: () => appendRow(
      ctx.sheetId,
      TAB[data.type],
      rowFor(data, totals, result.docLink, result.pdfLink, headers, metadata),
    ),
    reconcile: () => generatedLinksCommitted(
      data.type,
      data.number,
      result.docLink,
      result.pdfLink,
    ),
    cleanup: () => cleanupGeneratedFiles(doc, pdf),
    ambiguousMessage:
      `Google did not confirm whether ${data.number} was saved. Refresh the register before retrying.`,
  });
  return result;
}

// --- edit an existing quote/invoice ---------------------------------------
//  Keeps the same number and sheet row. Regenerates the Doc + PDF (old ones
//  go to trash) and preserves status fields that live on the row, not the form.
export async function updateDocument(data) {
  data = validateDocument(data);
  const tab = TAB[data.type];
  const rows = await readRows(ctx.sheetId, tab);
  const header = rows[0] || [];
  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === data.number) { idx = i; break; }
  }
  if (idx < 0) throw new Error(`Could not find ${data.number} to update.`);
  const existing = rows[idx];
  const getCol = (name) => existing[header.indexOf(name)] || "";

  // Regenerate the document files.
  const totals = computeTotals(data.lineItems);
  const relationshipId = data.type === "quote"
    ? getCol("Converted Invoice ID")
    : getCol("Source Quote ID") || await recordIdForNumber("Quotes", data.quoteRef);
  const { doc, pdf } = await generateFiles(data);

  // Preserve status/workflow columns that aren't edited on the form.
  const merged = data.type === "quote"
    ? { ...data, status: getCol("Status") || data.status, convertedTo: getCol("Converted to Inv.") }
    : { ...data, status: getCol("Status") || data.status, datePaid: getCol("Date Paid"), received: getCol("Received") };

  const now = new Date().toISOString();
  const metadata = {
    recordId: getCol("Record ID") || recordUuid(),
    revision: (Number(getCol("Revision")) || 1) + 1,
    relationshipId,
    docFileId: doc.id,
    pdfFileId: pdf.id,
    createdAt: getCol("Created") || now,
    updatedAt: now,
    deletedAt: getCol("Deleted At"),
  };
  const row = rowFor(
    merged,
    totals,
    doc.webViewLink,
    pdf.webViewLink,
    header,
    metadata,
  );
  const lastCol = columnLetter(row.length - 1);
  const sheetRow = idx + 1;
  await commitWithReconciliation({
    write: () => updateValues(
      ctx.sheetId,
      `${tab}!A${sheetRow}:${lastCol}${sheetRow}`,
      [row],
    ),
    reconcile: () => generatedLinksCommitted(
      data.type,
      data.number,
      doc.webViewLink,
      pdf.webViewLink,
    ),
    cleanup: () => cleanupGeneratedFiles(doc, pdf),
    ambiguousMessage:
      `Google did not confirm whether ${data.number} was updated. Refresh the register before retrying.`,
  });

  // The row now references the replacement files; retiring old files is safe.
  for (const col of ["DocLink", "PdfLink"]) {
    const id = getCol(col === "DocLink" ? "Doc File ID" : "PDF File ID")
      || fileIdFromDriveLink(getCol(col));
    if (id) { try { await trashFile(id); } catch (e) { console.warn("Could not trash old file", e); } }
  }

  return {
    docLink: doc.webViewLink,
    pdfLink: pdf.webViewLink,
    docFileId: doc.id,
    pdfFileId: pdf.id,
    recordId: metadata.recordId,
    number: data.number,
  };
}

// --- read the register back for list views --------------------------------
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0];
  const entityType = headers.includes("Quote No.") ? "quote"
    : headers.includes("Invoice No.") ? "invoice"
      : headers.includes("Job ID") && headers.includes("Job Name") ? "job"
        : headers.includes("Worker ID") && headers.includes("First Name") ? "worker"
          : headers.includes("Timesheet ID") ? "timesheet"
            : "";
  return rows.slice(1)
    .filter((r) => (r[0] || "").trim())
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = r[i] ?? ""));
      // Recover the full original payload if present.
      if (o.DataJSON) {
        const decoded = decodeDataEnvelope(o.DataJSON, entityType);
        if (decoded.payload) o._data = decoded.payload;
        if (decoded.error) o._dataError = decoded.error;
        o._rowSchema = decoded.schemaVersion;
      }
      return o;
    });
}

async function allRows(tab) {
  return rowsToObjects(await readRows(ctx.sheetId, tab));
}
const isDeleted = (row) => !!(
  row["Deleted At"]
  || row._data?.deletedAt
  || row._data?.deleted
);

// Active (non-deleted) documents for the main list views.
export async function listQuotes() {
  return (await allRows("Quotes")).filter((r) => !isDeleted(r));
}
export async function listInvoices() {
  return (await allRows("Invoices")).filter((r) => !isDeleted(r));
}

// All soft-deleted documents (both tabs), tagged with their type.
export async function listDeleted() {
  const [quotes, invoices] = await Promise.all([allRows("Quotes"), allRows("Invoices")]);
  return [
    ...quotes.filter(isDeleted).map((r) => ({ type: "quote", no: r["Quote No."], ...r })),
    ...invoices.filter(isDeleted).map((r) => ({ type: "invoice", no: r["Invoice No."], ...r })),
  ];
}

async function updateDocumentWorkflowRow(type, number, mutate) {
  const tab = TAB[type];
  const rows = await readRows(ctx.sheetId, tab);
  const headers = rows[0] || [];
  const index = rows.findIndex((row, position) =>
    position > 0 && String(row[0] || "").trim() === number);
  if (index < 0) throw new Error(`${type === "quote" ? "Quote" : "Invoice"} could not be found.`);
  const row = [...rows[index]];
  const get = (name) => row[headers.indexOf(name)] || "";
  const payload = payloadFromJson(get("DataJSON"), type);
  await mutate({ row, headers, get, payload });
  setNamedCell(row, headers, "DataJSON", encodedPayload(type, payload, hasV2Schema(headers)));
  setNamedCell(row, headers, "Revision", (Number(get("Revision")) || 1) + 1);
  setNamedCell(row, headers, "Row Schema", CURRENT_SCHEMA_VERSION);
  setNamedCell(row, headers, "Updated", new Date().toISOString());
  await updateValues(
    ctx.sheetId,
    `${tab}!A${index + 1}:${columnLetter(Math.max(row.length, headers.length) - 1)}${index + 1}`,
    [row.map((value) => value ?? "")],
  );
}

// Mark a quote Accepted and record which invoice it became.
export async function markQuoteConverted(quoteNumber, invoiceNumber) {
  const command = validateConversionCommand(quoteNumber, invoiceNumber);
  const invoices = await allRows("Invoices");
  const invoice = invoices.find((item) => item["Invoice No."] === command.invoiceNumber);
  if (!invoice) throw new Error("Converted invoice could not be found.");
  await updateDocumentWorkflowRow("quote", command.quoteNumber, ({ row, headers, get, payload }) => {
    validateStatusTransition("quote", get("Status") || "Pending", "Accepted");
    setNamedCell(row, headers, "Status", "Accepted");
    setNamedCell(row, headers, "Converted to Inv.", command.invoiceNumber);
    setNamedCell(row, headers, "Converted Invoice ID", invoice["Record ID"] || "");
    payload.status = "Accepted";
    payload.convertedTo = command.invoiceNumber;
  });
}

// Change a quote's status (Pending / Accepted / Declined).
export async function setQuoteStatus(quoteNumber, status) {
  const command = validateQuoteStatusCommand(quoteNumber, status);
  await updateDocumentWorkflowRow("quote", command.number, ({ row, headers, get, payload }) => {
    validateStatusTransition("quote", get("Status") || "Pending", command.status);
    setNamedCell(row, headers, "Status", command.status);
    payload.status = command.status;
  });
}

// Change an invoice's status; optionally record Date Paid + Received.
export async function setInvoiceStatus(invoiceNumber, status, { datePaid = "", received = "" } = {}) {
  const command = validateInvoiceStatusCommand(
    invoiceNumber,
    status,
    { datePaid, received },
  );
  await updateDocumentWorkflowRow("invoice", command.number, ({ row, headers, get, payload }) => {
    validateStatusTransition("invoice", get("Status") || "Unpaid", command.status);
    const receivedValue = command.status === "Paid"
      ? dollarsFromCents(command.receivedCents)
      : "";
    setNamedCell(row, headers, "Status", command.status);
    setNamedCell(row, headers, "Date Paid", command.datePaid);
    setNamedCell(row, headers, "Received", receivedValue);
    payload.status = command.status;
    payload.datePaid = command.datePaid;
    payload.received = receivedValue;
  });
}

// Email a document's PDF from the signed-in Gmail account.
export async function emailPdf({ to, subject, body, pdfLink, pdfName }) {
  const id = fileIdFromDriveLink(pdfLink);
  if (!id) throw new Error("No PDF is attached to this document.");
  return sendGmailWithPdf({ to, subject, body, pdfFileId: id, pdfName });
}

// Fetch a document's PDF as a Blob (for downloading to the device).
export async function fetchPdfBlob(pdfLink) {
  const id = fileIdFromDriveLink(pdfLink);
  if (!id) throw new Error("No PDF is attached to this document.");
  return fetchDriveFile(id);
}

// Move a document's Doc + PDF between the documents folder and the Deleted
// folder, and flip the `deleted` flag stored in the row's DataJSON. The row
// stays in the register (so numbering keeps incrementing and a record remains).
async function setDeletedState(type, number, deleted) {
  const command = validateDocumentStateCommand(type, number);
  const tab = TAB[command.type];
  const rows = await readRows(ctx.sheetId, tab);
  const header = rows[0] || [];
  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === command.number) { idx = i; break; }
  }
  if (idx < 0) throw new Error("Document could not be found.");
  const existing = rows[idx];
  const getCol = (name) => existing[header.indexOf(name)] || "";

  const row = [...existing];
  const data = payloadFromJson(getCol("DataJSON"), command.type);
  const currentlyDeleted = !!(getCol("Deleted At") || data.deletedAt || data.deleted);
  if (!deleted && !currentlyDeleted) throw new Error("This document is not deleted.");
  if (deleted && currentlyDeleted) return;
  const deletedAt = deleted ? new Date().toISOString() : "";
  if (deleted) {
    data.deleted = true;
    data.deletedAt = deletedAt;
  } else {
    delete data.deleted;
    delete data.deletedAt;
  }
  setNamedCell(
    row,
    header,
    "DataJSON",
    encodedPayload(command.type, data, hasV2Schema(header)),
  );
  setNamedCell(row, header, "Deleted At", deletedAt);
  setNamedCell(row, header, "Revision", (Number(getCol("Revision")) || 1) + 1);
  setNamedCell(row, header, "Row Schema", CURRENT_SCHEMA_VERSION);
  setNamedCell(row, header, "Updated", new Date().toISOString());

  const deletedFolderId = await ensureDeletedFolder();
  const [addParent, removeParent] = deleted
    ? [deletedFolderId, ctx.folderId]
    : [ctx.folderId, deletedFolderId];
  const state = deleted ? "marked deleted" : "kept deleted";
  await runDeletedStateChange({
    deleting: deleted,
    writeState: () =>
      updateValues(
        ctx.sheetId,
        `${tab}!A${idx + 1}:${columnLetter(Math.max(row.length, header.length) - 1)}${idx + 1}`,
        [row.map((value) => value ?? "")],
      ),
    moveFiles: async () => {
      for (const linkCol of ["DocLink", "PdfLink"]) {
        const id = getCol(linkCol === "DocLink" ? "Doc File ID" : "PDF File ID")
          || fileIdFromDriveLink(getCol(linkCol));
        if (id) await moveFile(id, addParent, removeParent);
      }
    },
    partialMessage:
      `The record was ${state}, but one or more Drive files could not be moved. Retry from Deleted documents.`,
  });
}

// Soft-delete: hide from the interface, move files to the Deleted folder.
export async function deleteDocument(type, number) {
  return setDeletedState(type, number, true);
}

// Restore a soft-deleted document.
export async function restoreDocument(type, number) {
  return setDeletedState(type, number, false);
}

export function context() { return ctx; }
