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
  const d = new Date(iso);
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

// --- shared building blocks (inline styles for Docs-import fidelity) --------
const INK = "#1a2230";
const BRAND = "#1f3a5f";
const SOFT = "#55606f";
const LINE = "#c9ccd2";

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function letterhead(docTitle, c) {
  return `
  <table style="width:100%; border-collapse:collapse; margin-bottom:6px;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-size:22px; font-weight:bold; color:${BRAND};">${esc(c.name)}</div>
        <div style="font-size:11px; color:${INK}; margin-top:6px;">
          ${esc(c.addressLine1)}<br/>${esc(c.addressLine2)}<br/>
          Ph. ${esc(c.phone)} &nbsp;·&nbsp; ${esc(c.email)}<br/>
          ${esc(c.licence)}
        </div>
      </td>
      <td style="vertical-align:top; text-align:right;">
        <div style="font-size:24px; font-weight:bold; letter-spacing:1px; color:${INK};">${docTitle}</div>
        <div style="font-size:11px; color:${SOFT}; margin-top:6px;">ABN</div>
        <div style="font-size:13px; color:${INK};">${esc(c.abn)}</div>
      </td>
    </tr>
  </table>
  <hr style="border:none; border-top:2px solid ${BRAND}; margin:4px 0 14px;"/>`;
}

// Two-column block: "PREPARED FOR / BILL TO"  +  details grid.
function partiesBlock(leftLabel, client, detailRows) {
  const detail = detailRows
    .map(
      ([k, v]) =>
        `<tr><td style="font-size:11px; color:${SOFT}; padding:2px 10px 2px 0;">${esc(k)}</td>
             <td style="font-size:11px; color:${INK};">${esc(v)}</td></tr>`
    )
    .join("");
  return `
  <table style="width:100%; border-collapse:collapse; margin-bottom:14px;">
    <tr>
      <td style="width:52%; vertical-align:top;">
        <div style="font-size:11px; font-weight:bold; color:${BRAND}; letter-spacing:.5px;">${leftLabel}</div>
        <div style="font-size:12px; color:${INK}; margin-top:4px; line-height:1.5;">
          <strong>${esc(client.name)}</strong><br/>
          ${client.address ? esc(client.address) + "<br/>" : ""}
          ${client.suburb ? esc(client.suburb) + "<br/>" : ""}
          ${client.attn ? "Attn: " + esc(client.attn) + "<br/>" : ""}
          ${client.phone ? "Ph: " + esc(client.phone) : ""}
        </div>
      </td>
      <td style="width:48%; vertical-align:top;">
        <table style="border-collapse:collapse;">${detail}</table>
      </td>
    </tr>
  </table>`;
}

function lineItemsTable(lineItems) {
  const th = (t, align = "left") =>
    `<th style="text-align:${align}; font-size:11px; color:#fff; background:${BRAND}; padding:7px 8px; border:1px solid ${BRAND};">${t}</th>`;
  const rows = lineItems
    .filter((it) => it.description || it.amount || it.qty)
    .map((it) => {
      const amt = lineAmount(it);
      return `<tr>
        <td style="font-size:11px; padding:6px 8px; border:1px solid ${LINE};">${esc(it.description)}</td>
        <td style="font-size:11px; padding:6px 8px; border:1px solid ${LINE}; text-align:center;">${esc(it.qty)}</td>
        <td style="font-size:11px; padding:6px 8px; border:1px solid ${LINE}; text-align:center;">${esc(it.unit)}</td>
        <td style="font-size:11px; padding:6px 8px; border:1px solid ${LINE}; text-align:right;">${it.rate ? money(it.rate) : ""}</td>
        <td style="font-size:11px; padding:6px 8px; border:1px solid ${LINE}; text-align:right;">${money(amt)}</td>
      </tr>`;
    })
    .join("");
  return `
  <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
    <tr>
      ${th("Description of Works / Materials")}
      ${th("Qty", "center")}${th("Unit", "center")}
      ${th("Rate (ex GST)", "right")}${th("Amount (ex GST)", "right")}
    </tr>
    ${rows}
  </table>`;
}

function totalsBlock(totals, totalLabel) {
  const row = (k, v, bold) =>
    `<tr>
       <td style="font-size:${bold ? 13 : 11}px; ${bold ? "font-weight:bold;" : ""} color:${bold ? BRAND : SOFT}; padding:4px 12px 4px 0; text-align:right;">${k}</td>
       <td style="font-size:${bold ? 13 : 12}px; ${bold ? "font-weight:bold;" : ""} color:${INK}; text-align:right; padding:4px 0;">${v}</td>
     </tr>`;
  return `
  <table style="margin-left:auto; border-collapse:collapse; margin-bottom:14px;">
    ${row("Subtotal (ex GST)", money(totals.subtotal))}
    ${row(`GST (${Math.round(GST_RATE * 100)}%)`, money(totals.gst))}
    ${row(totalLabel, money(totals.total), true)}
  </table>`;
}

function sectionTitle(t) {
  return `<div style="font-size:11px; font-weight:bold; color:${BRAND}; letter-spacing:.5px; margin:10px 0 4px;">${t}</div>`;
}
function para(t) {
  return `<div style="font-size:11px; color:${INK}; line-height:1.5; margin-bottom:8px;">${esc(t)}</div>`;
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
    ${sectionTitle("SCOPE OF WORKS")}${para(d.scope)}
    ${lineItemsTable(d.lineItems)}
    ${sectionTitle("INCLUSIONS / EXCLUSIONS")}
    ${para(`Includes:  ${d.includes || ""}`)}
    ${para(`Excludes:  ${d.excludes || ""}`)}
    ${para(`Deposit:  ${d.deposit || ""}`)}
    ${totalsBlock(totals, "QUOTE TOTAL (inc GST)")}
    ${sectionTitle("TERMS & CONDITIONS")}
    <ul style="font-size:10px; color:${SOFT}; line-height:1.5;">
      <li>This quotation is valid until the date shown above and is subject to site inspection and availability of materials.</li>
      <li>All prices are quoted in AUD and include GST of 10% unless stated otherwise.</li>
      <li>Variations to the agreed scope will be quoted separately and confirmed in writing before works proceed.</li>
      <li>A deposit is required to secure your booking. Progress payments apply as per the agreed payment schedule.</li>
    </ul>
    ${sectionTitle("ACCEPTANCE OF QUOTATION")}
    ${para("By signing below, I/we accept this quotation and authorise the works described above to proceed on these terms.")}
    ${signatureBlock()}
  `);
}

// ---------------------------------------------------------------------------
//  INVOICE
// ---------------------------------------------------------------------------
function buildInvoiceHtml(d, company) {
  const totals = computeTotals(d.lineItems);
  const b = company.bank || {};
  return wrap(`
    ${letterhead("TAX INVOICE", company)}
    ${partiesBlock("BILL TO", d.client, [
      ["Invoice No.", d.number],
      ["Issue Date", fmtDate(d.issueDate)],
      ["Due Date", fmtDate(d.dueDate)],
      ["Quote Ref.", d.quoteRef || "—"],
    ])}
    ${para(`JOB / SITE ADDRESS:  ${d.jobSite || ""}`)}
    ${lineItemsTable(d.lineItems)}
    ${sectionTitle("PAYMENT DETAILS")}
    ${para(`Bank: ${b.bankName}    Account Name: ${b.accountName}    BSB: ${b.bsb}    Acc: ${b.account}    Reference: ${d.number}`)}
    ${totalsBlock(totals, "TOTAL DUE (inc GST)")}
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

function signatureBlock() {
  const cell = (label) =>
    `<td style="width:33%; vertical-align:bottom; padding:26px 10px 0;">
       <div style="border-top:1px solid ${LINE}; padding-top:3px; font-size:10px; color:${SOFT};">${label}</div>
     </td>`;
  return `<table style="width:100%; border-collapse:collapse; margin-top:8px;"><tr>
    ${cell("Signature")}${cell("Name (please print)")}${cell("Date")}</tr></table>`;
}

function wrap(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
  <body style="font-family:Arial, sans-serif; color:${INK}; max-width:720px; margin:0 auto; padding:24px;">
  ${inner}
  </body></html>`;
}

// Public entry point.
export function buildDocumentHtml(data, company) {
  const c = company || EMPTY_COMPANY;
  return data.type === "invoice" ? buildInvoiceHtml(data, c) : buildQuoteHtml(data, c);
}
