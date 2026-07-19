import {
  deleteTimesheet, generateTimesheetPdf, listJobs, listTimesheets, listWorkers, saveTimesheet,
} from "./store.js";
import { withLoading } from "./ui.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const escH = (value) => String(value ?? "").replace(/[<>&]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const escA = (value) => escH(value).replace(/"/g, "&quot;");
const workerName = (worker) => `${worker?.firstName || ""} ${worker?.lastName || ""}`.trim();

function dateFromISO(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateISO(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(iso, count) {
  const date = dateFromISO(iso);
  date.setDate(date.getDate() + count);
  return dateISO(date);
}

function weekStartFor(iso) {
  const date = dateFromISO(iso);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return dateISO(date);
}

const currentWeekStart = () => weekStartFor(dateISO(new Date()));
const displayDate = (iso, year = false) => dateFromISO(iso).toLocaleDateString("en-AU", {
  day: "2-digit", month: "short", ...(year ? { year: "numeric" } : {}),
});
const formatHours = (value) => {
  const number = Number(value) || 0;
  return number ? String(Math.round(number * 100) / 100) : "";
};

export async function renderAllTimesheets(container) {
  container.innerHTML = `<p class="muted">Loading timesheets…</p>`;
  let [sheets, workers, jobs] = await Promise.all([
    listTimesheets(),
    listWorkers({ includeArchived: true }),
    listJobs({ includeArchived: true }),
  ]);
  let selectedWorkerId = "";
  let selectedJobId = "";
  let showInactiveWorkers = false;
  let showArchivedJobs = false;
  let showCompletedJobs = false;
  let message = "";
  const sortSheets = () => sheets.sort((a, b) =>
    (b.weekStart || "").localeCompare(a.weekStart || "")
    || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  sortSheets();

  function render() {
    const selectableWorkers = workers.filter((worker) =>
      showInactiveWorkers || worker.status !== "Archived");
    if (selectedWorkerId && !selectableWorkers.some((worker) => worker.id === selectedWorkerId)) {
      selectedWorkerId = "";
    }
    const selectableJobs = jobs.filter((job) => {
      const status = job.status || "Active";
      return status === "Active"
        || (status === "Archived" && showArchivedJobs)
        || (status === "Complete" && showCompletedJobs);
    });
    if (selectedJobId && !selectableJobs.some((job) => job.id === selectedJobId)) {
      selectedJobId = "";
    }
    const visibleSheets = sheets.filter((sheet) =>
      (!selectedWorkerId || sheet.workerId === selectedWorkerId)
      && (!selectedJobId || sheet.jobId === selectedJobId));

    container.innerHTML = `
      <div class="page-head">
        <div><h2>Timesheets</h2><p class="muted">All saved timesheets, latest week first.</p></div>
        <div class="head-actions">
          <button class="btn btn-primary" id="new-main-timesheet">+ New timesheet</button>
        </div>
      </div>
      <div class="timesheet-context timesheet-filters">
        <label class="f"><span>Worker</span>
          <select id="all-timesheet-worker">
            <option value="">All workers</option>
            ${selectableWorkers.map((worker) => `<option value="${escA(worker.id)}"
              ${worker.id === selectedWorkerId ? "selected" : ""}>
              ${escH(workerName(worker))}${worker.status === "Archived" ? " (inactive)" : ""}
            </option>`).join("")}
          </select>
        </label>
        <label class="toggle-check">
          <input type="checkbox" id="show-inactive-workers" ${showInactiveWorkers ? "checked" : ""}/>
          Show inactive workers
        </label>
        <div class="job-filter-group">
          <label class="f"><span>Job</span>
            <select id="all-timesheet-job">
              <option value="">All jobs</option>
              ${selectableJobs.map((job) => `<option value="${escA(job.id)}"
                ${job.id === selectedJobId ? "selected" : ""}>
                ${escH(job.name)}${job.status !== "Active" ? ` (${escH((job.status || "").toLowerCase())})` : ""}
              </option>`).join("")}
            </select>
          </label>
          <div class="filter-checks">
            <label class="toggle-check">
              <input type="checkbox" id="show-completed-jobs" ${showCompletedJobs ? "checked" : ""}/>
              Show completed jobs
            </label>
            <label class="toggle-check">
              <input type="checkbox" id="show-archived-jobs" ${showArchivedJobs ? "checked" : ""}/>
              Show archived jobs
            </label>
          </div>
        </div>
      </div>
      ${message ? `<div class="banner success-banner">${escH(message)}</div>` : ""}
      ${visibleSheets.length ? `<div class="table-scroll"><table class="list">
        <thead><tr><th>Week</th><th>Worker</th><th>Job</th><th class="num">Hours</th><th>Actions</th></tr></thead>
        <tbody>${visibleSheets.map((sheet) => {
          const worker = workers.find((item) => item.id === sheet.workerId);
          const job = jobs.find((item) => item.id === sheet.jobId);
          return `<tr>
            <td>${escH(displayDate(sheet.weekStart, true))} – ${escH(displayDate(sheet.weekEnd, true))}</td>
            <td>${escH(worker ? workerName(worker) : sheet.workerName)}</td>
            <td>${escH(job?.name || sheet.jobName)}${job ? "" : ' <span class="pill bad">Job deleted</span>'}</td>
            <td class="num">${Number(sheet.totalHours || 0).toFixed(2)}</td>
            <td class="row-actions">
              <button class="btn btn-primary small" data-download-all-timesheet="${escA(sheet.id)}">Download PDF</button>
              <button class="btn btn-ghost small danger" data-delete-all-timesheet="${escA(sheet.id)}">Delete</button>
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : `<div class="empty-state"><p>No timesheets found.</p></div>`}`;

    container.querySelector("#all-timesheet-worker").addEventListener("change", (event) => {
      selectedWorkerId = event.target.value;
      render();
    });
    container.querySelector("#show-inactive-workers").addEventListener("change", (event) => {
      showInactiveWorkers = event.target.checked;
      render();
    });
    container.querySelector("#all-timesheet-job").addEventListener("change", (event) => {
      selectedJobId = event.target.value;
      render();
    });
    container.querySelector("#show-completed-jobs").addEventListener("change", (event) => {
      showCompletedJobs = event.target.checked;
      render();
    });
    container.querySelector("#show-archived-jobs").addEventListener("change", (event) => {
      showArchivedJobs = event.target.checked;
      render();
    });
    container.querySelector("#new-main-timesheet").addEventListener("click", () => {
      const returnToAll = () => renderAllTimesheets(container);
      renderTimesheets(container, {
        startNew: true,
        onBack: returnToAll,
        onCancel: returnToAll,
        onSaved: returnToAll,
      });
    });
    container.querySelectorAll("[data-download-all-timesheet]").forEach((button) =>
      button.addEventListener("click", async () => {
        const sheet = sheets.find((item) => item.id === button.dataset.downloadAllTimesheet);
        if (!sheet) return;
        const worker = workers.find((item) => item.id === sheet.workerId);
        const job = jobs.find((item) => item.id === sheet.jobId);
        try {
          const result = await withLoading("Generating timesheet PDF…", () =>
            generateTimesheetPdf({
              ...sheet,
              workerName: sheet.workerName || (worker ? workerName(worker) : "Worker"),
              workerSnapshot: sheet.workerSnapshot || worker || {},
              jobSnapshot: sheet.jobSnapshot || job || { name: sheet.jobName },
            }));
          sheets = [result.sheet, ...sheets.filter((item) => item.id !== result.sheet.id)];
          sortSheets();
          downloadBlob(result.blob, result.fileName);
          message = "PDF saved in the Timesheets folder and downloaded.";
          render();
        } catch (error) {
          console.error(error);
          alert("PDF generation failed: " + (error.message || "unknown error"));
        }
      }));
    container.querySelectorAll("[data-delete-all-timesheet]").forEach((button) =>
      button.addEventListener("click", async () => {
        const sheet = sheets.find((item) => item.id === button.dataset.deleteAllTimesheet);
        if (!sheet || !confirmTimesheetDelete(sheet)) return;
        try {
          await withLoading("Deleting timesheet…", () => deleteTimesheet(sheet.id));
          sheets = sheets.filter((item) => item.id !== sheet.id);
          message = "Timesheet permanently deleted.";
          render();
        } catch (error) {
          console.error(error);
          alert("Delete failed: " + (error.message || "unknown error"));
        }
      }));
  }

  render();
}

export async function renderTimesheets(
  container,
  { workerId, startNew = false, onBack, onCancel, onSaved } = {},
) {
  container.innerHTML = `<p class="muted">Loading timesheets…</p>`;
  const [workers, jobs] = await Promise.all([
    listWorkers({ includeArchived: true }),
    listJobs({ includeArchived: true }),
  ]);
  let sheets = await listTimesheets();
  const activeWorkers = workers.filter((item) => item.status !== "Archived");
  const worker = activeWorkers.find((item) => item.id === workerId) || activeWorkers[0];
  if (!worker) {
    container.innerHTML = `<div class="page-head"><div>
      <button class="link-button back-link" id="timesheet-back">← Timesheets</button>
      <h2>New timesheet</h2>
    </div></div>
    <div class="banner">Create or reactivate a worker before adding a timesheet.</div>`;
    container.querySelector("#timesheet-back").addEventListener("click", () => onBack?.());
    return;
  }
  const activeJobs = jobs.filter((job) => (job.status || "Active") === "Active");
  if (startNew && !activeJobs.length) {
    container.innerHTML = header(worker, onBack) +
      `<div class="banner">Create or reactivate a job before adding a timesheet.</div>`;
    container.querySelector("#timesheet-back").addEventListener("click", () => onBack?.());
    return;
  }
  const matchingNameWorkers = workers.filter((item) =>
    workerName(item).toLowerCase() === workerName(worker).toLowerCase());
  const workerSheets = () => sheets.filter((sheet) =>
    sheet.workerId === worker.id
    || (!sheet.workerId && matchingNameWorkers.length === 1
      && sheet.workerName?.toLowerCase() === workerName(worker).toLowerCase()));
  let message = "";

  function renderList() {
    window.__quoteMeNavigationGuard = null;
    const saved = workerSheets();
    container.innerHTML = header(worker, onBack) + `
      <div class="section-head">
        <div><h3>Saved timesheets</h3><p class="muted">Timesheets for this worker across all jobs.</p></div>
        ${worker.status !== "Archived" && activeJobs.length
          ? `<button class="btn btn-primary" id="add-timesheet">+ New timesheet</button>`
          : ""}
      </div>
      ${!activeJobs.length ? `<div class="banner">Create or reactivate a job before adding a timesheet.</div>` : ""}
      ${message ? `<div class="banner success-banner">${escH(message)}</div>` : ""}
      ${saved.length ? `<div class="table-scroll"><table class="list">
        <thead><tr><th>Week</th><th>Job</th><th class="num">Hours</th><th>Actions</th></tr></thead>
        <tbody>${saved.map((sheet) => {
          const job = jobs.find((item) => item.id === sheet.jobId);
          return `<tr>
            <td>${escH(displayDate(sheet.weekStart, true))} – ${escH(displayDate(sheet.weekEnd, true))}</td>
            <td>${escH(job?.name || sheet.jobName)}${job ? "" : ' <span class="pill bad">Job deleted</span>'}</td>
            <td class="num">${Number(sheet.totalHours || 0).toFixed(2)}</td>
            <td class="row-actions">
              ${job ? `<button class="btn btn-ghost small" data-edit-timesheet="${escA(sheet.id)}">Edit</button>` : ""}
              <button class="btn btn-primary small" data-download-timesheet="${escA(sheet.id)}">Download PDF</button>
              <button class="btn btn-ghost small danger" data-delete-timesheet="${escA(sheet.id)}">Delete</button>
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : `<div class="empty-state"><p>No timesheets saved for this worker.</p></div>`}`;

    container.querySelector("#timesheet-back").addEventListener("click", () => onBack?.());
    container.querySelector("#add-timesheet")?.addEventListener("click", () =>
      renderForm({ jobId: activeJobs[0].id, weekStart: currentWeekStart() }));
    container.querySelectorAll("[data-edit-timesheet]").forEach((button) =>
      button.addEventListener("click", () => {
        const sheet = sheets.find((item) => item.id === button.dataset.editTimesheet);
        if (sheet) renderForm({ jobId: sheet.jobId, weekStart: sheet.weekStart });
      }));
    container.querySelectorAll("[data-download-timesheet]").forEach((button) =>
      button.addEventListener("click", async () => {
        const sheet = sheets.find((item) => item.id === button.dataset.downloadTimesheet);
        if (!sheet) return;
        try {
          const result = await withLoading("Generating timesheet PDF…", () =>
            generateTimesheetPdf({
              ...sheet,
              workerId: sheet.workerId || worker.id,
              workerName: sheet.workerName || workerName(worker),
              workerSnapshot: sheet.workerSnapshot || worker,
              jobSnapshot: sheet.jobSnapshot
                || jobs.find((job) => job.id === sheet.jobId)
                || { name: sheet.jobName },
            }));
          sheets = [result.sheet, ...sheets.filter((item) => item.id !== result.sheet.id)];
          downloadBlob(result.blob, result.fileName);
          message = "PDF saved in the Timesheets folder and downloaded.";
          renderList();
        } catch (error) {
          console.error(error);
          alert("PDF generation failed: " + (error.message || "unknown error"));
        }
      }));
    container.querySelectorAll("[data-delete-timesheet]").forEach((button) =>
      button.addEventListener("click", async () => {
        const sheet = sheets.find((item) => item.id === button.dataset.deleteTimesheet);
        if (!sheet || !confirmTimesheetDelete(sheet)) return;
        try {
          await withLoading("Deleting timesheet…", () => deleteTimesheet(sheet.id));
          sheets = sheets.filter((item) => item.id !== sheet.id);
          message = "Timesheet permanently deleted.";
          renderList();
        } catch (error) {
          console.error(error);
          alert("Delete failed: " + (error.message || "unknown error"));
        }
      }));
  }

  function renderForm({ jobId, weekStart }) {
    const selectedJob = jobs.find((job) => job.id === jobId);
    const existing = workerSheets().find((sheet) =>
      sheet.jobId === jobId && sheet.weekStart === weekStart) || null;
    if (!selectedJob || (!existing && (selectedJob.status || "Active") !== "Active")) {
      message = "Only active jobs can be selected for a new timesheet.";
      return renderList();
    }
    const selectableJobs = existing && (selectedJob.status || "Active") !== "Active"
      ? [selectedJob, ...activeJobs]
      : activeJobs;
    const days = existing?.days?.length === 7
      ? existing.days
      : DAY_NAMES.map((_, index) => ({ date: addDays(weekStart, index), hours: 0 }));

    container.innerHTML = header(worker, onBack) + `
      <div class="form-head"><div>
        <h2>${existing ? "Edit" : "New"} timesheet</h2>
        <p class="muted">${escH(workerName(worker))}</p>
      </div></div>
      <form id="timesheet-form" class="doc-form">
        <fieldset><legend>Job and week</legend>
          <div class="grid">
            <label class="f"><span>Worker</span><select id="timesheet-form-worker" required>
              ${activeWorkers.map((item) => `<option value="${escA(item.id)}" ${item.id === worker.id ? "selected" : ""}>
                ${escH(workerName(item))}
              </option>`).join("")}
            </select></label>
            <label class="f"><span>Job</span><select id="timesheet-job" required>
              ${selectableJobs.map((job) => `<option value="${escA(job.id)}" ${job.id === jobId ? "selected" : ""}>
                ${escH(job.name)}${job.status !== "Active" ? ` (${escH((job.status || "").toLowerCase())})` : ""}
              </option>`).join("")}
            </select></label>
          </div>
          <div class="week-picker">
            <button type="button" class="btn btn-ghost" id="previous-week">← Previous</button>
            <label class="f"><span>Week containing</span>
              <input type="date" id="week-date" value="${weekStart}"/>
            </label>
            <button type="button" class="btn btn-ghost" id="next-week">Next →</button>
            <button type="button" class="btn btn-ghost" id="this-week">This week</button>
            <strong>${displayDate(weekStart, true)} – ${displayDate(addDays(weekStart, 6), true)}</strong>
          </div>
        </fieldset>
        <fieldset><legend>Hours</legend>
          <div class="table-scroll"><table class="timesheet-grid">
            <thead><tr><th>Day</th><th>Date</th><th class="num">Hours</th></tr></thead>
            <tbody>${days.map((day, index) => `<tr>
              <td><strong>${DAY_NAMES[index]}</strong></td><td>${displayDate(day.date, true)}</td>
              <td class="num"><input class="hours-input" name="hours-${index}"
                value="${escA(formatHours(day.hours))}" inputmode="decimal" placeholder="0.00"/></td>
            </tr>`).join("")}</tbody>
            <tfoot><tr><td colspan="2">Total hours</td>
              <td class="num" id="week-total">${Number(existing?.totalHours || 0).toFixed(2)}</td></tr></tfoot>
          </table></div>
        </fieldset>
        <fieldset><legend>Weekly note</legend>
          <label class="f"><span>Optional summary of work completed</span>
            <textarea name="weeklyNote" rows="4">${escH(existing?.weeklyNote)}</textarea>
          </label>
        </fieldset>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="cancel-timesheet">Cancel</button>
          <button type="submit" class="btn btn-primary">Save timesheet</button>
        </div>
        <div class="save-status" id="timesheet-status"></div>
      </form>`;

    const form = container.querySelector("#timesheet-form");
    let dirty = false;
    const confirmLeave = () =>
      !dirty || confirm("Discard the unsaved changes to this timesheet?");
    window.__quoteMeNavigationGuard = confirmLeave;
    const leaveForm = (action) => {
      if (!confirmLeave()) return false;
      window.__quoteMeNavigationGuard = null;
      action();
      return true;
    };
    form.querySelectorAll(".hours-input, textarea[name=weeklyNote]").forEach((input) =>
      input.addEventListener("input", () => { dirty = true; }));
    container.querySelector("#timesheet-back").addEventListener("click", () =>
      leaveForm(() => onBack?.()));
    container.querySelector("#cancel-timesheet").addEventListener("click", () =>
      leaveForm(onCancel || renderList));
    container.querySelector("#timesheet-form-worker").addEventListener("change", (event) => {
      if (!leaveForm(() => renderTimesheets(container, {
        workerId: event.target.value,
        startNew: true,
        onBack,
        onCancel,
        onSaved,
      }))) {
        event.target.value = worker.id;
      }
    });
    container.querySelector("#timesheet-job").addEventListener("change", (event) => {
      if (!leaveForm(() => renderForm({ jobId: event.target.value, weekStart }))) {
        event.target.value = jobId;
      }
    });
    container.querySelector("#previous-week").addEventListener("click", () =>
      leaveForm(() => renderForm({ jobId, weekStart: addDays(weekStart, -7) })));
    container.querySelector("#next-week").addEventListener("click", () =>
      leaveForm(() => renderForm({ jobId, weekStart: addDays(weekStart, 7) })));
    container.querySelector("#this-week").addEventListener("click", () =>
      leaveForm(() => renderForm({ jobId, weekStart: currentWeekStart() })));
    container.querySelector("#week-date").addEventListener("change", (event) => {
      if (!event.target.value) return;
      if (!leaveForm(() => renderForm({ jobId, weekStart: weekStartFor(event.target.value) }))) {
        event.target.value = weekStart;
      }
    });
    form.querySelectorAll(".hours-input").forEach((input) =>
      input.addEventListener("input", () => updateTotal(form)));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const saved = await withLoading("Saving timesheet…", () => saveTimesheet({
          ...collectTimesheet(form, existing, selectedJob, worker, weekStart),
          docLink: "",
          pdfLink: "",
        }));
        sheets = [saved, ...sheets.filter((item) => item.id !== saved.id)];
        message = "Timesheet saved to Google Drive.";
        window.__quoteMeNavigationGuard = null;
        if (onSaved) onSaved(saved);
        else renderList();
      } catch (error) {
        console.error(error);
        container.querySelector("#timesheet-status").textContent =
          "⚠️ " + (error.message || "Save failed");
      }
    });
    updateTotal(form);
  }

  if (startNew) {
    renderForm({ jobId: activeJobs[0].id, weekStart: currentWeekStart() });
  } else {
    renderList();
  }
}

function header(worker) {
  return `<div class="page-head"><div>
    <button class="link-button back-link" id="timesheet-back">← Timesheets</button>
    <h2>Timesheets</h2><p class="muted">${escH(workerName(worker))}</p>
  </div></div>`;
}

function collectTimesheet(form, existing, job, worker, weekStart) {
  const days = DAY_NAMES.map((_, index) => {
    const raw = form.elements[`hours-${index}`].value.trim();
    if (raw && !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new Error(`${DAY_NAMES[index]} must be a number with no more than two decimal places.`);
    }
    const hundredths = raw ? Math.round(Number(raw) * 100) : 0;
    if (hundredths < 0 || hundredths > 2400) {
      throw new Error(`${DAY_NAMES[index]} must be between 0 and 24 hours.`);
    }
    return { date: addDays(weekStart, index), hours: hundredths / 100 };
  });
  const total = days.reduce((sum, day) => sum + Math.round(day.hours * 100), 0);
  if (!total) throw new Error("Enter hours for at least one day.");
  return {
    ...existing,
    jobId: job.id, jobName: job.name, jobSnapshot: job,
    workerId: worker.id, workerName: workerName(worker), workerSnapshot: worker,
    weekStart, weekEnd: addDays(weekStart, 6), days,
    totalHours: total / 100,
    weeklyNote: form.elements.weeklyNote.value.trim(),
  };
}

function updateTotal(form) {
  let total = 0;
  form.querySelectorAll(".hours-input").forEach((input) => {
    if (/^\d+(?:\.\d{0,2})?$/.test(input.value.trim())) {
      total += Math.round((Number(input.value) || 0) * 100);
    }
  });
  form.querySelector("#week-total").textContent = (total / 100).toFixed(2);
}

function confirmTimesheetDelete(sheet) {
  return confirm(
    `Permanently delete this timesheet?\n\n` +
    `${sheet.workerName || "Worker"} · ${sheet.jobName || "Job"} · ` +
    `${displayDate(sheet.weekStart, true)} – ${displayDate(sheet.weekEnd, true)}\n\n` +
    "This action cannot be undone.",
  );
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
