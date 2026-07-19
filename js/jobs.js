import { deleteJob, listInvoices, listJobs, listQuotes, saveJob } from "./store.js";
import { withLoading } from "./ui.js";
import { money } from "./documents.js";
import { guardForm } from "./navigation.js";
import { beginRender } from "./rendering.js";
import { JOB_STATUSES } from "./domain/jobs.js";

const escH = (value) => String(value ?? "").replace(/[<>&]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const escA = (value) => escH(value).replace(/"/g, "&quot;");

export async function renderJobs(container) {
  const isCurrent = beginRender(container);
  container.innerHTML = `<p class="muted">Loading jobs…</p>`;
  const jobs = await listJobs({ includeArchived: true });
  if (!isCurrent()) return;
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Jobs</h2>
        <p class="muted">Job details will pre-populate quotes, invoices and timesheets.</p>
      </div>
      <div class="head-actions">
        <label class="toggle-check"><input type="checkbox" id="show-archived-jobs"/> Show archived</label>
        <button class="btn btn-primary" id="new-job">+ New job</button>
      </div>
    </div>
    ${jobs.length ? `<table class="list">
      <thead><tr><th>Job</th><th>Client</th><th>Job / site</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${jobs.map(jobRow).join("")}</tbody>
    </table>` : `<div class="empty-state"><h3>No jobs yet</h3><p>Create a job to reuse its details.</p></div>`}`;

  container.querySelector("#new-job").addEventListener("click", () =>
    renderJobForm(container, null, () => renderJobs(container), () => renderJobs(container)));
  container.querySelector("#show-archived-jobs").addEventListener("change", (event) => {
    container.querySelectorAll("[data-archived-job]").forEach((row) => {
      row.hidden = !event.target.checked;
    });
  });
  container.querySelectorAll("[data-job-status]").forEach((select) =>
    select.addEventListener("change", async () => {
      const job = jobs.find((item) => item.id === select.dataset.jobStatus);
      if (!job) return;
      try {
        await withLoading("Updating job status…", () =>
          saveJob({ ...job, status: select.value }));
        await renderJobs(container);
      } catch (error) {
        console.error(error);
        alert("Status update failed: " + (error.message || "unknown error"));
        await renderJobs(container);
      }
    }));
  container.querySelectorAll("[data-open-job]").forEach((button) =>
    button.addEventListener("click", () => renderJobDetail(container, button.dataset.openJob)));
  container.querySelectorAll("[data-delete-job]").forEach((button) =>
    button.addEventListener("click", async () => {
      const job = jobs.find((item) => item.id === button.dataset.deleteJob);
      if (!job || !confirm(
        `Permanently delete “${job.name}”?\n\nThis cannot be undone. Existing quotes, invoices and timesheets will keep their saved job details.`,
      )) return;
      try {
        await withLoading("Deleting job…", () => deleteJob(job.id));
        await renderJobs(container);
      } catch (error) {
        console.error(error);
        alert("Delete failed: " + (error.message || "unknown error"));
      }
    }));
}

function jobRow(job) {
  return `<tr ${job.status === "Archived" ? "data-archived-job hidden" : ""}>
    <td><button class="link-button" data-open-job="${escA(job.id)}"><strong>${escH(job.name)}</strong></button></td>
    <td>${escH(job.client?.name)}</td>
    <td>${escH(job.jobSite)}</td>
    <td>${statusSelect(job)}</td>
    <td class="row-actions">${jobActions(job)}</td>
  </tr>`;
}

function statusSelect(job) {
  const current = job.status || "Active";
  return `<select class="status-select" data-job-status="${escA(job.id)}">
    ${JOB_STATUSES.map((status) =>
      `<option value="${status}" ${status === current ? "selected" : ""}>${status}</option>`).join("")}
  </select>`;
}

function jobActions(job) {
  if (job.status !== "Archived") {
    return `<button class="btn btn-ghost small" data-open-job="${escA(job.id)}">View</button>`;
  }
  return `<details class="actions-menu">
    <summary class="btn btn-ghost small">Actions ▾</summary>
    <div class="menu">
      <button data-open-job="${escA(job.id)}">View</button>
      <button class="danger" data-delete-job="${escA(job.id)}">Delete permanently</button>
    </div>
  </details>`;
}

export async function renderJobDetail(container, jobId) {
  const isCurrent = beginRender(container);
  container.innerHTML = `<p class="muted">Loading job…</p>`;
  const [jobs, quotes, invoices] = await Promise.all([
    listJobs({ includeArchived: true }),
    listQuotes(),
    listInvoices(),
  ]);
  if (!isCurrent()) return;
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return renderJobs(container);
  const activity = [
    ...quotes
      .filter((quote) => documentBelongsToJob(quote, job))
      .map((quote) => ({
        type: "Quote",
        number: quote["Quote No."],
        date: quote["Date Issued"],
        total: quote["Total (inc GST)"],
        status: quote.Status,
      })),
    ...invoices
      .filter((invoice) => documentBelongsToJob(invoice, job))
      .map((invoice) => ({
        type: "Invoice",
        number: invoice["Invoice No."],
        date: invoice["Date Issued"],
        total: invoice["Total (inc GST)"],
        status: invoice.Status,
      })),
  ].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 8);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <button class="link-button back-link" id="jobs-back">← Jobs</button>
        <h2>${escH(job.name)}</h2>
        <p class="muted">${escH(job.client?.name)}${job.jobSite ? ` · ${escH(job.jobSite)}` : ""}</p>
      </div>
      <div class="head-actions"><button class="btn btn-primary" id="edit-job">Edit job</button></div>
    </div>
    <div class="detail-list job-details">
      ${detailRow("Status", job.status || "Active")}
      ${detailRow("Client / company", job.client?.name)}
      ${detailRow("Contact (Attn)", job.client?.attn)}
      ${detailRow("Address", job.client?.address)}
      ${detailRow("Suburb, State, Postcode", job.client?.suburb)}
      ${detailRow("Phone", job.client?.phone)}
      ${detailRow("Job / site address", job.jobSite)}
    </div>
    <h3>Recent activity</h3>
    ${activity.length ? `<table class="list">
      <thead><tr><th>Type</th><th>No.</th><th>Date</th><th class="num">Total</th><th>Status</th></tr></thead>
      <tbody>${activity.map((item) => `<tr>
        <td>${item.type}</td>
        <td><strong>${escH(item.number)}</strong></td>
        <td>${escH(item.date)}</td>
        <td class="num">${money(item.total)}</td>
        <td>${activityStatus(item.status)}</td>
      </tr>`).join("")}</tbody>
    </table>` : `<p class="muted">No quotes or invoices for this job yet.</p>`}`;

  container.querySelector("#jobs-back").addEventListener("click", () => renderJobs(container));
  container.querySelector("#edit-job").addEventListener("click", () =>
    renderJobForm(
      container,
      job,
      () => renderJobDetail(container, job.id),
      () => renderJobDetail(container, job.id),
    ));
}

function documentBelongsToJob(document, job) {
  const data = document._data || {};
  if (data.jobId) return data.jobId === job.id;
  const normalise = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const documentClient = normalise(data.client?.name || document.Client);
  const documentSite = normalise(data.jobSite || document["Job / Site"]);
  return !!documentClient
    && !!documentSite
    && documentClient === normalise(job.client?.name)
    && documentSite === normalise(job.jobSite);
}

function activityStatus(status) {
  const tone = {
    Paid: "ok", Accepted: "ok", Overdue: "bad", Declined: "bad",
    Pending: "warn", Unpaid: "warn",
  }[status] || "";
  return `<span class="pill ${tone}">${escH(status || "—")}</span>`;
}

function detailRow(label, value) {
  return `<div class="detail-row"><div class="detail-label">${label}</div>
    <div class="detail-value">${value ? escH(value) : '<span class="muted">— not set —</span>'}</div></div>`;
}

function input(label, name, value = "", required = false) {
  return `<label class="f"><span>${label}</span>
    <input name="${name}" value="${escA(value)}" ${required ? "required" : ""}/>
  </label>`;
}

function renderJobForm(container, job = null, onCancel = null, onSaved = null) {
  const client = job?.client || {};
  container.innerHTML = `
    <div class="form-head"><h2>${job ? "Edit" : "New"} job</h2></div>
    <form id="job-form" class="doc-form detail-form-wide">
      <fieldset><legend>Job</legend><div class="grid">
        ${input("Job name", "name", job?.name, true)}
        <label class="f"><span>Status</span><select name="status">
          ${JOB_STATUSES.map((status) =>
            `<option ${(!job && status === "Active") || job?.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select></label>
        ${input("Job / site address", "jobSite", job?.jobSite)}
      </div></fieldset>
      <fieldset><legend>Client details</legend><div class="grid">
        ${input("Client / company name", "clientName", client.name)}
        ${input("Contact (Attn)", "attn", client.attn)}
        ${input("Address", "address", client.address)}
        ${input("Suburb, State, Postcode", "suburb", client.suburb)}
        ${input("Phone", "phone", client.phone)}
      </div></fieldset>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="job-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="job-save">Save job</button>
      </div>
      <div class="save-status" id="job-status"></div>
    </form>`;

  const form = container.querySelector("#job-form");
  const formGuard = guardForm(form, {
    message: "Discard the unsaved job changes?",
  });
  container.querySelector("#job-cancel").addEventListener("click", () =>
    formGuard.leave(() => onCancel ? onCancel() : renderJobs(container)));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = container.querySelector("#job-save");
    const status = container.querySelector("#job-status");
    const value = (name) => form.elements[name].value.trim();
    button.disabled = true;
    try {
      const saved = await withLoading("Saving job…", () => saveJob({
        ...job,
        name: value("name"),
        status: value("status"),
        jobSite: value("jobSite"),
        client: {
          name: value("clientName"), attn: value("attn"), address: value("address"),
          suburb: value("suburb"), phone: value("phone"),
        },
      }));
      formGuard.markClean();
      formGuard.dispose();
      if (onSaved) await onSaved(saved);
      else await renderJobs(container);
    } catch (error) {
      console.error(error);
      status.textContent = "⚠️ " + (error.message || "Save failed");
      button.disabled = false;
    }
  });
}
