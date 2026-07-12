// ============================================================================
//  forms.js — the quote / invoice entry form.
//  Renders into a container, manages line items + live totals, and on submit
//  calls store.saveDocument() (which creates the Doc, PDF and register row).
// ============================================================================
import { QUOTE_VALID_DAYS, INVOICE_DUE_DAYS } from "./config.js";
import { computeTotals, money } from "./documents.js";
import { nextNumber, saveDocument, updateDocument, getCompany } from "./store.js";
import { showLoading, hideLoading } from "./ui.js";

const todayISO = () => new Date().toISOString().slice(0, 10);
function addDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const field = (label, name, value = "", type = "text", extra = "") => `
  <label class="f">
    <span>${label}</span>
    <input name="${name}" type="${type}" value="${escAttr(value)}" ${extra}/>
  </label>`;
const area = (label, name, value = "", rows = 3) => `
  <label class="f f-wide">
    <span>${label}</span>
    <textarea name="${name}" rows="${rows}">${escHtml(value)}</textarea>
  </label>`;

function escAttr(s) { return String(s ?? "").replace(/"/g, "&quot;"); }
function escHtml(s) { return String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// --- render ----------------------------------------------------------------
export function renderForm(type, container, { prefill = null, onSaved, editMode = false } = {}) {
  const isQuote = type === "quote";
  const p = prefill || {};
  const client = p.client || {};
  const items = (p.lineItems && p.lineItems.length ? p.lineItems : [blankItem(), blankItem(), blankItem()]);

  container.innerHTML = `
    <div class="form-head">
      <h2>${editMode ? "Edit" : "New"} ${isQuote ? "Quote" : "Invoice"}</h2>
      <div class="doc-no" id="doc-no">${editMode ? "" : "Assigning number…"}</div>
    </div>

    <form id="doc-form" class="doc-form">
      <fieldset>
        <legend>${isQuote ? "Prepared for" : "Bill to"}</legend>
        <div class="grid">
          ${field("Client / Company name", "client.name", client.name)}
          ${field("Contact (Attn)", "client.attn", client.attn)}
          ${field("Address", "client.address", client.address)}
          ${field("Suburb, State, Postcode", "client.suburb", client.suburb)}
          ${field("Phone", "client.phone", client.phone)}
          ${field("Job / site address", "jobSite", p.jobSite)}
        </div>
      </fieldset>

      <fieldset>
        <legend>Details</legend>
        <div class="grid">
          ${isQuote ? `
            ${field("Date issued", "dateIssued", p.dateIssued || todayISO(), "date")}
            ${field("Valid until", "validUntil", p.validUntil || addDays(todayISO(), QUOTE_VALID_DAYS), "date")}
            ${field("Prepared by", "preparedBy", p.preparedBy || (getCompany()?.name ?? ""))}
            ${field("Est. start (optional)", "estStart", p.estStart)}
          ` : `
            ${field("Issue date", "issueDate", p.issueDate || todayISO(), "date")}
            ${field("Due date", "dueDate", p.dueDate || addDays(todayISO(), INVOICE_DUE_DAYS), "date")}
            ${field("Quote ref (optional)", "quoteRef", p.quoteRef)}
          `}
        </div>
      </fieldset>

      ${isQuote ? `<fieldset><legend>Scope of works</legend>
        ${area("Describe the works being quoted", "scope", p.scope, 4)}
      </fieldset>` : ""}

      <fieldset>
        <legend>Line items</legend>
        <table class="items" id="items">
          <thead><tr>
            <th>Description of works / materials</th><th class="num">Qty</th>
            <th class="num">Unit</th><th class="num">Rate (ex GST)</th>
            <th class="num amt">Amount (ex GST)</th><th></th>
          </tr></thead>
          <tbody id="items-body"></tbody>
        </table>
        <button type="button" class="btn btn-ghost" id="add-item">+ Add line</button>
      </fieldset>

      ${isQuote ? `<fieldset><legend>Inclusions / exclusions</legend>
        <div class="grid">
          ${field("Includes", "includes", p.includes)}
          ${field("Excludes", "excludes", p.excludes)}
          ${field("Deposit", "deposit", p.deposit || "10% on acceptance")}
        </div>
      </fieldset>` : ""}

      <fieldset>
        <legend>Notes (internal — not printed)</legend>
        ${area("", "notes", p.notes, 2)}
      </fieldset>

      <div class="totals-bar" id="totals-bar"></div>

      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="cancel-btn">Cancel</button>
        <button type="submit" class="btn btn-primary" id="save-btn">
          ${editMode ? "Update" : "Generate"} &amp; save ${isQuote ? "quote" : "invoice"}
        </button>
      </div>
      <div class="save-status" id="save-status"></div>
    </form>
  `;

  const body = container.querySelector("#items-body");
  items.forEach((it) => body.appendChild(itemRow(it)));

  container.querySelector("#add-item").addEventListener("click", () => {
    body.appendChild(itemRow(blankItem()));
    recalc();
  });
  body.addEventListener("input", (e) => {
    // auto-fill amount from qty × rate unless the amount cell itself was edited
    const tr = e.target.closest("tr");
    if (["qty", "rate"].includes(e.target.dataset.k)) {
      const qty = Number(tr.querySelector('[data-k=qty]').value) || 0;
      const rate = Number(tr.querySelector('[data-k=rate]').value) || 0;
      if (qty && rate) tr.querySelector('[data-k=amount]').value = (qty * rate).toFixed(2);
    }
    recalc();
  });
  body.addEventListener("click", (e) => {
    if (e.target.classList.contains("del-item")) {
      e.target.closest("tr").remove();
      recalc();
    }
  });

  function recalc() {
    const totals = computeTotals(collectItems());
    container.querySelector("#totals-bar").innerHTML = `
      <span>Subtotal (ex GST) <strong>${money(totals.subtotal)}</strong></span>
      <span>GST (10%) <strong>${money(totals.gst)}</strong></span>
      <span class="grand">Total (inc GST) <strong>${money(totals.total)}</strong></span>`;
  }
  function collectItems() {
    return [...body.querySelectorAll("tr")].map((tr) => ({
      description: tr.querySelector('[data-k=description]').value,
      qty: tr.querySelector('[data-k=qty]').value,
      unit: tr.querySelector('[data-k=unit]').value,
      rate: tr.querySelector('[data-k=rate]').value,
      amount: tr.querySelector('[data-k=amount]').value,
    }));
  }
  recalc();

  // number assignment — keep the existing number when editing, else assign next
  const docNoEl = container.querySelector("#doc-no");
  if (editMode && p.number) {
    docNoEl.textContent = p.number;
    docNoEl.dataset.number = p.number;
  } else {
    nextNumber(type).then((n) => {
      docNoEl.textContent = n;
      docNoEl.dataset.number = n;
    });
  }

  container.querySelector("#cancel-btn").addEventListener("click", () => onSaved && onSaved(null));

  container.querySelector("#doc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = container.querySelector("#save-btn");
    const status = container.querySelector("#save-status");
    saveBtn.disabled = true;
    status.textContent = "";
    showLoading(editMode ? "Regenerating the document…" : "Generating the document…");
    try {
      const data = collectData(container, type, collectItems());
      const res = editMode ? await updateDocument(data) : await saveDocument(data);
      status.innerHTML = `✅ Saved <strong>${res.number}</strong> —
        <a href="${res.docLink}" target="_blank">open Doc</a> ·
        <a href="${res.pdfLink}" target="_blank">open PDF</a>`;
      if (onSaved) setTimeout(() => onSaved(res), 900);
    } catch (err) {
      console.error(err);
      status.textContent = "⚠️ " + (err.message || "Save failed");
      saveBtn.disabled = false;
    } finally {
      hideLoading();
    }
  });
}

function collectData(container, type, lineItems) {
  const f = container.querySelector("#doc-form");
  const get = (n) => (f.elements[n] ? f.elements[n].value : "");
  const data = {
    type,
    number: container.querySelector("#doc-no").dataset.number,
    client: { name: get("client.name"), attn: get("client.attn"), address: get("client.address"),
              suburb: get("client.suburb"), phone: get("client.phone") },
    jobSite: get("jobSite"),
    lineItems,
    notes: get("notes"),
  };
  if (type === "quote") {
    Object.assign(data, {
      dateIssued: get("dateIssued"), validUntil: get("validUntil"),
      preparedBy: get("preparedBy"), estStart: get("estStart"),
      scope: get("scope"), includes: get("includes"),
      excludes: get("excludes"), deposit: get("deposit"), status: "Pending",
    });
  } else {
    Object.assign(data, {
      issueDate: get("issueDate"), dueDate: get("dueDate"),
      quoteRef: get("quoteRef"), status: "Unpaid",
    });
  }
  return data;
}

// --- line item row ---------------------------------------------------------
function blankItem() { return { description: "", qty: "", unit: "", rate: "", amount: "" }; }
function itemRow(it) {
  const tr = document.createElement("tr");
  const inp = (k, cls = "", type = "text") => {
    const numAttrs = type === "number" ? ' inputmode="decimal" step="any" min="0"' : "";
    return `<input data-k="${k}" class="${cls}" type="${type}"${numAttrs} value="${escAttr(it[k])}"/>`;
  };
  tr.innerHTML = `
    <td>${inp("description")}</td>
    <td class="num">${inp("qty", "num", "number")}</td>
    <td class="num">${inp("unit", "num")}</td>
    <td class="num">${inp("rate", "num", "number")}</td>
    <td class="num amt">${inp("amount", "num", "number")}</td>
    <td><button type="button" class="del-item" title="Remove">✕</button></td>`;
  return tr;
}
