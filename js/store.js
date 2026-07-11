// ============================================================================
//  store.js — the data layer.
//  Turns form data into: a saved Google Doc + PDF in Drive, and a row in the
//  register Sheet. Also reads the register back for the list views, and works
//  out the next document number.
// ============================================================================
import {
  QUOTE_PREFIX, INVOICE_PREFIX, NUMBER_PAD,
} from "./config.js";
import {
  ensureFolder, ensureRegisterSheet,
  uploadHtmlAsDoc, exportDocAsPdf,
  appendRow, readRows, updateValues,
  getSheetId, deleteSheetRow, trashFile,
  ensureBusinessSheet, readBusinessDetails, writeBusinessDetails, BUSINESS_TAB,
} from "./google.js";
import { buildDocumentHtml, computeTotals } from "./documents.js";

let ctx = { folderId: null, sheetId: null, company: null };

// Called once after sign-in so store.js knows where things live and who we are.
export async function initStore() {
  ctx.folderId = await ensureFolder();
  ctx.sheetId = await ensureRegisterSheet(ctx.folderId);
  await ensureBusinessSheet(ctx.sheetId);
  ctx.company = await readBusinessDetails(ctx.sheetId);
  return ctx;
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
  await writeBusinessDetails(ctx.sheetId, company);
  ctx.company = await readBusinessDetails(ctx.sheetId);
  return ctx.company;
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
  const doc = await uploadHtmlAsDoc(baseName, html, ctx.folderId);
  const pdf = await exportDocAsPdf(doc.id, baseName + ".pdf", ctx.folderId);
  return { doc, pdf };
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
  const totals = computeTotals(data.lineItems);
  const { doc, pdf } = await generateFiles(data);
  await appendRow(ctx.sheetId, TAB[data.type], rowFor(data, totals, doc.webViewLink, pdf.webViewLink));
  return { docLink: doc.webViewLink, pdfLink: pdf.webViewLink, number: data.number };
}

// --- edit an existing quote/invoice ---------------------------------------
//  Keeps the same number and sheet row. Regenerates the Doc + PDF (old ones
//  go to trash) and preserves status fields that live on the row, not the form.
export async function updateDocument(data) {
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

  // Trash the previous Doc + PDF.
  for (const col of ["DocLink", "PdfLink"]) {
    const id = fileIdFromLink(getCol(col));
    if (id) { try { await trashFile(id); } catch (e) { console.warn("Could not trash old file", e); } }
  }

  // Preserve status/workflow columns that aren't edited on the form.
  const merged = data.type === "quote"
    ? { ...data, status: getCol("Status") || data.status, convertedTo: getCol("Converted to Inv.") }
    : { ...data, status: getCol("Status") || data.status, datePaid: getCol("Date Paid"), received: getCol("Received") };

  const row = rowFor(merged, totals, doc.webViewLink, pdf.webViewLink);
  const lastCol = String.fromCharCode(64 + row.length); // 15→O (quote), 17→Q (invoice)
  const sheetRow = idx + 1;
  await updateValues(ctx.sheetId, `${tab}!A${sheetRow}:${lastCol}${sheetRow}`, [row]);

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

export async function listQuotes() {
  return rowsToObjects(await readRows(ctx.sheetId, "Quotes"));
}
export async function listInvoices() {
  return rowsToObjects(await readRows(ctx.sheetId, "Invoices"));
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
  const row = await findRow("Quotes", quoteNumber);
  if (row) await updateValues(ctx.sheetId, `Quotes!J${row}:K${row}`, [["Accepted", invoiceNumber]]);
}

// Change a quote's status (Pending / Accepted / Declined).
export async function setQuoteStatus(quoteNumber, status) {
  const row = await findRow("Quotes", quoteNumber);
  if (row) await updateValues(ctx.sheetId, `Quotes!J${row}`, [[status]]);
}

// Change an invoice's status; optionally record Date Paid + Received.
export async function setInvoiceStatus(invoiceNumber, status, { datePaid = "", received = "" } = {}) {
  const row = await findRow("Invoices", invoiceNumber);
  if (!row) return;
  await updateValues(ctx.sheetId, `Invoices!J${row}:L${row}`, [[status, datePaid, received]]);
}

// Pull the Drive file id out of a webViewLink (…/d/<ID>/…).
function fileIdFromLink(link) {
  const m = /\/d\/([-\w]+)/.exec(link || "");
  return m ? m[1] : null;
}

// Delete a quote/invoice: trash its Doc + PDF and remove its register row.
export async function deleteDocument(type, number) {
  const tab = TAB[type];
  const rows = await readRows(ctx.sheetId, tab);
  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === number) { idx = i; break; }
  }
  if (idx < 0) return;

  const header = rows[0];
  const row = rows[idx];
  const docLink = row[header.indexOf("DocLink")];
  const pdfLink = row[header.indexOf("PdfLink")];
  for (const link of [docLink, pdfLink]) {
    const id = fileIdFromLink(link);
    if (id) { try { await trashFile(id); } catch (e) { console.warn("Could not trash file", e); } }
  }

  const sheetId = await getSheetId(ctx.sheetId, tab);
  await deleteSheetRow(ctx.sheetId, sheetId, idx); // array index idx == 0-based sheet row
}

export function context() { return ctx; }
