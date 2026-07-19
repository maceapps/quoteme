import { withLoading } from "./ui.js";
import {
  applyMigration, createMigrationBackup, inspectDataset, latestMigrationRun,
  loadMigrationRun, resumeMigration, rollbackMigration,
} from "./migration-engine.js";
import { escapeHtml } from "./security.js";

function migrationErrorMessage(error, fallback) {
  return (typeof error === "string" ? error : "")
    || error?.message
    || error?.result?.error?.message
    || error?.error?.message
    || error?.statusText
    || (typeof error?.body === "string" ? (() => {
      try { return JSON.parse(error.body)?.error?.message; } catch { return ""; }
    })() : "")
    || fallback;
}

export async function renderMigrationTools(container) {
  let inspection = null;
  let latest = null;
  try {
    latest = await latestMigrationRun();
  } catch (error) {
    console.warn("Could not read migration history", error);
  }

  const render = () => {
    const summary = inspection?.plan.summary;
    container.innerHTML = `
      <div class="page-head">
        <div>
          <h2>Data migration</h2>
          <p class="muted">Inspect and upgrade the Google Sheets data model with a Drive backup and recoverable checkpoints.</p>
        </div>
      </div>
      <div class="banner">
        Dry run is read-only. Apply always creates native copies of both spreadsheets before changing headers or rows.
      </div>
      ${latest ? `<div class="detail-list">
        <div class="detail-row"><div class="detail-label">Latest run</div><div class="detail-value">${escapeHtml(latest.runId)}</div></div>
        <div class="detail-row"><div class="detail-label">Status</div><div class="detail-value">${escapeHtml(latest.status)}</div></div>
        <div class="detail-row"><div class="detail-label">Checkpoint</div><div class="detail-value">${latest.checkpoint}</div></div>
      </div>` : ""}
      ${summary ? `<div class="cards">
        ${stat("Rows scanned", summary.scanned)}
        ${stat("Ready to migrate", summary.apply)}
        ${stat("Already current", summary.unchanged)}
        ${stat("Needs review", summary.quarantine, summary.quarantine ? "bad" : "ok")}
        ${stat("Blocking issues", summary.blocking, summary.blocking ? "bad" : "ok")}
      </div>
      <p class="muted">Plan hash: <code>${escapeHtml(inspection.plan.planHash)}</code></p>
      ${summary.quarantine ? `<div class="banner">
        ${summary.quarantine} row(s) are ambiguous and will be copied to Migration Quarantine without changing the source rows.
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th>Workbook</th><th>Tab</th><th>Row</th><th>Reference</th><th>Reason</th></tr></thead>
        <tbody>${inspection.plan.quarantined.map((item) => `<tr>
          <td>${escapeHtml(item.workbookRole)}</td>
          <td>${escapeHtml(item.tab)}</td>
          <td>${item.rowNumber}</td>
          <td>${escapeHtml(item.logicalKey)}</td>
          <td>${escapeHtml(item.reasons.join(", "))}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : ""}` : `<p class="muted">Run a dry inspection to build a migration plan. No live data will be changed.</p>`}
      ${summary?.blocking ? `<div class="banner">
        Migration is blocked: ${inspection.plan.blockingIssues.map((issue) =>
          escapeHtml(issue.message)).join("; ")}. Restore or rename the missing tabs, then inspect again.
      </div>` : ""}
      <div class="form-actions">
        <button class="btn btn-ghost" id="migration-dry-run">Run dry inspection</button>
        <button class="btn btn-primary" id="migration-apply"
          ${inspection && !summary.blocking ? "" : "disabled"}>Back up and apply</button>
        ${latest && ["BACKED_UP", "APPLYING", "QUARANTINED"].includes(latest.status)
          ? `<button class="btn btn-primary" id="migration-resume">${
              latest.status === "QUARANTINED" ? "Re-verify migration" : "Resume migration"
            }</button>`
          : ""}
        ${latest && latest.status !== "ROLLED_BACK"
          ? `<button class="btn btn-ghost danger" id="migration-rollback">Rollback latest run</button>`
          : ""}
      </div>
      <div class="save-status" id="migration-status"></div>`;
    wire();
  };

  const wire = () => {
    container.querySelector("#migration-dry-run").addEventListener("click", async () => {
      const status = container.querySelector("#migration-status");
      status.textContent = "Inspecting both workbooks…";
      try {
        inspection = await withLoading("Inspecting data…", () => inspectDataset());
        render();
      } catch (error) {
        console.error(error);
        status.textContent = "⚠️ " + migrationErrorMessage(error, "Inspection failed");
      }
    });

    container.querySelector("#migration-apply").addEventListener("click", async () => {
      if (!inspection) return;
      if (!confirm(
        "Create Drive backups and apply this migration plan?\n\n" +
        "Unambiguous rows will be upgraded. Ambiguous rows remain unchanged and are recorded for review.",
      )) return;
      const status = container.querySelector("#migration-status");
      try {
        const result = await withLoading("Backing up and migrating…", async () => {
          const run = await createMigrationBackup(inspection.plan);
          return applyMigration(run, {
            onProgress: ({ checkpoint, total }) => {
              status.textContent = `Migrating row ${checkpoint} of ${total}…`;
            },
          });
        });
        latest = await latestMigrationRun();
        inspection = null;
        render();
        container.querySelector("#migration-status").textContent =
          result.status === "VERIFIED"
            ? "✅ Migration verified successfully."
            : "⚠️ Safe rows were migrated; ambiguous rows require review.";
      } catch (error) {
        console.error(error);
        latest = await latestMigrationRun().catch(() => latest);
        render();
        container.querySelector("#migration-status").textContent =
          "⚠️ " + migrationErrorMessage(error, "Migration failed");
      }
    });

    container.querySelector("#migration-resume")?.addEventListener("click", async () => {
      const status = container.querySelector("#migration-status");
      try {
        const result = await withLoading("Resuming migration…", () =>
          resumeMigration(latest.runId, {
            onProgress: ({ checkpoint, total }) => {
              status.textContent = `Migrating row ${checkpoint} of ${total}…`;
            },
          }));
        latest = await latestMigrationRun();
        render();
        container.querySelector("#migration-status").textContent =
          result.status === "VERIFIED"
            ? "✅ Migration verified successfully."
            : "⚠️ Safe rows were migrated; ambiguous rows require review.";
      } catch (error) {
        console.error(error);
        status.textContent = "⚠️ " + migrationErrorMessage(error, "Resume failed");
      }
    });

    container.querySelector("#migration-rollback")?.addEventListener("click", async () => {
      if (!latest || !confirm(
        `Rollback ${latest.runId}?\n\nRollback stops if any migrated row has changed since the migration.`,
      )) return;
      const status = container.querySelector("#migration-status");
      try {
        const run = await loadMigrationRun(latest.runId);
        await withLoading("Rolling back migration…", () =>
          rollbackMigration(run, {
            onProgress: ({ checkpoint, total }) => {
              status.textContent = `Restoring row ${checkpoint} of ${total}…`;
            },
          }));
        latest = await latestMigrationRun();
        render();
        container.querySelector("#migration-status").textContent = "✅ Migration rolled back.";
      } catch (error) {
        console.error(error);
        status.textContent = "⚠️ " + migrationErrorMessage(error, "Rollback failed");
      }
    });
  };

  render();
}

function stat(label, value, tone = "") {
  return `<div class="card stat ${tone}"><div class="stat-val">${value}</div><div class="stat-lbl">${label}</div></div>`;
}
