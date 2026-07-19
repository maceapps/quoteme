// ============================================================================
//  google.js — all Google plumbing: sign-in, Drive, Sheets.
//  Higher-level features (documents.js, store.js) call into this module.
// ============================================================================
import {
  GOOGLE_CLIENT_ID, GOOGLE_SCOPES,
  DRIVE_FOLDER_NAME, REGISTER_SHEET_NAME,
  TIMESHEETS_SHEET_NAME,
} from "./config.js";

const DISCOVERY_DOCS = [
  "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  "https://sheets.googleapis.com/$discovery/rest?version=v4",
];

let tokenClient = null;
let gapiReady = false;
let accessToken = null;

// Keep the short-lived token only for this browser tab. sessionStorage permits
// reloads but does not expose the bearer token to other tabs or future sessions.
const TOKEN_KEY = "qm_token";
try { localStorage.removeItem(TOKEN_KEY); } catch {}
function saveToken(resp) {
  accessToken = resp.access_token;
  gapi.client.setToken({ access_token: accessToken });
  const expiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: accessToken, expiry }));
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function clearToken() {
  accessToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY); // remove tokens written by older releases
  } catch {}
  if (gapiReady) gapi.client.setToken(null);
}

// Restore a still-valid saved token (call after initGoogle). Returns true if a
// usable token was restored. Keeps a 60s safety margin before expiry.
export function restoreToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return false;
    const { access_token, expiry } = JSON.parse(raw);
    if (!access_token || Date.now() > expiry - 60000) { clearToken(); return false; }
    accessToken = access_token;
    gapi.client.setToken({ access_token: accessToken });
    return true;
  } catch { return false; }
}

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
      saveToken(resp);
      resolve(resp);
    };
    // prompt: '' → Google shows the consent screen only the first time you
    // grant access; on later loads it returns a token silently (no approval
    // screen, no "unverified app" warning). Passing "consent" here would force
    // the approval screen on every load.
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  clearToken();
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

// Find files/folders this app created, by exact name + optional type/parent.
export async function findFilesExact(name, { mimeType, parentId } = {}) {
  const clauses = [`name = '${name.replace(/'/g, "\\'")}'`, "trashed = false"];
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const res = await gapi.client.drive.files.list({
    q: clauses.join(" and "),
    fields: "files(id, name, mimeType, parents, modifiedTime, appProperties)",
    spaces: "drive",
    orderBy: "modifiedTime desc",
  });
  return res.result.files || [];
}

async function findFile(name, options = {}) {
  const files = await findFilesExact(name, options);
  if (files.length > 1) {
    throw new Error(`More than one app file named “${name}” was found. Resolve the duplicates before continuing.`);
  }
  return files[0] || null;
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

// Ensure a subfolder with `name` exists inside `parentId`; returns its id.
export async function ensureSubFolder(name, parentId) {
  const existing = await findFile(name, { mimeType: "application/vnd.google-apps.folder", parentId });
  if (existing) return existing.id;
  const res = await gapi.client.drive.files.create({
    resource: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  return res.result.id;
}

// Move a file between folders (change its parent).
export async function moveFile(fileId, addParentId, removeParentId) {
  await gapi.client.drive.files.update({
    fileId, addParents: addParentId, removeParents: removeParentId, fields: "id",
  });
}

export async function copyDriveFile(fileId, name, parentId, appProperties = {}) {
  const response = await gapi.client.drive.files.copy({
    fileId,
    fields: "id,name,mimeType,parents,modifiedTime",
    resource: {
      name,
      parents: parentId ? [parentId] : undefined,
      appProperties,
    },
  });
  return response.result;
}

export async function getDriveFileMetadata(fileId) {
  const response = await gapi.client.drive.files.get({
    fileId,
    fields: "id,name,mimeType,parents,modifiedTime,trashed",
  });
  return response.result;
}

export async function uploadJsonFile(name, value, parentId, appProperties = {}) {
  const boundary = "-------quotemejson" + Math.random().toString(36).slice(2);
  const metadata = {
    name,
    mimeType: "application/json",
    parents: parentId ? [parentId] : undefined,
    appProperties,
  };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(value) +
    `\r\n--${boundary}--`;
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!response.ok) throw new Error("Migration manifest upload failed: " + (await response.text()));
  return response.json();
}

export async function readJsonFile(fileId) {
  const blob = await fetchDriveFile(fileId);
  return JSON.parse(await blob.text());
}

async function placeCreatedFileInFolder(fileId, parentId) {
  if (!parentId) return;
  const current = await gapi.client.drive.files.get({ fileId, fields: "parents" });
  const removeParents = (current.result.parents || []).filter((id) => id !== parentId).join(",");
  await gapi.client.drive.files.update({
    fileId,
    addParents: parentId,
    removeParents: removeParents || undefined,
    fields: "id,parents",
  });
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
  await placeCreatedFileInFolder(id, parentId);

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

const TIMESHEET_TABS = {
  Jobs: [
    "Job ID", "Status", "Job Name", "Client", "Attn", "Address",
    "Suburb / State / Postcode", "Phone", "Job / Site", "Created", "Updated", "DataJSON",
    "Legacy Worker IDs (unused)",
  ],
  Workers: [
    "Worker ID", "Status", "First Name", "Last Name", "Mobile", "Created", "Updated", "DataJSON",
  ],
  Timesheets: [
    "Timesheet ID", "Week Start", "Week End", "Job ID", "Job Name", "Worker",
    "Monday Date", "Monday Hours", "Tuesday Date", "Tuesday Hours",
    "Wednesday Date", "Wednesday Hours", "Thursday Date", "Thursday Hours",
    "Friday Date", "Friday Hours", "Saturday Date", "Saturday Hours",
    "Sunday Date", "Sunday Hours", "Total Hours", "Weekly Note",
    "DocLink", "PdfLink", "Created", "Updated", "DataJSON",
    "Worker ID",
  ],
};

// Ensure the dedicated timesheet spreadsheet exists inside the Timesheets
// subfolder. Existing files are migrated by adding any missing tabs/headers.
export async function ensureTimesheetSheet(parentId) {
  let file = await findFile(TIMESHEETS_SHEET_NAME, {
    mimeType: "application/vnd.google-apps.spreadsheet",
    parentId,
  });
  let spreadsheetId;
  const created = !file;

  if (file) {
    // Existing workbooks are discovered without mutation. Any missing or
    // incompatible tabs are handled by the explicit backup-first migration.
    return file.id;
  } else {
    const create = await gapi.client.sheets.spreadsheets.create({
      resource: {
        properties: { title: TIMESHEETS_SHEET_NAME },
        sheets: Object.keys(TIMESHEET_TABS).map((title) => ({ properties: { title } })),
      },
      fields: "spreadsheetId",
    });
    spreadsheetId = create.result.spreadsheetId;
    await placeCreatedFileInFolder(spreadsheetId, parentId);
  }

  const meta = await gapi.client.sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title)",
  });
  const existingTitles = new Set((meta.result.sheets || []).map((s) => s.properties.title));
  const missing = Object.keys(TIMESHEET_TABS).filter((title) => !existingTitles.has(title));
  if (missing.length) {
    if (!created) {
      throw new Error(
        `The timesheet workbook is missing ${missing.join(", ")}. Use Data migration to repair it safely.`,
      );
    }
    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  const headerWrites = [];
  for (const [title, headers] of Object.entries(TIMESHEET_TABS)) {
    const current = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!1:1`,
    });
    const row = current.result.values?.[0] || [];
    const normalisedRow = row.map((value, index) =>
      title === "Jobs" && index === 12 && value === "Worker IDs" ? headers[index] : value);
    const isCompatiblePrefix = (created && row.length === 0)
      || headers.every((value, index) => normalisedRow[index] === value);
    if (!isCompatiblePrefix) {
      throw new Error(
        `The ${title} tab in “${TIMESHEETS_SHEET_NAME}” has incompatible columns. ` +
        "Rename or remove that app-created spreadsheet, then sign in again.",
      );
    }
    if (created && (row.length !== headers.length
      || normalisedRow.some((value, index) => value !== row[index]))) {
      headerWrites.push({ range: `${title}!A1`, values: [headers] });
    }
  }
  if (headerWrites.length) {
    await gapi.client.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: { valueInputOption: "RAW", data: headerWrites },
    });
  }

  return spreadsheetId;
}

export async function appendRow(spreadsheetId, tab, values) {
  await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [values] },
  });
}

export async function readRows(spreadsheetId, tab) {
  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:AZ`,
  });
  return res.result.values || [];
}

export async function getSpreadsheetTabs(spreadsheetId) {
  const response = await gapi.client.sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,sheetId)",
  });
  return (response.result.sheets || []).map((sheet) => sheet.properties);
}

export async function readWorkbookTabs(spreadsheetId, tabNames) {
  const entries = await Promise.all(tabNames.map(async (tab) => [
    tab,
    await readRows(spreadsheetId, tab),
  ]));
  return Object.fromEntries(entries);
}

export async function applyWorkbookSchema(spreadsheetId, schemas) {
  const existingTabs = await getSpreadsheetTabs(spreadsheetId);
  const existingTitles = new Set(existingTabs.map((tab) => tab.title));
  const missing = Object.keys(schemas).filter((title) => !existingTitles.has(title));
  if (missing.length) {
    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  for (const [title, expected] of Object.entries(schemas)) {
    const current = (await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!1:1`,
    })).result.values?.[0] || [];
    const normalized = current.map((value, index) =>
      title === "Jobs" && index === 12 && value === "Worker IDs"
        ? "Legacy Worker IDs (unused)"
        : value);
    if (!normalized.every((value, index) => value === expected[index])) {
      throw new Error(`${title} has incompatible columns; migration stopped before writing rows.`);
    }
    if (normalized.length !== expected.length
      || normalized.some((value, index) => value !== current[index])) {
      await updateValues(spreadsheetId, `${title}!A1`, [expected]);
    }
  }
}

// Overwrite a specific range, e.g. updateValues(id, "Quotes!J8:K8", [["Accepted","INV-0003"]]).
export async function updateValues(spreadsheetId, range, values) {
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    resource: { values },
  });
}

export async function clearValues(spreadsheetId, range) {
  await gapi.client.sheets.spreadsheets.values.clear({
    spreadsheetId,
    range,
    resource: {},
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

export async function deleteDriveFile(fileId) {
  await gapi.client.drive.files.delete({ fileId });
}

// Fetch a Drive file's bytes as a Blob (for downloading to the device).
export async function fetchDriveFile(fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error("Could not download the file from Drive.");
  return resp.blob();
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
// UTF-8 → base64 (for header words and text bodies containing non-ASCII).
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
// Wrap a base64 blob to 76-char lines (RFC 2045).
function wrap76(b64) {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}
// Encode a header value as an RFC 2047 encoded-word only if it has non-ASCII.
function encodeHeader(value) {
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${utf8ToBase64(value)}?=`;
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
  const pdfB64 = wrap76(bytesToBase64(new Uint8Array(await resp.arrayBuffer())));

  // 2. Build a MIME message with the PDF as an attachment. Headers are ASCII-
  //    only (non-ASCII is RFC 2047 encoded); text + PDF parts are base64 so
  //    the whole message stays 7-bit clean (avoids garbled subjects / spam).
  const boundary = "qmail" + Math.random().toString(36).slice(2);
  const mime = [
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(utf8ToBase64(body)),
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${encodeHeader(pdfName)}"`,
    `Content-Disposition: attachment; filename="${encodeHeader(pdfName)}"`,
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
