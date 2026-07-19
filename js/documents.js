// ============================================================================
//  documents.js — builds the printable HTML for a quote or invoice.
//  The HTML is (a) uploaded to Drive and converted to a Google Doc, and
//  (b) that Doc is exported to PDF. So the layout uses table-based structure
//  and inline styles, which Google Docs' HTML import reproduces reliably.
// ============================================================================
import { GST_RATE } from "./config.js";

// Fallback so a missing/blank Business Details tab renders gracefully.
const EMPTY_COMPANY = {
  name: "", addressLine1: "", addressLine2: "",
  phone: "", email: "", licence: "", abn: "",
  bank: { bankName: "", accountName: "", bsb: "", account: "" },
};

// --- formatting helpers ----------------------------------------------------
export function money(n) {
  const v = Number(n) || 0;
  return "$" + v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
    : new Date(iso);
  if (isNaN(d)) return iso;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getDate())} / ${p(d.getMonth() + 1)} / ${d.getFullYear()}`;
}

// Amount for a line = qty × rate, or an explicit amount if given.
export function lineAmount(item) {
  if (item.amount !== "" && item.amount != null) return Number(item.amount) || 0;
  const qty = Number(item.qty) || 0;
  const rate = Number(item.rate) || 0;
  return qty * rate;
}

export function computeTotals(lineItems) {
  const subtotal = lineItems.reduce((s, it) => s + lineAmount(it), 0);
  const gst = subtotal * GST_RATE;
  return { subtotal, gst, total: subtotal + gst };
}

// --- shared building blocks ------------------------------------------------
//  Google Docs' HTML importer ignores most CSS (padding, margins, max-width),
//  so layout uses the legacy table attributes it DOES honour — cellpadding,
//  bgcolor, width, align, valign — with inline styles only for text (font
//  size / colour / weight, which do survive). Tables are borderless; the
//  line-items table uses a shaded header + zebra striping instead of rules.
const INK = "#1a2230";
const BRAND = "#1f3a5f";
const SOFT = "#55606f";
const ZEBRA = "#f1f4f7";

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function letterhead(docTitle, c) {
  return `
  <table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td valign="top" style="font-size:11px; color:${INK};">
        <span style="font-size:22px; font-weight:bold; color:${BRAND};">${esc(c.name)}</span><br/>
        ${esc(c.addressLine1)}<br/>${esc(c.addressLine2)}<br/>
        Ph. ${esc(c.phone)} &nbsp;·&nbsp; ${esc(c.email)}<br/>
        ${esc(c.licence)}
      </td>
      <td valign="top" align="right">
        <span style="font-size:24px; font-weight:bold; color:${INK};">${docTitle}</span><br/>
        <span style="font-size:11px; color:${SOFT};">ABN</span><br/>
        <span style="font-size:13px; color:${INK};">${esc(c.abn)}</span>
      </td>
    </tr>
  </table>
  ${spacer()}
  <hr/>
  ${spacer()}`;
}

// Two-column block: "PREPARED FOR / BILL TO"  +  details grid.
function partiesBlock(leftLabel, client, detailRows) {
  const detail = detailRows
    .map(
      ([k, v]) =>
        `<tr><td style="font-size:11px; color:${SOFT};">${esc(k)}</td>
             <td style="font-size:11px; color:${INK};">${esc(v)}</td></tr>`
    )
    .join("");
  return `
  <table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td width="54%" valign="top">
        <span style="font-size:11px; font-weight:bold; color:${BRAND};">${leftLabel}</span><br/><br/>
        <span style="font-size:12px; color:${INK};"><b>${esc(client.name)}</b><br/>
          ${client.address ? esc(client.address) + "<br/>" : ""}
          ${client.suburb ? esc(client.suburb) + "<br/>" : ""}
          ${client.attn ? "Attn: " + esc(client.attn) + "<br/>" : ""}
          ${client.phone ? "Ph: " + esc(client.phone) : ""}</span>
      </td>
      <td width="46%" valign="top">
        <table border="0" cellspacing="0" cellpadding="3">${detail}</table>
      </td>
    </tr>
  </table>`;
}

function lineItemsTable(lineItems) {
  const cols = [
    { w: "46%", a: "left" },   // description
    { w: "8%",  a: "center" }, // qty
    { w: "10%", a: "center" }, // unit
    { w: "18%", a: "right" },  // rate
    { w: "18%", a: "right" },  // amount
  ];
  const headers = ["Description of Works / Materials", "Qty", "Unit", "Rate (ex GST)", "Amount (ex GST)"];
  const head = headers
    .map((t, i) => `<td width="${cols[i].w}" align="${cols[i].a}" bgcolor="${BRAND}" style="font-size:11px; color:#ffffff; font-weight:bold;">${t}</td>`)
    .join("");
  const rows = lineItems
    .filter((it) => it.description || it.amount || it.qty)
    .map((it, idx) => {
      const amt = lineAmount(it);
      const bg = idx % 2 === 1 ? ` bgcolor="${ZEBRA}"` : "";
      const cell = (val, i) => `<td align="${cols[i].a}"${bg} style="font-size:11px; color:${INK};">${val}</td>`;
      return `<tr>
        ${cell(esc(it.description), 0)}${cell(esc(it.qty), 1)}${cell(esc(it.unit), 2)}
        ${cell(it.rate ? money(it.rate) : "", 3)}${cell(money(amt), 4)}
      </tr>`;
    })
    .join("");
  return `
  <table width="100%" border="0" cellspacing="0" cellpadding="7">
    <tr>${head}</tr>
    ${rows}
  </table>`;
}

function totalsBlock(totals, totalLabel) {
  const row = (k, v, bold) =>
    `<tr>
       <td width="68%" align="right" nowrap style="font-size:${bold ? 13 : 11}px; color:${bold ? BRAND : SOFT};${bold ? " font-weight:bold;" : ""}">${k}</td>
       <td width="32%" align="right" nowrap style="font-size:${bold ? 13 : 12}px; color:${INK};${bold ? " font-weight:bold;" : ""}">${v}</td>
     </tr>`;
  return `
  <table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td width="40%"></td>
      <td width="60%">
        <table width="100%" border="0" cellspacing="0" cellpadding="5">
          ${row("Subtotal (ex GST)", money(totals.subtotal))}
          ${row(`GST (${Math.round(GST_RATE * 100)}%)`, money(totals.gst))}
          ${row(totalLabel, money(totals.total), true)}
        </table>
      </td>
    </tr>
  </table>`;
}

function sectionTitle(t) {
  return `<p style="font-size:11px; font-weight:bold; color:${BRAND}; margin:0;">${t}</p>`;
}
function para(t) {
  return `<p style="font-size:11px; color:${INK}; margin:0;">${esc(t)}</p>`;
}
// An empty paragraph — a reliable way to add vertical space in a Google Doc.
function spacer() {
  return `<p style="margin:0;">&nbsp;</p>`;
}
// Bank details, each on its own line, left justified.
function paymentDetails(company, reference) {
  const b = company.bank || {};
  const line = (k, v) => `<p style="font-size:11px; color:${INK}; margin:0;">${k}: ${esc(v)}</p>`;
  return (
    line("Bank", b.bankName) +
    line("Account Name", b.accountName) +
    line("BSB", b.bsb) +
    line("Account Number", b.account) +
    line("Reference", reference)
  );
}

// ---------------------------------------------------------------------------
//  QUOTE
// ---------------------------------------------------------------------------
function buildQuoteHtml(d, company) {
  const totals = computeTotals(d.lineItems);
  return wrap(`
    ${letterhead("QUOTATION", company)}
    ${partiesBlock("PREPARED FOR", d.client, [
      ["Quote No.", d.number],
      ["Date Issued", fmtDate(d.dateIssued)],
      ["Valid Until", fmtDate(d.validUntil)],
      ["Prepared By", d.preparedBy || company.name],
      ["Est. Start", d.estStart || "—"],
    ])}
    ${para(`JOB / SITE ADDRESS:  ${d.jobSite || ""}`)}
    ${spacer()}
    ${sectionTitle("SCOPE OF WORKS")}${para(d.scope)}
    ${spacer()}
    ${lineItemsTable(d.lineItems)}
    ${totalsBlock(totals, "QUOTE TOTAL (inc GST)")}
    ${spacer()}
    ${sectionTitle("INCLUSIONS / EXCLUSIONS")}
    ${para(`Includes:  ${d.includes || ""}`)}
    ${para(`Excludes:  ${d.excludes || ""}`)}
    ${para(`Deposit:  ${d.deposit || ""}`)}
    ${spacer()}
    ${sectionTitle("TERMS & CONDITIONS")}
    <ul style="font-size:10px; color:${SOFT}; line-height:1.5;">
      <li>This quotation is valid until the date shown above and is subject to site inspection and availability of materials.</li>
      <li>All prices are quoted in AUD and include GST of 10% unless stated otherwise.</li>
      <li>Variations to the agreed scope will be quoted separately and confirmed in writing before works proceed.</li>
      <li>A deposit is required to secure your booking. Progress payments apply as per the agreed payment schedule.</li>
    </ul>
    ${spacer()}
    ${sectionTitle("ACCEPTANCE OF QUOTATION")}
    ${para("By signing below, I/we accept this quotation and authorise the works described above to proceed on these terms.")}
    ${spacer()}
    ${spacer()}
    ${signatureBlock()}
  `);
}

// ---------------------------------------------------------------------------
//  INVOICE
// ---------------------------------------------------------------------------
function buildInvoiceHtml(d, company) {
  const totals = computeTotals(d.lineItems);
  return wrap(`
    ${letterhead("TAX INVOICE", company)}
    ${partiesBlock("BILL TO", d.client, [
      ["Invoice No.", d.number],
      ["Issue Date", fmtDate(d.issueDate)],
      ["Due Date", fmtDate(d.dueDate)],
      ["Quote Ref.", d.quoteRef || "—"],
    ])}
    ${para(`JOB / SITE ADDRESS:  ${d.jobSite || ""}`)}
    ${spacer()}
    ${lineItemsTable(d.lineItems)}
    ${totalsBlock(totals, "TOTAL DUE (inc GST)")}
    ${spacer()}
    ${sectionTitle("PAYMENT DETAILS")}
    ${paymentDetails(company, d.number)}
    ${spacer()}
    ${sectionTitle("PAYMENT TERMS & NOTES")}
    <ul style="font-size:10px; color:${SOFT}; line-height:1.5;">
      <li>Payment is due by the due date shown above. Please use the invoice number as the payment reference.</li>
      <li>This document is a valid tax invoice for GST purposes. Total shown includes GST of 10%.</li>
      <li>Late payments may incur interest and/or suspension of works in line with our terms of trade.</li>
      <li>Please advise us of any discrepancy within 7 days of receiving this invoice.</li>
    </ul>
    ${para("Thank you for your business.")}
  `);
}

// ---------------------------------------------------------------------------
//  TIMESHEET
// ---------------------------------------------------------------------------
function buildTimesheetBody(d, company, job) {
  const client = job.client || {};
  const rows = (d.days || []).map((day, index) => {
    const label = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index];
    const bg = index % 2 ? ` bgcolor="${ZEBRA}"` : "";
    return `<tr>
      <td${bg} style="font-size:11px; color:${INK};">${label}</td>
      <td${bg} style="font-size:11px; color:${INK};">${fmtDate(day.date)}</td>
      <td${bg} align="right" style="font-size:11px; color:${INK};">${Number(day.hours || 0).toFixed(2)}</td>
    </tr>`;
  }).join("");
  const detailLine = (label, value) => value
    ? `<tr><td width="28%" style="font-size:11px; color:${SOFT};">${label}</td>
         <td style="font-size:11px; color:${INK};">${esc(value)}</td></tr>`
    : "";
  const note = esc(d.weeklyNote || "").replace(/\n/g, "<br/>");

  return wrap(`
    ${letterhead("WEEKLY TIMESHEET", company)}
    <table width="100%" border="0" cellspacing="0" cellpadding="3">
      ${detailLine("Worker", d.workerName)}
      ${detailLine("Job", job.name || d.jobName)}
      ${detailLine("Client", client.name)}
      ${detailLine("Attn", client.attn)}
      ${detailLine("Phone", client.phone)}
      ${detailLine("Job / site", job.jobSite)}
      ${detailLine("Week", `${fmtDate(d.weekStart)} to ${fmtDate(d.weekEnd)}`)}
    </table>
    ${spacer()}
    <table width="100%" border="0" cellspacing="0" cellpadding="8">
      <tr>
        <td width="42%" bgcolor="${BRAND}" style="font-size:11px; color:#fff; font-weight:bold;">Day</td>
        <td width="38%" bgcolor="${BRAND}" style="font-size:11px; color:#fff; font-weight:bold;">Date</td>
        <td width="20%" align="right" bgcolor="${BRAND}" style="font-size:11px; color:#fff; font-weight:bold;">Hours</td>
      </tr>
      ${rows}
      <tr>
        <td colspan="2" align="right" style="font-size:13px; color:${BRAND}; font-weight:bold;">TOTAL HOURS</td>
        <td align="right" style="font-size:13px; color:${INK}; font-weight:bold;">${Number(d.totalHours || 0).toFixed(2)}</td>
      </tr>
    </table>
    ${spacer()}
    ${sectionTitle("WEEKLY NOTE")}
    <p style="font-size:11px; color:${INK}; margin:0;">${note || "—"}</p>
    ${spacer()}
    ${spacer()}
    ${sectionTitle("APPROVAL")}
    ${spacer()}
    <table width="100%" border="0" cellspacing="0" cellpadding="6">
      <tr>
        <td width="50%" style="font-size:11px; color:${INK};">Worker signature: __________________________</td>
        <td width="50%" style="font-size:11px; color:${INK};">Date: __________________</td>
      </tr>
      <tr>
        <td width="50%" style="font-size:11px; color:${INK};">Client signature: ___________________________</td>
        <td width="50%" style="font-size:11px; color:${INK};">Date: __________________</td>
      </tr>
    </table>
  `);
}

function signatureBlock() {
  const cell = (label, line) =>
    `<td width="33%" valign="bottom" nowrap style="font-size:11px; color:${INK};">${label}: ${line}</td>`;
  return `
  <table width="100%" border="0" cellspacing="0" cellpadding="6">
    <tr>
      ${cell("Signature", "____________________")}
      ${cell("Name", "__________________")}
      ${cell("Date", "____________")}
    </tr>
  </table>`;
}

function wrap(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
  <body style="font-family:Arial, sans-serif; color:${INK};">
  ${inner}
  </body></html>`;
}

// Public entry point.
export function buildDocumentHtml(data, company) {
  const c = company || EMPTY_COMPANY;
  return data.type === "invoice" ? buildInvoiceHtml(data, c) : buildQuoteHtml(data, c);
}

export function buildTimesheetHtml(data, company, job) {
  return buildTimesheetBody(data, company || EMPTY_COMPANY, job || {});
}
