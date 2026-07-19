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
  getSheetId, trashFile, deleteDriveFile, fetchDriveFile,
  ensureBusinessSheet, readBusinessDetails, writeBusinessDetails, BUSINESS_TAB,
  sendGmailWithPdf, ensureTimesheetSheet,
} from "./google.js";
import { buildDocumentHtml, buildTimesheetHtml, computeTotals } from "./documents.js";
import { validateBusinessDetails } from "./domain/business.js";
import {
  validateConversionCommand, validateDocument, validateDocumentStateCommand,
  validateInvoiceStatusCommand, validateQuoteStatusCommand, validateStatusTransition,
} from "./domain/documents.js";
import { validateJob, validateJobDeleteCommand } from "./domain/jobs.js";
import { hoursFromHundredths } from "./domain/hours.js";
import { dollarsFromCents } from "./domain/money.js";
import { validateTimesheet, validateTimesheetDeleteCommand } from "./domain/timesheets.js";
import { validateWorker, validateWorkerId } from "./domain/workers.js";
import {
  commitWithReconciliation, generateFilesWithCleanup, runDeletedStateChange,
} from "./domain/workflows.js";

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
  const unresolvedLegacyJobs = await backfillLegacyTimesheetWorkerIds();
  await clearLegacyJobWorkerAssociations(unresolvedLegacyJobs);
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

async function clearLegacyJobWorkerAssociations(skipJobIds = new Set()) {
  if (!ctx.timesheetsSheetId) return;
  const rows = await readRows(ctx.timesheetsSheetId, JOBS_TAB);
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (skipJobIds.has(row[0])) continue;
    let data = null;
    let hadAssociation = row[12] && row[12] !== "[]";
    try {
      const parsed = JSON.parse(row[11] || "");
      if (parsed && typeof parsed === "object") {
        data = parsed;
        if (Object.prototype.hasOwnProperty.call(data, "workerIds")) {
          delete data.workerIds;
          hadAssociation = true;
        }
      }
    } catch {}
    if (!hadAssociation) continue;
    await updateValues(
      ctx.timesheetsSheetId,
      `${JOBS_TAB}!L${index + 1}:M${index + 1}`,
      [[data ? JSON.stringify(data) : (row[11] || ""), "[]"]],
    );
  }
}

function makeId(prefix) {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function jobRow(job, legacyWorkerIds = "[]") {
  return [
    job.id, job.status || "Active", job.name, job.client?.name || "",
    job.client?.attn || "", job.client?.address || "", job.client?.suburb || "",
    job.client?.phone || "", job.jobSite || "", job.createdAt, job.updatedAt,
    JSON.stringify(job),
    legacyWorkerIds, // Retained only while unresolved legacy timesheets need migration.
  ];
}

function jobFromRow(row) {
  if (row._data) {
    const { workerIds: _legacyWorkerIds, ...job } = row._data;
    return job;
  }
  return {
    id: row["Job ID"], status: row.Status || "Active", name: row["Job Name"],
    client: {
      name: row.Client || "", attn: row.Attn || "", address: row.Address || "",
      suburb: row["Suburb / State / Postcode"] || "", phone: row.Phone || "",
    },
    jobSite: row["Job / Site"] || "",
    createdAt: row.Created || "", updatedAt: row.Updated || "",
  };
}

export async function listJobs({ includeArchived = false } = {}) {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, JOBS_TAB));
  return rows.map(jobFromRow).filter((job) => includeArchived || job.status !== "Archived");
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
  const idx = rows.findIndex((row, i) => i > 0 && row[0] === job.id);
  let legacyWorkerIds = idx >= 0 ? (rows[idx][12] || "[]") : "[]";
  if (idx >= 0 && legacyWorkerIds === "[]") {
    try {
      const ids = JSON.parse(rows[idx][11] || "{}").workerIds;
      if (Array.isArray(ids) && ids.length) legacyWorkerIds = JSON.stringify(ids);
    } catch {}
  }
  const values = jobRow(job, legacyWorkerIds);
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
  const sheetRow = index + 1;
  await clearValues(ctx.timesheetsSheetId, `${JOBS_TAB}!A${sheetRow}:M${sheetRow}`);
  const remaining = await readRows(ctx.timesheetsSheetId, JOBS_TAB);
  if (remaining.some((row, rowIndex) => rowIndex > 0 && row[0] === id)) {
    throw new Error("Google Sheets did not remove the job row. Please try again.");
  }
}

function workerRow(worker) {
  return [
    worker.id, worker.status || "Active", worker.firstName, worker.lastName,
    worker.mobile || "", worker.createdAt, worker.updatedAt, JSON.stringify(worker),
  ];
}

function workerFromRow(row) {
  if (row._data) return row._data;
  return {
    id: row["Worker ID"], status: row.Status || "Active",
    firstName: row["First Name"] || "", lastName: row["Last Name"] || "",
    mobile: row.Mobile || "", createdAt: row.Created || "", updatedAt: row.Updated || "",
  };
}

export async function listWorkers({ includeArchived = false } = {}) {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, WORKERS_TAB));
  return rows.map(workerFromRow)
    .filter((worker) => includeArchived || worker.status !== "Archived")
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
}

async function backfillLegacyTimesheetWorkerIds() {
  if (!ctx.timesheetsSheetId) return new Set();
  const [rows, jobRows, workers] = await Promise.all([
    readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB),
    readRows(ctx.timesheetsSheetId, JOBS_TAB),
    listWorkers({ includeArchived: true }),
  ]);
  const byName = new Map();
  for (const worker of workers) {
    const name = `${worker.firstName} ${worker.lastName}`.trim().toLowerCase();
    if (!name) continue;
    byName.set(name, [...(byName.get(name) || []), worker]);
  }
  const workersByJob = new Map();
  for (const row of jobRows.slice(1)) {
    let ids = [];
    try { ids = JSON.parse(row[12] || "[]"); } catch {}
    if (!ids.length) {
      try { ids = JSON.parse(row[11] || "{}").workerIds || []; } catch {}
    }
    workersByJob.set(row[0], new Set(ids));
  }
  const unresolvedJobIds = new Set();
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row[27] || !row[5]) continue;
    let candidates = byName.get(String(row[5]).trim().toLowerCase()) || [];
    if (candidates.length > 1) {
      const assigned = workersByJob.get(row[3]) || new Set();
      candidates = candidates.filter((candidate) => assigned.has(candidate.id));
    }
    const worker = candidates.length === 1 ? candidates[0] : null;
    if (!worker) {
      if (row[3]) unresolvedJobIds.add(row[3]);
      continue;
    }
    let data = null;
    try {
      const parsed = JSON.parse(row[26] || "");
      if (parsed && typeof parsed === "object" && parsed.id) data = parsed;
    } catch {}
    if (data) {
      data.workerId = worker.id;
      data.workerSnapshot = data.workerSnapshot || worker;
      await updateValues(
        ctx.timesheetsSheetId,
        `${TIMESHEETS_TAB}!AA${index + 1}:AB${index + 1}`,
        [[JSON.stringify(data), worker.id]],
      );
    } else {
      await updateValues(
        ctx.timesheetsSheetId,
        `${TIMESHEETS_TAB}!AB${index + 1}`,
        [[worker.id]],
      );
    }
  }
  return unresolvedJobIds;
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
  const values = workerRow(worker);
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
  const unresolvedLegacyJobs = await backfillLegacyTimesheetWorkerIds();
  await clearLegacyJobWorkerAssociations(unresolvedLegacyJobs);
  return worker;
}

export async function archiveWorker(id) {
  id = validateWorkerId(id);
  const workers = await listWorkers({ includeArchived: true });
  const worker = workers.find((item) => item.id === id);
  if (!worker) throw new Error("Worker could not be found.");
  return saveWorker({ ...worker, status: "Archived" });
}

function timesheetRow(sheet) {
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
  return [
    sheet.id, sheet.weekStart, sheet.weekEnd, sheet.jobId, sheet.jobName,
    sheet.workerName, ...dayCells, totalHours,
    sheet.weeklyNote || "", sheet.docLink || "", sheet.pdfLink || "",
    sheet.createdAt, sheet.updatedAt, JSON.stringify(sheet),
    sheet.workerId || "",
  ];
}

function timesheetFromRow(row) {
  if (row._data) return { ...row._data, workerId: row._data.workerId || row["Worker ID"] || "" };
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    id: row["Timesheet ID"], weekStart: row["Week Start"], weekEnd: row["Week End"],
    jobId: row["Job ID"], jobName: row["Job Name"], workerName: row.Worker || "",
    days: dayNames.map((name) => ({
      date: row[`${name} Date`] || "",
      hours: Number(row[`${name} Hours`]) || 0,
    })),
    totalHours: Number(row["Total Hours"]) || 0,
    weeklyNote: row["Weekly Note"] || "",
    docLink: row.DocLink || "", pdfLink: row.PdfLink || "",
    workerId: row["Worker ID"] || "",
    createdAt: row.Created || "", updatedAt: row.Updated || "",
  };
}

export async function listTimesheets() {
  const rows = rowsToObjects(await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB));
  return rows.map(timesheetFromRow).sort((a, b) =>
    (b.weekStart || "").localeCompare(a.weekStart || "")
    || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function deleteTimesheet(id) {
  id = validateTimesheetDeleteCommand(id).id;
  const rows = await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB);
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === id);
  if (index < 0) throw new Error("Timesheet could not be found.");
  const row = rows[index];
  await clearValues(ctx.timesheetsSheetId, `${TIMESHEETS_TAB}!A${index + 1}:AB${index + 1}`);
  for (const link of [row[22], row[23]]) {
    const fileId = fileIdFromLink(link);
    if (fileId) {
      try { await deleteDriveFile(fileId); } catch (error) {
        console.warn("Could not permanently delete a generated timesheet file", error);
      }
    }
  }
  const remaining = await readRows(ctx.timesheetsSheetId, TIMESHEETS_TAB);
  if (remaining.some((item, rowIndex) => rowIndex > 0 && item[0] === id)) {
    throw new Error("Google Sheets did not remove the timesheet. Please try again.");
  }
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
  };
  const values = timesheetRow(sheet);
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
    for (const oldLink of [existing.docLink, existing.pdfLink]) {
      const oldId = fileIdFromLink(oldLink);
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
  for (const oldLink of [sheet.docLink, sheet.pdfLink]) {
    const oldId = fileIdFromLink(oldLink);
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
}

// Build the register row (array) for a quote or invoice.
function rowFor(data, totals, docLink, pdfLink) {
  const summary = summaryOf(data);
  const dataJson = JSON.stringify(data);
  if (data.type === "quote") {
    return [
      data.number, data.dateIssued, data.client.name, data.jobSite, summary,
      totals.subtotal, totals.gst, totals.total, data.validUntil,
      data.status || "Pending", data.convertedTo || "", data.notes || "",
      docLink, pdfLink, dataJson,
    ];
  }
  return [
    data.number, data.issueDate, data.client.name, data.jobSite, summary,
    totals.subtotal, totals.gst, totals.total, data.dueDate,
    data.status || "Unpaid", data.datePaid || "", data.received || "",
    data.notes || "", data.quoteRef || "",
    docLink, pdfLink, dataJson,
  ];
}

export async function saveDocument(data) {
  data = validateDocument(data);
  await assertNumberAvailable(data);
  const totals = computeTotals(data.lineItems);
  const { doc, pdf } = await generateFiles(data);
  const result = { docLink: doc.webViewLink, pdfLink: pdf.webViewLink, number: data.number };
  await commitWithReconciliation({
    write: () => appendRow(
      ctx.sheetId,
      TAB[data.type],
      rowFor(data, totals, result.docLink, result.pdfLink),
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
  const { doc, pdf } = await generateFiles(data);

  // Preserve status/workflow columns that aren't edited on the form.
  const merged = data.type === "quote"
    ? { ...data, status: getCol("Status") || data.status, convertedTo: getCol("Converted to Inv.") }
    : { ...data, status: getCol("Status") || data.status, datePaid: getCol("Date Paid"), received: getCol("Received") };

  const row = rowFor(merged, totals, doc.webViewLink, pdf.webViewLink);
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
    const id = fileIdFromLink(getCol(col));
    if (id) { try { await trashFile(id); } catch (e) { console.warn("Could not trash old file", e); } }
  }

  return { docLink: doc.webViewLink, pdfLink: pdf.webViewLink, number: data.number };
}

// --- read the register back for list views --------------------------------
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1)
    .filter((r) => (r[0] || "").trim())
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = r[i] ?? ""));
      // Recover the full original payload if present.
      if (o.DataJSON) { try { o._data = JSON.parse(o.DataJSON); } catch {} }
      return o;
    });
}

async function allRows(tab) {
  return rowsToObjects(await readRows(ctx.sheetId, tab));
}
const isDeleted = (r) => !!(r._data && r._data.deleted);

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

// --- find the sheet row (1-based) whose column A matches a document number -
async function findRow(tab, number) {
  const rows = await readRows(ctx.sheetId, tab);
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === number) return i + 1; // +1 → sheet row number
  }
  return null;
}

// Mark a quote Accepted and record which invoice it became.
export async function markQuoteConverted(quoteNumber, invoiceNumber) {
  const command = validateConversionCommand(quoteNumber, invoiceNumber);
  const [quotes, invoices] = await Promise.all([allRows("Quotes"), allRows("Invoices")]);
  const quote = quotes.find((item) => item["Quote No."] === command.quoteNumber);
  const invoice = invoices.find((item) => item["Invoice No."] === command.invoiceNumber);
  if (!quote) throw new Error("Quote could not be found.");
  if (!invoice) throw new Error("Converted invoice could not be found.");
  validateStatusTransition("quote", quote.Status || "Pending", "Accepted");
  const row = await findRow("Quotes", command.quoteNumber);
  if (!row) throw new Error("Quote could not be found.");
  await updateValues(
    ctx.sheetId,
    `Quotes!J${row}:K${row}`,
    [["Accepted", command.invoiceNumber]],
  );
}

// Change a quote's status (Pending / Accepted / Declined).
export async function setQuoteStatus(quoteNumber, status) {
  const command = validateQuoteStatusCommand(quoteNumber, status);
  const quote = (await allRows("Quotes"))
    .find((item) => item["Quote No."] === command.number);
  if (!quote) throw new Error("Quote could not be found.");
  validateStatusTransition("quote", quote.Status || "Pending", command.status);
  const row = await findRow("Quotes", command.number);
  if (!row) throw new Error("Quote could not be found.");
  await updateValues(ctx.sheetId, `Quotes!J${row}`, [[command.status]]);
}

// Change an invoice's status; optionally record Date Paid + Received.
export async function setInvoiceStatus(invoiceNumber, status, { datePaid = "", received = "" } = {}) {
  const command = validateInvoiceStatusCommand(
    invoiceNumber,
    status,
    { datePaid, received },
  );
  const invoice = (await allRows("Invoices"))
    .find((item) => item["Invoice No."] === command.number);
  if (!invoice) throw new Error("Invoice could not be found.");
  validateStatusTransition("invoice", invoice.Status || "Unpaid", command.status);
  const row = await findRow("Invoices", command.number);
  if (!row) throw new Error("Invoice could not be found.");
  await updateValues(
    ctx.sheetId,
    `Invoices!J${row}:L${row}`,
    [[
      command.status,
      command.datePaid,
      command.status === "Paid" ? dollarsFromCents(command.receivedCents) : "",
    ]],
  );
}

// Pull the Drive file id out of a webViewLink (…/d/<ID>/…).
function fileIdFromLink(link) {
  const m = /\/d\/([-\w]+)/.exec(link || "");
  return m ? m[1] : null;
}

// Email a document's PDF from the signed-in Gmail account.
export async function emailPdf({ to, subject, body, pdfLink, pdfName }) {
  const id = fileIdFromLink(pdfLink);
  if (!id) throw new Error("No PDF is attached to this document.");
  return sendGmailWithPdf({ to, subject, body, pdfFileId: id, pdfName });
}

// Fetch a document's PDF as a Blob (for downloading to the device).
export async function fetchPdfBlob(pdfLink) {
  const id = fileIdFromLink(pdfLink);
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

  // Update the deleted flag inside DataJSON (keeps everything else intact).
  let data = {};
  try { data = JSON.parse(getCol("DataJSON") || "{}"); } catch {}
  if (deleted) { data.deleted = true; data.deletedAt = new Date().toISOString(); }
  else { delete data.deleted; delete data.deletedAt; }

  const col = columnLetter(header.indexOf("DataJSON"));
  const dataRange = `${tab}!${col}${idx + 1}`;

  const deletedFolderId = await ensureDeletedFolder();
  const [addParent, removeParent] = deleted
    ? [deletedFolderId, ctx.folderId]
    : [ctx.folderId, deletedFolderId];
  const state = deleted ? "marked deleted" : "kept deleted";
  await runDeletedStateChange({
    deleting: deleted,
    writeState: () =>
      updateValues(ctx.sheetId, dataRange, [[JSON.stringify(data)]]),
    moveFiles: async () => {
      for (const linkCol of ["DocLink", "PdfLink"]) {
        const id = fileIdFromLink(getCol(linkCol));
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
