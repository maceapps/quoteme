// ============================================================================
//  app.js — bootstrap, sign-in, view switching, and the register views.
// ============================================================================
import { GOOGLE_CLIENT_ID } from "./config.js";
import { initGoogle, signIn, signOut, getUserInfo, restoreToken, BUSINESS_FIELDS } from "./google.js";
import {
  initStore, listQuotes, listInvoices,
  listJobs,
  markQuoteConverted, setQuoteStatus, setInvoiceStatus, deleteDocument,
  getCompany, businessDetailsComplete, businessSheetUrl, refreshCompany, saveBusinessDetails,
  emailPdf, fetchPdfBlob, listDeleted, restoreDocument,
} from "./store.js";
import { renderForm } from "./forms.js";
import { money } from "./documents.js";
import { withLoading } from "./ui.js";
import { renderJobs } from "./jobs.js";
import { renderAllTimesheets } from "./timesheets.js";
import { renderWorkers } from "./workers.js";
import { escapeAttr as escA, escapeHtml as escH, safeGoogleUrl } from "./security.js";
import { confirmNavigation, discardAllFormGuards, guardForm } from "./navigation.js";
import { beginRender } from "./rendering.js";
import { todayISO } from "./domain/local-date.js";
import { centsFromDollars, formatCents } from "./domain/money.js";
import { INVOICE_STATUSES, QUOTE_STATUSES } from "./domain/documents.js";

const el = (id) => document.getElementById(id);
const state = { user: null, highlight: null };
let viewRequest = 0;

// --- view switching --------------------------------------------------------
function canLeaveCurrentView() {
  if (!confirmNavigation()) return false;
  discardAllFormGuards();
  return true;
}

async function show(view) {
  if (!canLeaveCurrentView()) return false;
  const request = ++viewRequest;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  const container = el(`view-${view}`);
  if (!container) return false;
  container.hidden = false;
  const activeTab = view;
  document.querySelectorAll("#tabs button").forEach((button) => {
    const active = button.dataset.view === activeTab;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const renderer = {
    dashboard: renderDashboard,
    quotes: renderQuotes,
    invoices: renderInvoices,
    jobs: () => renderJobs(el("view-jobs")),
    workers: () => renderWorkers(el("view-workers")),
    timesheets: () => renderAllTimesheets(el("view-timesheets")),
    business: () => renderBusiness(false),
    deleted: renderDeleted,
  }[view];
  if (!renderer) return true;
  try {
    await renderer();
    return true;
  } catch (error) {
    console.error(`Could not render ${view}`, error);
    if (request === viewRequest) renderViewError(container, view, error);
    return false;
  }
}

function renderViewError(container, view, error) {
  container.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "empty-state";
  const heading = document.createElement("h3");
  heading.textContent = "This page could not be loaded";
  const detail = document.createElement("p");
  detail.textContent = error?.message || "An unexpected Google API error occurred.";
  const retry = document.createElement("button");
  retry.className = "btn btn-primary";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => show(view));
  panel.append(heading, detail, retry);
  container.appendChild(panel);
}

function setSignedInUI(signedIn) {
  el("tabs").hidden = !signedIn;
  el("signin-btn").hidden = signedIn;
  el("signout-btn").hidden = !signedIn;
  el("settings-menu").hidden = !signedIn;
  el("user-label").textContent = signedIn && state.user ? state.user.email : "";
}

// --- sign-in ---------------------------------------------------------------
// Shared path once we hold a valid token (from a click or a restored session).
async function enterApp() {
  await withLoading("Signing in…", async () => {
    state.user = await getUserInfo();
    setSignedInUI(true);
    el("view-dashboard").innerHTML = "";
    await initStore();
    applyBranding();
    await show("dashboard");
  });
}

async function handleSignIn() {
  try {
    await signIn();
    await enterApp();
  } catch (err) {
    console.error(err);
    alert("Sign-in failed: " + (err.message || err.error || "unknown error"));
  }
}

// On load, silently resume if a saved token is still valid — no click needed.
async function tryAutoSignIn() {
  if (!restoreToken()) return false;
  try {
    await enterApp();
    return true;
  } catch (e) {
    console.warn("Saved session no longer valid, showing sign-in.", e);
    signOut();
    setSignedInUI(false);
    return false;
  }
}

// --- dashboard -------------------------------------------------------------
async function renderDashboard() {
  const c = el("view-dashboard");
  const isCurrent = beginRender(c);
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const [quotes, invoices, jobs] = await Promise.all([
    listQuotes(),
    listInvoices(),
    listJobs({ includeArchived: true }),
  ]);
  if (!isCurrent()) return;
  const activeJobs = jobs.filter((job) => (job.status || "Active") === "Active");
  const completedJobs = jobs.filter((job) => job.status === "Complete");

  const invoicedCents = invoices.reduce((sum, invoice) =>
    sum + centsFromDollars(invoice["Total (inc GST)"]), 0);
  const receivedCents = invoices.reduce((sum, invoice) =>
    sum + centsFromDollars(invoice.Received), 0);
  const outstandingCents = invoicedCents - receivedCents;

  c.innerHTML = `
    ${businessDetailsComplete() ? "" : setupBanner()}
    <div class="page-head">
      <h2>Dashboard</h2>
      <div class="head-actions">
        <button class="btn btn-primary" data-new="quote">+ New quote</button>
        <button class="btn btn-primary" data-new="invoice">+ New invoice</button>
      </div>
    </div>
    <div class="cards">
      ${statCard("Total jobs", jobs.length)}
      ${statCard("Active jobs", activeJobs.length)}
      ${statCard("Completed jobs", completedJobs.length)}
      ${statCard("Total invoiced", formatCents(invoicedCents))}
      ${statCard("Received", formatCents(receivedCents))}
      ${statCard("Outstanding", formatCents(outstandingCents), outstandingCents > 0 ? "bad" : "ok")}
    </div>
    <h3>Recent activity</h3>
    ${recentList(quotes, invoices)}
  `;
  c.querySelectorAll("[data-new]").forEach((b) =>
    b.addEventListener("click", () => openForm(b.dataset.new))
  );
  c.querySelectorAll("[data-goto]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      gotoRecord(a.dataset.goto, a.dataset.number);
    })
  );
  const bannerBtn = document.getElementById("banner-edit");
  if (bannerBtn) bannerBtn.addEventListener("click", () => show("business"));
}

// Set the top-bar name from the loaded company details.
function applyBranding() {
  const co = getCompany();
  const nameEl = el("brand-name");
  if (nameEl && co?.name) nameEl.textContent = co.name;
}

function setupBanner() {
  return `<div class="banner">
    <div>
      <strong>Finish setup:</strong> your business details (name, address, licence, ABN, bank)
      aren't filled in yet. Add them so they appear on your quotes and invoices.
    </div>
    <div class="banner-actions">
      <button class="btn btn-primary small" id="banner-edit">Set up business details</button>
    </div>
  </div>`;
}

function statCard(label, value, tone = "") {
  return `<div class="card stat ${escA(tone)}"><div class="stat-val">${escH(value)}</div><div class="stat-lbl">${escH(label)}</div></div>`;
}

function recentList(quotes, invoices) {
  const rows = [
    ...quotes.map((q) => ({ n: q["Quote No."], d: q["Date Issued"], who: q.Client, t: q["Total (inc GST)"], s: q.Status, kind: "Quote" })),
    ...invoices.map((i) => ({ n: i["Invoice No."], d: i["Date Issued"], who: i.Client, t: i["Total (inc GST)"], s: i.Status, kind: "Invoice" })),
  ].reverse().slice(0, 8);
  if (!rows.length) return `<p class="muted">Nothing yet — create your first quote or invoice above.</p>`;
  return `<table class="list"><tbody>${rows.map((r) => `
    <tr><td>${escH(r.kind)}</td>
        <td><a href="#" class="link-num" data-goto="${escA(r.kind.toLowerCase())}" data-number="${escA(r.n)}">${escH(r.n)}</a></td>
        <td>${escH(r.who)}</td>
        <td class="num">${money(r.t)}</td><td>${statusPill(r.s)}</td></tr>`).join("")}
  </tbody></table>`;
}

// Navigate to a record in its register tab and highlight it.
function gotoRecord(kind, number) {
  state.highlight = number;
  show(kind === "invoice" ? "invoices" : "quotes");
}

// After a register view renders, flash + scroll to any pending target row.
function applyHighlight(container) {
  if (!state.highlight) return;
  const tr = [...container.querySelectorAll("tr[data-num]")]
    .find((row) => row.dataset.num === state.highlight);
  state.highlight = null;
  if (tr) {
    tr.classList.add("row-flash");
    tr.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => tr.classList.remove("row-flash"), 2000);
  }
}

// --- quotes view -----------------------------------------------------------
async function renderQuotes() {
  const c = el("view-quotes");
  const isCurrent = beginRender(c);
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const quotes = await listQuotes();
  if (!isCurrent()) return;
  c.innerHTML = `
    <div class="page-head">
      <h2>Quotes</h2>
      <div class="head-actions"><button class="btn btn-primary" id="new-quote">+ New quote</button></div>
    </div>
    ${quotes.length ? `
    <table class="list">
      <thead><tr><th>No.</th><th>Date</th><th>Client</th><th>Job / site</th>
        <th class="num">Total</th><th>Valid until</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${quotes.map(quoteRow).join("")}</tbody>
    </table>` : `<p class="muted">No quotes yet.</p>`}
  `;
  el("new-quote").addEventListener("click", () => openForm("quote"));
  c.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const q = quotes.find((x) => x["Quote No."] === b.dataset.edit);
      openForm("quote", { prefill: q?._data || {}, editMode: true });
    })
  );
  c.querySelectorAll("[data-convert]").forEach((b) =>
    b.addEventListener("click", () => convertQuote(b.dataset.convert, quotes))
  );
  c.querySelectorAll("[data-qstatus]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      try {
        await withLoading("Updating…", async () => {
        await setQuoteStatus(sel.dataset.qstatus, sel.value);
        await renderQuotes();
        });
      } catch (error) {
        console.error(error);
        alert("Status update failed: " + (error.message || "unknown error"));
        await renderQuotes().catch((renderError) =>
          renderViewError(c, "quotes", renderError));
      }
    })
  );
  wireDelete(c, "quote", renderQuotes);
  c.querySelectorAll("[data-download]").forEach((b) =>
    b.addEventListener("click", () => downloadPdfFlow("quote", b.dataset.download, quotes))
  );
  c.querySelectorAll("[data-email]").forEach((b) =>
    b.addEventListener("click", () => emailPdfFlow("quote", b.dataset.email, quotes))
  );
  wireMenuClose(c);
  applyHighlight(c);
}

function quoteRow(q) {
  const no = q["Quote No."];
  const converted = q["Converted to Inv."];
  return `<tr data-num="${escA(no)}">
    <td><strong>${escH(no)}</strong></td>
    <td>${escH(q["Date Issued"])}</td>
    <td>${escH(q.Client)}</td>
    <td>${escH(q["Job / Site"])}</td>
    <td class="num">${money(q["Total (inc GST)"])}</td>
    <td>${escH(q["Valid Until"])}</td>
    <td>${converted ? statusPill("Accepted") : statusSelect(no, q.Status, QUOTE_STATUSES, "qstatus")}</td>
    <td class="row-actions">${actionsMenu(q, "quote")}</td>
  </tr>`;
}

// --- invoices view ---------------------------------------------------------
async function renderInvoices() {
  const c = el("view-invoices");
  const isCurrent = beginRender(c);
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const invoices = await listInvoices();
  if (!isCurrent()) return;
  c.innerHTML = `
    <div class="page-head">
      <h2>Invoices</h2>
      <div class="head-actions"><button class="btn btn-primary" id="new-invoice">+ New invoice</button></div>
    </div>
    ${invoices.length ? `
    <table class="list">
      <thead><tr><th>No.</th><th>Date</th><th>Client</th><th>Job / site</th>
        <th class="num">Total</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${invoices.map(invoiceRow).join("")}</tbody>
    </table>` : `<p class="muted">No invoices yet.</p>`}
  `;
  el("new-invoice").addEventListener("click", () => openForm("invoice"));
  c.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const inv = invoices.find((x) => x["Invoice No."] === b.dataset.edit);
      openForm("invoice", { prefill: inv?._data || {}, editMode: true });
    })
  );
  wireDelete(c, "invoice", renderInvoices);
  c.querySelectorAll("[data-istatus]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      try {
        await withLoading("Updating…", async () => {
        const no = sel.dataset.istatus;
        const paid = sel.value === "Paid";
        await setInvoiceStatus(no, sel.value, paid
          ? { datePaid: todayISO(), received: sel.dataset.total }
          : {});
        await renderInvoices();
        });
      } catch (error) {
        console.error(error);
        alert("Status update failed: " + (error.message || "unknown error"));
        await renderInvoices().catch((renderError) =>
          renderViewError(c, "invoices", renderError));
      }
    })
  );
  c.querySelectorAll("[data-download]").forEach((b) =>
    b.addEventListener("click", () => downloadPdfFlow("invoice", b.dataset.download, invoices))
  );
  c.querySelectorAll("[data-email]").forEach((b) =>
    b.addEventListener("click", () => emailPdfFlow("invoice", b.dataset.email, invoices))
  );
  wireMenuClose(c);
  applyHighlight(c);
}

function invoiceRow(i) {
  const no = i["Invoice No."];
  return `<tr data-num="${escA(no)}">
    <td><strong>${escH(no)}</strong></td>
    <td>${escH(i["Date Issued"])}</td>
    <td>${escH(i.Client)}</td>
    <td>${escH(i["Job / Site"])}</td>
    <td class="num">${money(i["Total (inc GST)"])}</td>
    <td>${escH(i["Due Date"])}</td>
    <td>${statusSelect(no, i.Status, INVOICE_STATUSES, "istatus", i["Total (inc GST)"])}</td>
    <td class="row-actions">${actionsMenu(i, "invoice")}</td>
  </tr>`;
}

// Wire the Delete buttons in a register view.
function wireDelete(container, type, rerender) {
  container.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const no = b.dataset.del;
      if (!confirm(`Delete ${no}?\n\nIt will be hidden from the register and its Doc + PDF moved to the "Deleted" folder in Drive. You can restore it any time from Settings → Deleted documents.`)) return;
      b.disabled = true; b.textContent = "Deleting…";
      try {
        await withLoading("Deleting…", async () => {
          await deleteDocument(type, no);
          await rerender();
        });
      } catch (err) {
        console.error(err);
        alert("Delete failed: " + (err.message || "unknown error"));
        try {
          await rerender();
        } catch (renderError) {
          console.error(renderError);
          b.disabled = false; b.textContent = "Delete";
        }
      }
    })
  );
}

// --- shared UI bits --------------------------------------------------------
// Per-row actions dropdown (native <details>). Items keep the same data-*
// attributes the existing handlers already listen for.
function actionsMenu(rec, type) {
  const no = type === "invoice" ? rec["Invoice No."] : rec["Quote No."];
  const items = [];
  const docLink = safeGoogleUrl(rec.DocLink);
  const pdfLink = safeGoogleUrl(rec.PdfLink);
  if (docLink) items.push(`<a href="${escA(docLink)}" target="_blank" rel="noopener noreferrer">Open Doc</a>`);
  if (pdfLink) items.push(`<a href="${escA(pdfLink)}" target="_blank" rel="noopener noreferrer">Open PDF</a>`);
  if (pdfLink) items.push(`<button data-download="${escA(no)}">Download PDF</button>`);
  if (pdfLink) items.push(`<button data-email="${escA(no)}">Email PDF…</button>`);
  items.push(`<button data-edit="${escA(no)}">Edit</button>`);
  if (type === "quote") {
    const converted = rec["Converted to Inv."];
    items.push(converted
      ? `<span class="menu-note">Converted → ${escH(converted)}</span>`
      : `<button data-convert="${escA(no)}">Convert to invoice</button>`);
  }
  items.push(`<button class="danger" data-del="${escA(no)}">Delete</button>`);
  return `<details class="actions-menu">
    <summary class="btn btn-ghost small">Actions ▾</summary>
    <div class="menu">${items.join("")}</div>
  </details>`;
}

// Close a row's dropdown after any item inside it is clicked.
function wireMenuClose(container) {
  container.querySelectorAll(".actions-menu .menu").forEach((menu) =>
    menu.addEventListener("click", () => {
      const d = menu.closest("details");
      if (d) d.open = false;
    })
  );
}
function statusPill(s) {
  const tone = { Paid: "ok", Accepted: "ok", Received: "ok",
                 Overdue: "bad", Declined: "bad",
                 Pending: "warn", Unpaid: "warn" }[s] || "";
  return `<span class="pill ${escA(tone)}">${escH(s || "—")}</span>`;
}
function statusSelect(no, current, options, dataAttr, total = "") {
  return `<select class="status-select" data-${dataAttr}="${escA(no)}" data-total="${escA(total)}">
    ${options.map((o) => `<option ${o === current ? "selected" : ""}>${escH(o)}</option>`).join("")}
  </select>`;
}

// --- form flow -------------------------------------------------------------
function openForm(type, { prefill = null, editMode = false, afterSave = null } = {}) {
  const view = type === "invoice" ? "invoices" : "quotes";
  const c = el(`view-${view}`);
  beginRender(c); // invalidate any register request still loading for this view
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  c.hidden = false;
  renderForm(type, c, {
    prefill, editMode,
    onSaved: async (res) => {
      if (res && afterSave) await afterSave(res);
      show(view);
    },
  });
}

async function convertQuote(quoteNumber, quotes) {
  const q = quotes.find((x) => x["Quote No."] === quoteNumber);
  const src = q?._data || {};
  const prefill = {
    jobId: src.jobId, client: src.client, jobSite: src.jobSite,
    lineItems: src.lineItems, quoteRef: quoteNumber,
    summary: src.summary,
  };
  openForm("invoice", {
    prefill,
    afterSave: (res) => withLoading("Linking to quote…", () => markQuoteConverted(quoteNumber, res.number)),
  });
}

// --- download a PDF --------------------------------------------------------
async function downloadPdfFlow(type, number, records) {
  const key = type === "invoice" ? "Invoice No." : "Quote No.";
  const rec = records.find((r) => r[key] === number);
  if (!rec || !rec.PdfLink) { alert("No PDF found for this document."); return; }
  try {
    const blob = await withLoading("Preparing PDF…", () => fetchPdfBlob(rec.PdfLink));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${number}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error(err);
    alert("Download failed: " + (err.message || "unknown error"));
  }
}

// --- email a PDF -----------------------------------------------------------
function emailPdfFlow(type, number, records) {
  const key = type === "invoice" ? "Invoice No." : "Quote No.";
  const rec = records.find((r) => r[key] === number);
  if (!rec || !rec.PdfLink) { alert("No PDF found for this document."); return; }

  const co = getCompany() || {};
  const kindTitle = type === "invoice" ? "Tax Invoice" : "Quotation";
  const subject = `${co.name ? co.name + " - " : ""}${kindTitle} ${number}`;
  const body =
    `Hi,\n\nPlease find attached ${kindTitle.toLowerCase()} ${number}` +
    `${rec.Client ? " for " + rec.Client : ""}.\n\nKind regards,\n${co.name || ""}`;
  const pdfName = `${number}.pdf`;

  openEmailModal({
    number,
    defaultSubject: subject,
    defaultBody: body,
    onSend: ({ to, subject, body }) => emailPdf({ to, subject, body, pdfLink: rec.PdfLink, pdfName }),
  });
}

function openEmailModal({ number, defaultSubject, defaultBody, onSend }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>Email PDF — ${escH(number)}</h3>
      <label class="f"><span>To</span>
        <input type="email" id="em-to" placeholder="client@example.com" autocomplete="off"/></label>
      <label class="f"><span>Subject</span><input id="em-subject" value="${escA(defaultSubject)}"/></label>
      <label class="f"><span>Message</span><textarea id="em-body" rows="6">${escH(defaultBody)}</textarea></label>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="em-cancel">Cancel</button>
        <button class="btn btn-primary" id="em-send">Send from Gmail</button>
      </div>
      <div class="save-status" id="em-status"></div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (id) => overlay.querySelector(id);
  const formGuard = guardForm(overlay.querySelector(".modal"), {
    message: "Discard this unsent email?",
    onDiscard: () => overlay.remove(),
  });
  const forceClose = () => {
    formGuard.dispose();
    overlay.remove();
  };
  const close = () => formGuard.leave(() => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  $("#em-cancel").addEventListener("click", close);
  $("#em-to").focus();

  $("#em-send").addEventListener("click", async () => {
    const to = $("#em-to").value.trim();
    const status = $("#em-status");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { status.textContent = "Please enter a valid email address."; return; }
    const btn = $("#em-send");
    btn.disabled = true;
    status.textContent = "Sending from your Gmail…";
    try {
      await withLoading("Sending email…", () =>
        onSend({ to, subject: $("#em-subject").value.trim(), body: $("#em-body").value }));
      status.textContent = "✅ Sent!";
      formGuard.markClean();
      setTimeout(forceClose, 1000);
    } catch (err) {
      console.error(err);
      status.textContent = "⚠️ " + (err.message || "Send failed");
      btn.disabled = false;
    }
  });
}

// --- business details page -------------------------------------------------
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, p, v) {
  const parts = p.split("."); let cur = o;
  while (parts.length > 1) { const k = parts.shift(); cur = cur[k] = cur[k] || {}; }
  cur[parts[0]] = v;
}
async function renderBusiness(editing = false) {
  const c = el("view-business");
  const isCurrent = beginRender(c);
  if (!editing) {
    c.innerHTML = `<p class="muted">Loading…</p>`;
    try { await refreshCompany(); } catch (e) { console.error(e); }
    if (!isCurrent()) return;
    applyBranding();
  }
  const co = getCompany() || {};

  if (editing) return renderBusinessEdit(c, co);

  const sheetUrl = safeGoogleUrl(await businessSheetUrl());
  if (!isCurrent()) return;
  c.innerHTML = `
    <div class="page-head">
      <h2>Business details</h2>
      <div class="head-actions"><button class="btn btn-primary" id="biz-edit">Edit</button></div>
    </div>
    <p class="muted">These appear on every quote and invoice.
      ${sheetUrl ? `<a href="${escA(sheetUrl)}" target="_blank" rel="noopener noreferrer">Open the source sheet</a>.` : ""}</p>
    <div class="detail-list">
      ${BUSINESS_FIELDS.map((f) => {
        const v = getPath(co, f.key);
        return `<div class="detail-row">
          <div class="detail-label">${f.label}</div>
          <div class="detail-value">${v ? escH(v) : '<span class="muted">— not set —</span>'}</div>
        </div>`;
      }).join("")}
    </div>`;
  el("biz-edit").addEventListener("click", () =>
    renderBusiness(true).catch((error) => renderViewError(c, "business", error)));
}

function renderBusinessEdit(c, co) {
  c.innerHTML = `
    <div class="page-head"><h2>Edit business details</h2></div>
    <form id="biz-form" class="doc-form detail-form">
      <fieldset><legend>Business details</legend>
        <div class="grid">
          ${BUSINESS_FIELDS.map((f) => `
            <label class="f"><span>${f.label}</span>
              <input name="${f.key}" value="${escA(getPath(co, f.key))}" placeholder="${escA(f.example)}"/>
            </label>`).join("")}
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="biz-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="biz-save">Save</button>
      </div>
      <div class="save-status" id="biz-status"></div>
    </form>`;

  const form = el("biz-form");
  const formGuard = guardForm(form, {
    message: "Discard the unsaved business detail changes?",
  });
  el("biz-cancel").addEventListener("click", () =>
    formGuard.leave(() => renderBusiness(false).catch((error) =>
      renderViewError(c, "business", error))));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el("biz-save");
    const status = el("biz-status");
    btn.disabled = true;
    status.textContent = "Saving to your Business Details sheet…";
    const company = { bank: {} };
    for (const f of BUSINESS_FIELDS) setPath(company, f.key, e.target.elements[f.key].value.trim());
    try {
      await withLoading("Saving…", () => saveBusinessDetails(company));
      formGuard.markClean();
      formGuard.dispose();
      applyBranding();
      await renderBusiness(false);
    } catch (err) {
      console.error(err);
      status.textContent = "⚠️ " + (err.message || "Save failed");
      btn.disabled = false;
    }
  });
}

// --- deleted documents page ------------------------------------------------
async function renderDeleted() {
  const c = el("view-deleted");
  const isCurrent = beginRender(c);
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const items = await listDeleted();
  if (!isCurrent()) return;
  c.innerHTML = `
    <div class="page-head"><h2>Deleted documents</h2></div>
    <p class="muted">Hidden from your registers; their files live in the "Deleted" folder in Drive.
      Open one to review it, or restore it to bring it back.</p>
    ${items.length ? `
    <table class="list">
      <thead><tr><th>Type</th><th>No.</th><th>Client</th><th>Job / site</th>
        <th class="num">Total</th><th>Deleted</th><th>Actions</th></tr></thead>
      <tbody>${items.map(deletedRow).join("")}</tbody>
    </table>` : `<p class="muted">No deleted documents.</p>`}
  `;
  c.querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      const type = b.dataset.type;
      const no = b.dataset.restore;
      if (!confirm(`Restore ${no}? It will reappear in ${type === "invoice" ? "Invoices" : "Quotes"} and its files move back.`)) return;
      b.disabled = true; b.textContent = "Restoring…";
      try {
        await withLoading("Restoring…", async () => {
          await restoreDocument(type, no);
          await renderDeleted();
        });
      } catch (err) {
        console.error(err);
        alert("Restore failed: " + (err.message || "unknown error"));
        b.disabled = false; b.textContent = "Restore";
      }
    })
  );
}

function deletedRow(it) {
  const no = it.no;
  const when = it._data?.deletedAt ? new Date(it._data.deletedAt).toLocaleDateString() : "";
  const links = [];
  const docLink = safeGoogleUrl(it.DocLink);
  const pdfLink = safeGoogleUrl(it.PdfLink);
  if (docLink) links.push(`<a class="small" href="${escA(docLink)}" target="_blank" rel="noopener noreferrer">Open Doc</a>`);
  if (pdfLink) links.push(`<a class="small" href="${escA(pdfLink)}" target="_blank" rel="noopener noreferrer">Open PDF</a>`);
  return `<tr>
    <td>${it.type === "invoice" ? "Invoice" : "Quote"}</td>
    <td><strong>${escH(no)}</strong></td>
    <td>${escH(it.Client)}</td>
    <td>${escH(it["Job / Site"])}</td>
    <td class="num">${money(it["Total (inc GST)"])}</td>
    <td>${escH(when)}</td>
    <td class="row-actions">
      ${links.join(" · ")}
      <button class="btn btn-ghost small" data-restore="${escA(no)}" data-type="${escA(it.type)}">Restore</button>
    </td>
  </tr>`;
}

// --- boot ------------------------------------------------------------------
async function boot() {
  if (GOOGLE_CLIENT_ID.startsWith("PASTE_")) {
    el("config-warning").hidden = false;
    el("welcome-signin").disabled = true;
    el("signin-btn").disabled = true;
  } else {
    try { await initGoogle(); }
    catch (e) { if (e.message === "NO_CLIENT_ID") el("config-warning").hidden = false; else console.error(e); }
  }

  el("signin-btn").addEventListener("click", handleSignIn);
  el("welcome-signin").addEventListener("click", handleSignIn);
  el("signout-btn").addEventListener("click", () => {
    if (!canLeaveCurrentView()) return;
    signOut(); state.user = null; setSignedInUI(false); show("welcome");
  });
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.view))
  );

  // Settings cog dropdown
  const dropdown = el("settings-dropdown");
  el("settings-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  dropdown.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => { dropdown.hidden = true; show(b.dataset.view); })
  );
  document.addEventListener("click", () => { if (!dropdown.hidden) dropdown.hidden = true; });

  // Close any open row-actions dropdown when clicking outside it.
  document.addEventListener("click", (e) => {
    document.querySelectorAll("details.actions-menu[open]").forEach((d) => {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  // Silently resume a saved session if the token is still valid; else land page.
  const resumed = !GOOGLE_CLIENT_ID.startsWith("PASTE_") && (await tryAutoSignIn());
  if (!resumed) show("welcome");
}

boot().catch((error) => {
  console.error("QuoteMe failed to start", error);
  const welcome = el("view-welcome");
  if (welcome) renderViewError(welcome, "welcome", error);
});
