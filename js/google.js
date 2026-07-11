// ============================================================================
//  google.js — all Google plumbing: sign-in, Drive, Sheets.
//  Higher-level features (documents.js, store.js) call into this module.
// ============================================================================
import {
  GOOGLE_CLIENT_ID, GOOGLE_SCOPES,
  DRIVE_FOLDER_NAME, REGISTER_SHEET_NAME,
} from "./config.js";

const DISCOVERY_DOCS = [
  "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  "https://sheets.googleapis.com/$discovery/rest?version=v4",
];

let tokenClient = null;
let gapiReady = false;
let accessToken = null;

// --- small helper: wait until a global (gapi / google) has loaded ----------
function waitFor(check, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (check()) return resolve();
      if (Date.now() - t0 > 10000) return reject(new Error(`${label} failed to load`));
      setTimeout(poll, 50);
    })();
  });
}

// --- init: load gapi client + create the GIS token client ------------------
export async function initGoogle() {
  if (GOOGLE_CLIENT_ID.startsWith("PASTE_")) {
    throw new Error("NO_CLIENT_ID");
  }
  await waitFor(() => window.gapi && window.google?.accounts?.oauth2, "Google scripts");

  await new Promise((resolve) => gapi.load("client", resolve));
  await gapi.client.init({ discoveryDocs: DISCOVERY_DOCS });
  gapiReady = true;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: () => {}, // set per-request in signIn()
  });
}

export function isSignedIn() {
  return !!accessToken;
}

// --- interactive sign-in (must be triggered by a user click) ---------------
export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Google not initialised"));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(resp);
      accessToken = resp.access_token;
      gapi.client.setToken({ access_token: accessToken });
      resolve(resp);
    };
    // prompt: '' → silent if already consented this session, else shows chooser
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

export function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null;
    gapi.client.setToken(null);
  }
}

// --- fetch the signed-in user's basic profile (name/email) -----------------
export async function getUserInfo() {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json(); // { name, email, picture, ... }
}

// ---------------------------------------------------------------------------
//  DRIVE
// ---------------------------------------------------------------------------

// Find a file/folder this app created, by name + optional mimeType/parent.
async function findFile(name, { mimeType, parentId } = {}) {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, "trashed = false"];
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const res = await gapi.client.drive.files.list({
    q: clauses.join(" and "),
    fields: "files(id, name)",
    spaces: "drive",
  });
  return res.result.files[0] || null;
}

// Ensure the app's working folder exists; returns its id.
export async function ensureFolder() {
  const existing = await findFile(DRIVE_FOLDER_NAME, {
    mimeType: "application/vnd.google-apps.folder",
  });
  if (existing) return existing.id;
  const res = await gapi.client.drive.files.create({
    resource: { name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  return res.result.id;
}

// Upload an HTML string, converting it to a native Google Doc in `parentId`.
// Returns { id, webViewLink }.
export async function uploadHtmlAsDoc(name, html, parentId) {
  const boundary = "-------pylon" + Math.random().toString(36).slice(2);
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.document", // convert on upload
    parents: parentId ? [parentId] : undefined,
  };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n` +
    html +
    `\r\n--${boundary}--`;

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) throw new Error("Doc upload failed: " + (await res.text()));
  return res.json();
}

// Export an existing Google Doc as PDF bytes and save the PDF into the folder.
// Returns { id, webViewLink } of the new PDF file.
export async function exportDocAsPdf(docId, pdfName, parentId) {
  const exp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/pdf`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!exp.ok) throw new Error("PDF export failed: " + (await exp.text()));
  const pdfBlob = await exp.blob();

  const boundary = "-------pylonpdf" + Math.random().toString(36).slice(2);
  const metadata = { name: pdfName, mimeType: "application/pdf", parents: parentId ? [parentId] : undefined };
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = new Blob([pre, pdfBlob, post]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error("PDF save failed: " + (await res.text()));
  return res.json();
}

// ---------------------------------------------------------------------------
//  SHEETS  (the register spreadsheet — created lazily, id cached in Drive)
// ---------------------------------------------------------------------------

// Ensure the register spreadsheet exists (with Quotes + Invoices tabs).
// Returns its spreadsheetId.
export async function ensureRegisterSheet(parentId) {
  const existing = await findFile(REGISTER_SHEET_NAME, {
    mimeType: "application/vnd.google-apps.spreadsheet",
  });
  if (existing) return existing.id;

  const create = await gapi.client.sheets.spreadsheets.create({
    resource: {
      properties: { title: REGISTER_SHEET_NAME },
      sheets: [
        { properties: { title: "Quotes" } },
        { properties: { title: "Invoices" } },
      ],
    },
    fields: "spreadsheetId",
  });
  const id = create.result.spreadsheetId;

  // Move it into the app folder (create places it at Drive root by default).
  if (parentId) {
    await gapi.client.drive.files.update({ fileId: id, addParents: parentId, fields: "id" });
  }

  // Header rows.
  const quoteHeaders = ["Quote No.", "Date Issued", "Client", "Job / Site", "Description",
    "Amount (ex GST)", "GST (10%)", "Total (inc GST)", "Valid Until", "Status",
    "Converted to Inv.", "Notes", "DocLink", "PdfLink", "DataJSON"];
  const invoiceHeaders = ["Invoice No.", "Date Issued", "Client", "Job / Site", "Description",
    "Amount (ex GST)", "GST (10%)", "Total (inc GST)", "Due Date", "Status",
    "Date Paid", "Received", "Notes", "Quote Ref", "DocLink", "PdfLink", "DataJSON"];

  await gapi.client.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: id,
    resource: {
      valueInputOption: "RAW",
      data: [
        { range: "Quotes!A1", values: [quoteHeaders] },
        { range: "Invoices!A1", values: [invoiceHeaders] },
      ],
    },
  });
  return id;
}

export async function appendRow(spreadsheetId, tab, values) {
  await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [values] },
  });
}

export async function readRows(spreadsheetId, tab) {
  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:Z10000`,
  });
  return res.result.values || [];
}

// Overwrite a specific range, e.g. updateValues(id, "Quotes!J8:K8", [["Accepted","INV-0003"]]).
export async function updateValues(spreadsheetId, range, values) {
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

// Resolve a tab's numeric sheetId (gid) from its title — needed to delete rows.
export async function getSheetId(spreadsheetId, title) {
  const res = await gapi.client.sheets.spreadsheets.get({
    spreadsheetId, fields: "sheets.properties(sheetId,title)",
  });
  const s = (res.result.sheets || []).find((x) => x.properties.title === title);
  return s ? s.properties.sheetId : null;
}

// Delete a single row (rowIndex0 = 0-based, where 0 is the header row).
export async function deleteSheetRow(spreadsheetId, sheetId, rowIndex0) {
  await gapi.client.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowIndex0, endIndex: rowIndex0 + 1 },
        },
      }],
    },
  });
}

// Move a Drive file to trash (recoverable ~30 days). Works on files the app created.
export async function trashFile(fileId) {
  await gapi.client.drive.files.update({ fileId, resource: { trashed: true } });
}

// ---------------------------------------------------------------------------
//  GMAIL  (send a document's PDF as an attachment from the signed-in account)
// ---------------------------------------------------------------------------
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Email a PDF (already in Drive) to `to`, sent from the signed-in Gmail account.
export async function sendGmailWithPdf({ to, subject, body, pdfFileId, pdfName }) {
  // 1. Pull the PDF bytes from Drive.
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${pdfFileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error("Could not read the PDF from Drive.");
  const pdfB64 = bytesToBase64(new Uint8Array(await resp.arrayBuffer()));

  // 2. Build a MIME message with the PDF as an attachment.
  const boundary = "qmail" + Math.random().toString(36).slice(2);
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfName}"`,
    `Content-Disposition: attachment; filename="${pdfName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    pdfB64,
    `--${boundary}--`,
  ].join("\r\n");

  // 3. Send via the Gmail API.
  const send = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });
  if (!send.ok) {
    const text = await send.text();
    if (send.status === 401 || (send.status === 403 && /insufficient|scope|permission/i.test(text))) {
      throw new Error("Gmail permission not granted yet — sign out and sign in again to allow sending email.");
    }
    if (send.status === 403 && /has not been used|disabled|SERVICE_DISABLED/i.test(text)) {
      throw new Error("Gmail API isn't enabled for this project yet — enable it in Google Cloud Console, then try again.");
    }
    throw new Error("Gmail send failed: " + text);
  }
  return send.json();
}

// ---------------------------------------------------------------------------
//  BUSINESS DETAILS  (a "Business Details" tab in the register spreadsheet;
//  the source of truth for the company info stamped on every document, kept
//  out of the code so nothing business-specific lives in the repo.)
// ---------------------------------------------------------------------------
export const BUSINESS_TAB = "Business Details";

// key = dot-path into the company object; example = generic hint (never real data).
export const BUSINESS_FIELDS = [
  { key: "name",             label: "Company name",       example: "e.g. ABC Constructions" },
  { key: "addressLine1",     label: "Address line 1",     example: "e.g. 12 Example Street" },
  { key: "addressLine2",     label: "Address line 2",     example: "e.g. Suburb, State, 0000" },
  { key: "phone",            label: "Phone",              example: "e.g. 0400 000 000" },
  { key: "email",            label: "Email",              example: "e.g. name@example.com" },
  { key: "licence",          label: "Builders licence",   example: "e.g. NSW 00000c · ACT 00000000" },
  { key: "abn",              label: "ABN",                example: "e.g. 00 000 000 000" },
  { key: "bank.bankName",    label: "Bank name",          example: "e.g. ANZ" },
  { key: "bank.accountName", label: "Bank account name",  example: "e.g. ABC Constructions" },
  { key: "bank.bsb",         label: "BSB",                example: "e.g. 000-000" },
  { key: "bank.account",     label: "Account number",     example: "e.g. 000 000 000" },
];

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  while (parts.length > 1) { const p = parts.shift(); o = o[p] = o[p] || {}; }
  o[parts[0]] = value;
}
function getPath(obj, path) {
  return path.split(".").reduce((o, p) => (o == null ? o : o[p]), obj);
}

// Ensure the Business Details tab exists (seeded with blank values + hints).
export async function ensureBusinessSheet(spreadsheetId) {
  const existing = await getSheetId(spreadsheetId, BUSINESS_TAB);
  if (existing != null) return;

  await gapi.client.sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title: BUSINESS_TAB } } }] },
  });
  const rows = [["Setting", "Value  (← fill these in)", "Example (ignore)"]];
  for (const f of BUSINESS_FIELDS) rows.push([f.label, "", f.example]);
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${BUSINESS_TAB}!A1`,
    valueInputOption: "RAW",
    resource: { values: rows },
  });
}

// Read the Business Details tab into a company object.
export async function readBusinessDetails(spreadsheetId) {
  const rows = await readRows(spreadsheetId, BUSINESS_TAB);
  const valueByLabel = {};
  for (const r of rows.slice(1)) valueByLabel[(r[0] || "").trim()] = (r[1] || "").trim();

  const company = { bank: {} };
  for (const f of BUSINESS_FIELDS) setPath(company, f.key, valueByLabel[f.label] || "");
  return company;
}

// Write a company object back into the Business Details tab (Value column).
export async function writeBusinessDetails(spreadsheetId, company) {
  const rows = await readRows(spreadsheetId, BUSINESS_TAB);
  const valueByLabel = {};
  for (const f of BUSINESS_FIELDS) valueByLabel[f.label] = getPath(company, f.key) ?? "";

  // Align new values to the sheet's existing row order (skip the header row).
  const colB = [];
  for (let i = 1; i < rows.length; i++) {
    const label = (rows[i][0] || "").trim();
    colB.push([label in valueByLabel ? valueByLabel[label] : (rows[i][1] || "")]);
  }
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${BUSINESS_TAB}!B2:B${rows.length}`,
    valueInputOption: "RAW",
    resource: { values: colB },
  });
}
