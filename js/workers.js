import { archiveWorker, listWorkers, saveWorker } from "./store.js";
import { withLoading } from "./ui.js";
import { guardForm } from "./navigation.js";
import { beginRender } from "./rendering.js";

const escH = (value) => String(value ?? "").replace(/[<>&]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const escA = (value) => escH(value).replace(/"/g, "&quot;");
const fullName = (worker) => `${worker?.firstName || ""} ${worker?.lastName || ""}`.trim();

export async function renderWorkers(container) {
  const isCurrent = beginRender(container);
  container.innerHTML = `<p class="muted">Loading workers…</p>`;
  const workers = await listWorkers({ includeArchived: true });
  if (!isCurrent()) return;
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Workers</h2>
        <p class="muted">Open a worker to manage their details and timesheets.</p>
      </div>
      <div class="head-actions">
        <label class="toggle-check"><input type="checkbox" id="show-archived-workers"/> Show archived</label>
        <button class="btn btn-primary" id="new-worker">+ New worker</button>
      </div>
    </div>
    ${workers.length ? `<div class="table-scroll"><table class="list">
      <thead><tr><th>Name</th><th>Mobile</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${workers.map(workerRow).join("")}</tbody>
    </table></div>` : `<div class="empty-state"><h3>No workers yet</h3><p>Add your first worker.</p></div>`}`;

  container.querySelector("#new-worker").addEventListener("click", () =>
    renderWorkerForm(
      container,
      null,
      () => renderWorkers(container),
      () => renderWorkers(container),
    ));
  container.querySelector("#show-archived-workers").addEventListener("change", (event) => {
    container.querySelectorAll("[data-archived-worker]").forEach((row) => {
      row.hidden = !event.target.checked;
    });
  });
  container.querySelectorAll("[data-open-worker]").forEach((button) =>
    button.addEventListener("click", () =>
      renderWorkerDetail(container, button.dataset.openWorker)));
  container.querySelectorAll("[data-archive-worker]").forEach((button) =>
    button.addEventListener("click", async () => {
      const worker = workers.find((item) => item.id === button.dataset.archiveWorker);
      if (!worker || !confirm(`Archive ${fullName(worker)}? Historical timesheets will be kept.`)) return;
      await withLoading("Archiving worker…", () => archiveWorker(worker.id));
      await renderWorkers(container);
    }));
}

function workerRow(worker) {
  return `<tr ${worker.status === "Archived" ? "data-archived-worker hidden" : ""}>
    <td><button class="link-button" data-open-worker="${escA(worker.id)}"><strong>${escH(fullName(worker))}</strong></button></td>
    <td>${escH(worker.mobile)}</td>
    <td><span class="pill ${worker.status === "Active" ? "ok" : ""}">${escH(worker.status || "Active")}</span></td>
    <td class="row-actions">
      <button class="btn btn-ghost small" data-open-worker="${escA(worker.id)}">View</button>
      ${worker.status !== "Archived"
        ? `<button class="btn btn-ghost small danger" data-archive-worker="${escA(worker.id)}">Archive</button>`
        : ""}
    </td>
  </tr>`;
}

export async function renderWorkerDetail(container, workerId) {
  const isCurrent = beginRender(container);
  container.innerHTML = `<p class="muted">Loading worker…</p>`;
  const workers = await listWorkers({ includeArchived: true });
  if (!isCurrent()) return;
  const worker = workers.find((item) => item.id === workerId);
  if (!worker) return renderWorkers(container);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <button class="link-button back-link" id="workers-back">← Workers</button>
        <h2>${escH(fullName(worker))}</h2>
        <p class="muted">${escH(worker.mobile)}</p>
      </div>
      <div class="head-actions"><button class="btn btn-primary" id="edit-worker">Edit worker</button></div>
    </div>
    <div class="detail-list">
      ${detailRow("First name", worker.firstName)}
      ${detailRow("Last name", worker.lastName)}
      ${detailRow("Mobile number", worker.mobile)}
      ${detailRow("Status", worker.status || "Active")}
    </div>`;

  container.querySelector("#workers-back").addEventListener("click", () =>
    renderWorkers(container));
  container.querySelector("#edit-worker").addEventListener("click", () =>
    renderWorkerForm(
      container,
      worker,
      () => renderWorkerDetail(container, worker.id),
      () => renderWorkerDetail(container, worker.id),
    ));
}

function detailRow(label, value) {
  return `<div class="detail-row"><div class="detail-label">${label}</div>
    <div class="detail-value">${value ? escH(value) : '<span class="muted">— not set —</span>'}</div></div>`;
}

function renderWorkerForm(container, worker = null, onCancel = null, onSaved = null) {
  container.innerHTML = `
    <div class="form-head"><h2>${worker ? "Edit" : "New"} worker</h2></div>
    <form id="worker-form" class="doc-form detail-form">
      <fieldset><legend>Worker details</legend><div class="grid">
        <label class="f"><span>First name</span>
          <input name="firstName" value="${escA(worker?.firstName)}" required autocomplete="given-name"/>
        </label>
        <label class="f"><span>Last name</span>
          <input name="lastName" value="${escA(worker?.lastName)}" required autocomplete="family-name"/>
        </label>
        <label class="f"><span>Mobile number</span>
          <input name="mobile" type="tel" value="${escA(worker?.mobile)}" autocomplete="tel"/>
        </label>
        <label class="f"><span>Status</span><select name="status">
          <option ${worker?.status !== "Archived" ? "selected" : ""}>Active</option>
          <option ${worker?.status === "Archived" ? "selected" : ""}>Archived</option>
        </select></label>
      </div></fieldset>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="worker-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="worker-save">Save worker</button>
      </div>
      <div class="save-status" id="worker-status"></div>
    </form>`;

  const form = container.querySelector("#worker-form");
  const formGuard = guardForm(form, {
    message: "Discard the unsaved worker changes?",
  });
  container.querySelector("#worker-cancel").addEventListener("click", () =>
    formGuard.leave(() => onCancel ? onCancel() : renderWorkers(container)));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = container.querySelector("#worker-save");
    const status = container.querySelector("#worker-status");
    button.disabled = true;
    try {
      const saved = await withLoading("Saving worker…", () => saveWorker({
        ...worker,
        firstName: form.elements.firstName.value,
        lastName: form.elements.lastName.value,
        mobile: form.elements.mobile.value,
        status: form.elements.status.value,
      }));
      formGuard.markClean();
      formGuard.dispose();
      if (onSaved) await onSaved(saved);
      else await renderWorkers(container);
    } catch (error) {
      console.error(error);
      status.textContent = "⚠️ " + (error.message || "Save failed");
      button.disabled = false;
    }
  });
}
