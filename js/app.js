// ============================================================================
//  app.js — bootstrap, sign-in, view switching, and the register views.
// ============================================================================
import { GOOGLE_CLIENT_ID } from "./config.js";
import { initGoogle, signIn, signOut, getUserInfo } from "./google.js";
import {
  initStore, listQuotes, listInvoices,
  markQuoteConverted, setQuoteStatus, setInvoiceStatus, deleteDocument,
  getCompany, businessDetailsComplete, businessSheetUrl, refreshCompany,
} from "./store.js";
import { renderForm } from "./forms.js";
import { money } from "./documents.js";

const el = (id) => document.getElementById(id);
const state = { user: null };
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
}

function setSignedInUI(signedIn) {
  el("tabs").hidden = !signedIn;
  el("signin-btn").hidden = signedIn;
  el("signout-btn").hidden = !signedIn;
  el("user-label").textContent = signedIn && state.user ? state.user.email : "";
}

// --- sign-in ---------------------------------------------------------------
async function handleSignIn() {
  try {
    await signIn();
    state.user = await getUserInfo();
    setSignedInUI(true);
    el("view-dashboard").innerHTML = `<p class="muted">Setting up your Drive folder and register…</p>`;
    show("dashboard");
    await initStore();
    applyBranding();
    renderDashboard();
  } catch (err) {
    console.error(err);
    alert("Sign-in failed: " + (err.message || err.error || "unknown error"));
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
        <button class="btn btn-ghost" id="edit-business">Business details</button>
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
  const editBtn = el("edit-business");
  if (editBtn) editBtn.addEventListener("click", openBusinessDetails);
  const bannerBtn = document.getElementById("banner-edit");
  if (bannerBtn) bannerBtn.addEventListener("click", openBusinessDetails);
  const refreshBtn = document.getElementById("banner-refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", async () => {
    await refreshCompany();
    applyBranding();
    renderDashboard();
  });
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
      aren't filled in yet. They live in a Google Sheet — add them so they appear on your documents.
    </div>
    <div class="banner-actions">
      <button class="btn btn-primary small" id="banner-edit">Open business details</button>
      <button class="btn btn-ghost small" id="banner-refresh">I've filled them in</button>
    </div>
  </div>`;
}

// Open the Business Details tab of the register sheet in a new tab.
async function openBusinessDetails() {
  const url = await businessSheetUrl();
  window.open(url, "_blank");
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
    <tr><td>${r.kind}</td><td><strong>${r.n}</strong></td><td>${r.who || ""}</td>
        <td class="num">${money(r.t)}</td><td>${statusPill(r.s)}</td></tr>`).join("")}
  </tbody></table>`;
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
}

function quoteRow(q) {
  const no = q["Quote No."];
  const converted = q["Converted to Inv."];
  return `<tr>
    <td><strong>${no}</strong></td>
    <td>${q["Date Issued"]}</td>
    <td>${q.Client || ""}</td>
    <td>${q["Job / Site"] || ""}</td>
    <td class="num">${money(q["Total (inc GST)"])}</td>
    <td>${q["Valid Until"] || ""}</td>
    <td>${converted ? statusPill("Accepted") : statusSelect(no, q.Status, ["Pending", "Accepted", "Declined"], "qstatus")}</td>
    <td class="row-actions">
      ${docLinks(q)}
      <button class="btn btn-ghost small" data-edit="${no}">Edit</button>
      ${converted
        ? `<span class="muted small">→ ${converted}</span>`
        : `<button class="btn btn-ghost small" data-convert="${no}">Convert to invoice</button>`}
      <button class="btn btn-ghost small danger" data-del="${no}">Delete</button>
    </td>
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
}

function invoiceRow(i) {
  const no = i["Invoice No."];
  return `<tr>
    <td><strong>${no}</strong></td>
    <td>${i["Date Issued"]}</td>
    <td>${i.Client || ""}</td>
    <td>${i["Job / Site"] || ""}</td>
    <td class="num">${money(i["Total (inc GST)"])}</td>
    <td>${i["Due Date"] || ""}</td>
    <td>${statusSelect(no, i.Status, ["Unpaid", "Paid", "Overdue"], "istatus", i["Total (inc GST)"])}</td>
    <td class="row-actions">
      ${docLinks(i)}
      <button class="btn btn-ghost small" data-edit="${no}">Edit</button>
      <button class="btn btn-ghost small danger" data-del="${no}">Delete</button>
    </td>
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
function docLinks(r) {
  const a = [];
  if (r.DocLink) a.push(`<a class="small" href="${r.DocLink}" target="_blank">Doc</a>`);
  if (r.PdfLink) a.push(`<a class="small" href="${r.PdfLink}" target="_blank">PDF</a>`);
  return a.join(" · ");
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
  show("welcome");
}

boot();
