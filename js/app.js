// ============================================================================
//  app.js — bootstrap, sign-in, view switching, and the register views.
// ============================================================================
import { GOOGLE_CLIENT_ID } from "./config.js";
import { initGoogle, signIn, signOut, getUserInfo, restoreToken, BUSINESS_FIELDS } from "./google.js";
import {
  initStore, listQuotes, listInvoices,
  markQuoteConverted, setQuoteStatus, setInvoiceStatus, deleteDocument,
  getCompany, businessDetailsComplete, businessSheetUrl, refreshCompany, saveBusinessDetails,
  emailPdf, fetchPdfBlob,
} from "./store.js";
import { renderForm } from "./forms.js";
import { money } from "./documents.js";

const el = (id) => document.getElementById(id);
const state = { user: null, highlight: null };
const num = (v) => Number(v) || 0;

// --- view switching --------------------------------------------------------
function show(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  el(`view-${view}`).hidden = false;
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.view === view)
  );
  if (view === "dashboard") renderDashboard();
  if (view === "quotes") renderQuotes();
  if (view === "invoices") renderInvoices();
  if (view === "business") renderBusiness(false);
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
  state.user = await getUserInfo();
  setSignedInUI(true);
  el("view-dashboard").innerHTML = `<p class="muted">Setting up your Drive folder and register…</p>`;
  show("dashboard");
  await initStore();
  applyBranding();
  renderDashboard();
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
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const [quotes, invoices] = await Promise.all([listQuotes(), listInvoices()]);

  const qTotal = quotes.reduce((s, q) => s + num(q["Total (inc GST)"]), 0);
  const qAccepted = quotes.filter((q) => q.Status === "Accepted");
  const qPending = quotes.filter((q) => q.Status === "Pending");
  const winRate = quotes.length ? Math.round((qAccepted.length / quotes.length) * 100) : 0;

  const invoiced = invoices.reduce((s, i) => s + num(i["Total (inc GST)"]), 0);
  const received = invoices.reduce((s, i) => s + num(i.Received), 0);
  const outstanding = invoiced - received;

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
      ${statCard("Quotes logged", quotes.length)}
      ${statCard("Win rate", winRate + "%")}
      ${statCard("Pending quotes", money(qPending.reduce((s, q) => s + num(q["Total (inc GST)"]), 0)))}
      ${statCard("Total invoiced", money(invoiced))}
      ${statCard("Received", money(received))}
      ${statCard("Outstanding", money(outstanding), outstanding > 0 ? "bad" : "ok")}
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
  return `<div class="card stat ${tone}"><div class="stat-val">${value}</div><div class="stat-lbl">${label}</div></div>`;
}

function recentList(quotes, invoices) {
  const rows = [
    ...quotes.map((q) => ({ n: q["Quote No."], d: q["Date Issued"], who: q.Client, t: q["Total (inc GST)"], s: q.Status, kind: "Quote" })),
    ...invoices.map((i) => ({ n: i["Invoice No."], d: i["Date Issued"], who: i.Client, t: i["Total (inc GST)"], s: i.Status, kind: "Invoice" })),
  ].reverse().slice(0, 8);
  if (!rows.length) return `<p class="muted">Nothing yet — create your first quote or invoice above.</p>`;
  return `<table class="list"><tbody>${rows.map((r) => `
    <tr><td>${r.kind}</td>
        <td><a href="#" class="link-num" data-goto="${r.kind.toLowerCase()}" data-number="${r.n}">${r.n}</a></td>
        <td>${r.who || ""}</td>
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
  const tr = container.querySelector(`tr[data-num="${state.highlight}"]`);
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
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const quotes = await listQuotes();
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
      await setQuoteStatus(sel.dataset.qstatus, sel.value);
      renderQuotes();
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
  return `<tr data-num="${no}">
    <td><strong>${no}</strong></td>
    <td>${q["Date Issued"]}</td>
    <td>${q.Client || ""}</td>
    <td>${q["Job / Site"] || ""}</td>
    <td class="num">${money(q["Total (inc GST)"])}</td>
    <td>${q["Valid Until"] || ""}</td>
    <td>${converted ? statusPill("Accepted") : statusSelect(no, q.Status, ["Pending", "Accepted", "Declined"], "qstatus")}</td>
    <td class="row-actions">${actionsMenu(q, "quote")}</td>
  </tr>`;
}

// --- invoices view ---------------------------------------------------------
async function renderInvoices() {
  const c = el("view-invoices");
  c.innerHTML = `<p class="muted">Loading…</p>`;
  const invoices = await listInvoices();
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
      const no = sel.dataset.istatus;
      const paid = sel.value === "Paid";
      await setInvoiceStatus(no, sel.value, paid
        ? { datePaid: new Date().toISOString().slice(0, 10), received: sel.dataset.total }
        : {});
      renderInvoices();
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
  return `<tr data-num="${no}">
    <td><strong>${no}</strong></td>
    <td>${i["Date Issued"]}</td>
    <td>${i.Client || ""}</td>
    <td>${i["Job / Site"] || ""}</td>
    <td class="num">${money(i["Total (inc GST)"])}</td>
    <td>${i["Due Date"] || ""}</td>
    <td>${statusSelect(no, i.Status, ["Unpaid", "Paid", "Overdue"], "istatus", i["Total (inc GST)"])}</td>
    <td class="row-actions">${actionsMenu(i, "invoice")}</td>
  </tr>`;
}

// Wire the Delete buttons in a register view.
function wireDelete(container, type, rerender) {
  container.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const no = b.dataset.del;
      if (!confirm(`Delete ${no}?\n\nIts row is removed from the register and the Doc + PDF are moved to your Google Drive trash (recoverable for ~30 days).`)) return;
      b.disabled = true; b.textContent = "Deleting…";
      try {
        await deleteDocument(type, no);
        rerender();
      } catch (err) {
        console.error(err);
        alert("Delete failed: " + (err.message || "unknown error"));
        b.disabled = false; b.textContent = "Delete";
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
  if (rec.DocLink) items.push(`<a href="${rec.DocLink}" target="_blank">Open Doc</a>`);
  if (rec.PdfLink) items.push(`<a href="${rec.PdfLink}" target="_blank">Open PDF</a>`);
  if (rec.PdfLink) items.push(`<button data-download="${no}">Download PDF</button>`);
  if (rec.PdfLink) items.push(`<button data-email="${no}">Email PDF…</button>`);
  items.push(`<button data-edit="${no}">Edit</button>`);
  if (type === "quote") {
    const converted = rec["Converted to Inv."];
    items.push(converted
      ? `<span class="menu-note">Converted → ${converted}</span>`
      : `<button data-convert="${no}">Convert to invoice</button>`);
  }
  items.push(`<button class="danger" data-del="${no}">Delete</button>`);
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
  return `<span class="pill ${tone}">${s || "—"}</span>`;
}
function statusSelect(no, current, options, dataAttr, total = "") {
  return `<select class="status-select" data-${dataAttr}="${no}" data-total="${total}">
    ${options.map((o) => `<option ${o === current ? "selected" : ""}>${o}</option>`).join("")}
  </select>`;
}

// --- form flow -------------------------------------------------------------
function openForm(type, { prefill = null, editMode = false, afterSave = null } = {}) {
  const view = type === "invoice" ? "invoices" : "quotes";
  const c = el(`view-${view}`);
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
    client: src.client, jobSite: src.jobSite,
    lineItems: src.lineItems, quoteRef: quoteNumber,
    summary: src.summary,
  };
  openForm("invoice", {
    prefill,
    afterSave: async (res) => { await markQuoteConverted(quoteNumber, res.number); },
  });
}

// --- download a PDF --------------------------------------------------------
async function downloadPdfFlow(type, number, records) {
  const key = type === "invoice" ? "Invoice No." : "Quote No.";
  const rec = records.find((r) => r[key] === number);
  if (!rec || !rec.PdfLink) { alert("No PDF found for this document."); return; }
  try {
    const blob = await fetchPdfBlob(rec.PdfLink);
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
      <h3>Email PDF — ${number}</h3>
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

  const close = () => overlay.remove();
  const $ = (id) => overlay.querySelector(id);
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
      await onSend({ to, subject: $("#em-subject").value.trim(), body: $("#em-body").value });
      status.textContent = "✅ Sent!";
      setTimeout(close, 1000);
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
const escH = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const escA = (s) => String(s ?? "").replace(/"/g, "&quot;");

async function renderBusiness(editing = false) {
  const c = el("view-business");
  if (!editing) {
    c.innerHTML = `<p class="muted">Loading…</p>`;
    try { await refreshCompany(); } catch (e) { console.error(e); }
    applyBranding();
  }
  const co = getCompany() || {};

  if (editing) return renderBusinessEdit(c, co);

  const sheetUrl = await businessSheetUrl();
  c.innerHTML = `
    <div class="page-head">
      <h2>Business details</h2>
      <div class="head-actions"><button class="btn btn-primary" id="biz-edit">Edit</button></div>
    </div>
    <p class="muted">These appear on every quote and invoice.
      <a href="${sheetUrl}" target="_blank">Open the source sheet</a>.</p>
    <div class="detail-list">
      ${BUSINESS_FIELDS.map((f) => {
        const v = getPath(co, f.key);
        return `<div class="detail-row">
          <div class="detail-label">${f.label}</div>
          <div class="detail-value">${v ? escH(v) : '<span class="muted">— not set —</span>'}</div>
        </div>`;
      }).join("")}
    </div>`;
  el("biz-edit").addEventListener("click", () => renderBusiness(true));
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

  el("biz-cancel").addEventListener("click", () => renderBusiness(false));
  el("biz-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el("biz-save");
    const status = el("biz-status");
    btn.disabled = true;
    status.textContent = "Saving to your Business Details sheet…";
    const company = { bank: {} };
    for (const f of BUSINESS_FIELDS) setPath(company, f.key, e.target.elements[f.key].value.trim());
    try {
      await saveBusinessDetails(company);
      applyBranding();
      renderBusiness(false);
    } catch (err) {
      console.error(err);
      status.textContent = "⚠️ " + (err.message || "Save failed");
      btn.disabled = false;
    }
  });
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

boot();
