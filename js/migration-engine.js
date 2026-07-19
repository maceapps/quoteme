import {
  appendRow, applyWorkbookSchema, clearValues, copyDriveFile, deleteDriveFile, ensureSubFolder,
  findFilesExact, getDriveFileMetadata, getSpreadsheetTabs, readJsonFile, readRows,
  updateValues, uploadJsonFile,
} from "./google.js";
import { context } from "./store.js";
import {
  APP_SCHEMA_LABEL, CURRENT_SCHEMA_VERSION, MIGRATION_ID, SYSTEM_SCHEMAS,
  WORKBOOK_SCHEMAS,
} from "./domain/data-schema.js";
import {
  buildMigrationPlan, deterministicUuid, hashRow,
} from "./domain/migration-plan.js";

const ENTITY_TABS = {
  register: ["Quotes", "Invoices"],
  timesheets: ["Jobs", "Workers", "Timesheets"],
};

const isoNow = () => new Date().toISOString();

function columnLetter(index) {
  let output = "";
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    output = String.fromCharCode(65 + ((number - 1) % 26)) + output;
  }
  return output;
}

function workbookId(role) {
  const ctx = context();
  return role === "register" ? ctx.sheetId : ctx.timesheetsSheetId;
}

async function inspectMetadata(spreadsheetId) {
  const tabs = await getSpreadsheetTabs(spreadsheetId);
  if (!tabs.some((tab) => tab.title === "Metadata")) return {};
  const rows = await readRows(spreadsheetId, "Metadata");
  return Object.fromEntries(rows.slice(1)
    .filter((row) => row[0])
    .map((row) => [row[0], row[1] ?? ""]));
}

async function readEntityTabs(spreadsheetId, role) {
  const tabs = await getSpreadsheetTabs(spreadsheetId);
  const titles = new Set(tabs.map((tab) => tab.title));
  const entries = await Promise.all(ENTITY_TABS[role].map(async (tab) => [
    tab,
    titles.has(tab) ? await readRows(spreadsheetId, tab) : [],
  ]));
  return Object.fromEntries(entries);
}

async function upsertMetadata(spreadsheetId, key, value, data = {}) {
  const rows = await readRows(spreadsheetId, "Metadata");
  const row = [key, String(value), isoNow(), JSON.stringify(data)];
  const index = rows.findIndex((item, position) => position > 0 && item[0] === key);
  if (index < 0) await appendRow(spreadsheetId, "Metadata", row);
  else await updateValues(spreadsheetId, `Metadata!A${index + 1}:D${index + 1}`, [row]);
}

function ledgerRow(run, role, status, checkpoint, completed = "") {
  return [
    run.runId,
    MIGRATION_ID,
    run.plan.fromVersion,
    run.plan.toVersion,
    run.startedAt,
    completed,
    status,
    checkpoint,
    run.planFileId,
    run.backups[role],
    JSON.stringify({
      role,
      planHash: run.plan.planHash,
      backupFolderId: run.backupFolderId,
      summary: run.plan.summary,
    }),
  ];
}

async function writeLedger(run, role, status, checkpoint, completed = "") {
  const spreadsheetId = workbookId(role);
  const rows = await readRows(spreadsheetId, "Migrations");
  const values = ledgerRow(run, role, status, checkpoint, completed);
  const index = rows.findIndex((row, position) => position > 0 && row[0] === run.runId);
  if (index < 0) await appendRow(spreadsheetId, "Migrations", values);
  else {
    await updateValues(
      spreadsheetId,
      `Migrations!A${index + 1}:K${index + 1}`,
      [values],
    );
  }
}

async function appendQuarantine(run, item, reasons = item.reasons) {
  const spreadsheetId = workbookId(item.workbookRole);
  const reasonText = reasons.join(", ");
  const rows = await readRows(spreadsheetId, "Migration Quarantine");
  if (rows.slice(1).some((row) =>
    row[0] === run.runId
    && row[1] === item.workbookRole
    && row[2] === item.tab
    && String(row[3]) === String(item.rowNumber)
    && row[4] === item.logicalKey
    && row[5] === reasonText)) return;
  await appendRow(spreadsheetId, "Migration Quarantine", [
    run.runId,
    item.workbookRole,
    item.tab,
    item.rowNumber,
    item.logicalKey,
    reasonText,
    isoNow(),
    JSON.stringify({
      unitId: item.unitId,
      source: item.source,
      sourceHash: item.sourceHash,
      reasons,
      candidates: item.candidates || [],
    }),
  ]);
}

async function currentRow(operation) {
  const rows = await readRows(operation.spreadsheetId, operation.tab);
  const matches = rows
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter((item) => item.rowNumber > 1
      && String(item.row[0] || "").trim() === operation.logicalKey);
  return matches.length === 1 ? matches[0] : { row: null, rowNumber: 0, duplicate: matches.length > 1 };
}

async function rowState(operation, row) {
  if (!row) return "missing";
  const currentHash = await hashRow(row);
  const sourceMatch = currentHash === await hashRow(operation.source);
  const targetMatch = operation.target
    ? currentHash === await hashRow(operation.target)
    : false;
  if (sourceMatch && targetMatch) return "equivalent";
  if (sourceMatch) return "preimage";
  if (targetMatch) return "postimage";
  return "changed";
}

export async function inspectDataset() {
  const ctx = context();
  if (!ctx.sheetId || !ctx.timesheetsSheetId) throw new Error("Sign in before inspecting migrations.");
  const [registerTabs, timesheetTabs, registerMetadata, timesheetMetadata] = await Promise.all([
    readEntityTabs(ctx.sheetId, "register"),
    readEntityTabs(ctx.timesheetsSheetId, "timesheets"),
    inspectMetadata(ctx.sheetId),
    inspectMetadata(ctx.timesheetsSheetId),
  ]);
  if (registerMetadata["dataset.id"]
    && timesheetMetadata["dataset.id"]
    && registerMetadata["dataset.id"] !== timesheetMetadata["dataset.id"]) {
    throw new Error(
      "The register and timesheet workbooks have different dataset IDs. Reconcile them before migration.",
    );
  }
  const existingDatasetId = registerMetadata["dataset.id"] || timesheetMetadata["dataset.id"];
  const datasetId = existingDatasetId
    || await deterministicUuid(`${ctx.sheetId}:${ctx.timesheetsSheetId}`);
  const plan = await buildMigrationPlan({
    datasetId,
    register: { spreadsheetId: ctx.sheetId, tabs: registerTabs },
    timesheets: { spreadsheetId: ctx.timesheetsSheetId, tabs: timesheetTabs },
  });
  return {
    plan,
    metadata: { register: registerMetadata, timesheets: timesheetMetadata },
  };
}

export async function createMigrationBackup(plan) {
  if (plan.blockingIssues?.length) {
    throw new Error("Migration is blocked until missing entity tabs are restored.");
  }
  const ctx = context();
  const runId = `MIG-${plan.planHash.slice(0, 16)}`;
  const startedAt = plan.createdAt;
  const backupRoot = await ensureSubFolder("Migration Backups", ctx.folderId);
  const backupFolderId = await ensureSubFolder(runId, backupRoot);
  const properties = { quoteMeMigrationRun: runId };
  const planName = `${runId} — migration-plan.json`;
  const existingPlans = await findFilesExact(planName, {
    mimeType: "application/json",
    parentId: backupFolderId,
  });
  if (existingPlans.length > 1) throw new Error(`Duplicate migration plans found for ${runId}.`);
  if (existingPlans.length === 1) {
    const manifest = await readJsonFile(existingPlans[0].id);
    const backupMetadata = await Promise.all([
      getDriveFileMetadata(manifest.backups?.register),
      getDriveFileMetadata(manifest.backups?.timesheets),
    ]);
    if (backupMetadata.some((file) =>
      file.trashed || file.mimeType !== "application/vnd.google-apps.spreadsheet")) {
      throw new Error(`Migration backups for ${runId} are missing or invalid.`);
    }
    return {
      ...manifest,
      planFileId: existingPlans[0].id,
      backupFolderId,
    };
  }
  const backupNames = {
    register: `${runId} — Register backup`,
    timesheets: `${runId} — Timesheets backup`,
  };
  const existingCopies = await Promise.all(Object.entries(backupNames).map(async ([role, name]) => {
    const files = await findFilesExact(name, {
      mimeType: "application/vnd.google-apps.spreadsheet",
      parentId: backupFolderId,
    });
    if (files.length > 1) throw new Error(`Duplicate ${role} backups found for ${runId}.`);
    return files[0] || null;
  }));
  if (existingCopies.some(Boolean)) {
    await Promise.all(existingCopies.filter(Boolean).map((file) => deleteDriveFile(file.id)));
  }
  const [registerBackup, timesheetsBackup] = await Promise.all([
    copyDriveFile(ctx.sheetId, backupNames.register, backupFolderId, properties),
    copyDriveFile(ctx.timesheetsSheetId, backupNames.timesheets, backupFolderId, properties),
  ]);
  const manifest = {
    runId,
    startedAt,
    migrationId: MIGRATION_ID,
    plan,
    backups: {
      register: registerBackup.id,
      timesheets: timesheetsBackup.id,
    },
  };
  const planFile = await uploadJsonFile(
    planName,
    manifest,
    backupFolderId,
    properties,
  );
  return {
    ...manifest,
    planFileId: planFile.id,
    backupFolderId,
  };
}

async function provisionMigrationSchema(run) {
  await Promise.all([
    applyWorkbookSchema(workbookId("register"), WORKBOOK_SCHEMAS.register),
    applyWorkbookSchema(workbookId("timesheets"), WORKBOOK_SCHEMAS.timesheets),
  ]);
  for (const role of ["register", "timesheets"]) {
    const spreadsheetId = workbookId(role);
    const ledger = await readRows(spreadsheetId, "Migrations");
    if (ledger.slice(1).some((row) => row[0] === run.runId)) {
      continue;
    }
    await upsertMetadata(spreadsheetId, "dataset.id", run.plan.datasetId);
    await upsertMetadata(spreadsheetId, "workbook.role", role);
    await upsertMetadata(spreadsheetId, "schema.version", run.plan.fromVersion);
    await upsertMetadata(spreadsheetId, "schema.target", run.plan.toVersion);
    await upsertMetadata(spreadsheetId, "app.schema", APP_SCHEMA_LABEL);
    await upsertMetadata(spreadsheetId, "peer.spreadsheet.id",
      workbookId(role === "register" ? "timesheets" : "register"));
    await writeLedger(run, role, "BACKED_UP", 0);
  }
}

async function migrationRunExists(runId) {
  for (const role of ["register", "timesheets"]) {
    const spreadsheetId = workbookId(role);
    const tabs = await getSpreadsheetTabs(spreadsheetId);
    if (!tabs.some((tab) => tab.title === "Migrations")) continue;
    const rows = await readRows(spreadsheetId, "Migrations");
    if (rows.slice(1).some((row) => row[0] === runId)) return true;
  }
  return false;
}

async function datasetShapeIssues(run, useTargets) {
  const issues = [];
  const allItems = [...run.plan.operations, ...run.plan.quarantined];
  for (const role of ["register", "timesheets"]) {
    for (const tab of ENTITY_TABS[role]) {
      const current = (await readRows(workbookId(role), tab)).slice(1)
        .filter((row) => String(row[0] || "").trim());
      const expectedItems = allItems.filter((item) =>
        item.workbookRole === role && item.tab === tab);
      const expectedHashes = await Promise.all(expectedItems.map((item) =>
        hashRow(useTargets && item.target ? item.target : item.source)));
      const currentHashes = await Promise.all(current.map(hashRow));
      if (expectedHashes.sort().join(":") !== currentHashes.sort().join(":")) {
        issues.push({ workbookRole: role, tab, state: "dataset-shape-changed" });
      }
    }
  }
  return issues;
}

export async function applyMigration(run, { onProgress = () => {} } = {}) {
  if (run.plan.blockingIssues?.length) {
    throw new Error("Migration is blocked until missing entity tabs are restored.");
  }
  const resumed = await migrationRunExists(run.runId);
  if (!resumed) {
    const staleIssues = await datasetShapeIssues(run, false);
    if (staleIssues.length) {
      throw new Error("The dataset changed after inspection. Run a new dry inspection.");
    }
  }
  await provisionMigrationSchema(run);
  for (const item of run.plan.quarantined) await appendQuarantine(run, item);

  const applicable = run.plan.operations.filter((operation) =>
    operation.classification === "apply");
  let checkpoint = 0;
  for (const operation of applicable) {
    const current = await currentRow(operation);
    const state = current.duplicate
      ? "duplicate"
      : await rowState(operation, current.row);
    if (state === "postimage" || state === "equivalent") {
      checkpoint += 1;
      continue;
    }
    if (state !== "preimage") {
      await appendQuarantine(run, operation, [`concurrent-${state}`]);
      checkpoint += 1;
      continue;
    }
    await writeLedger(run, operation.workbookRole, "APPLYING", checkpoint);
    const endColumn = columnLetter(operation.target.length - 1);
    await updateValues(
      operation.spreadsheetId,
      `${operation.tab}!A${current.rowNumber}:${endColumn}${current.rowNumber}`,
      [operation.target],
    );
    const written = await currentRow(operation);
    if (!["postimage", "equivalent"].includes(await rowState(operation, written.row))) {
      throw new Error(`Could not verify migrated row ${operation.unitId}.`);
    }
    checkpoint += 1;
    await writeLedger(run, operation.workbookRole, "APPLYING", checkpoint);
    onProgress({ checkpoint, total: applicable.length, operation });
  }

  const verification = await verifyMigration(run);
  const status = verification.ok && !verification.quarantineCount
    ? "VERIFIED"
    : "QUARANTINED";
  const completed = isoNow();
  for (const role of ["register", "timesheets"]) {
    await writeLedger(run, role, status, checkpoint, completed);
    await upsertMetadata(workbookId(role), "migration.state", status, {
      runId: run.runId,
      verification,
    });
    if (status === "VERIFIED") {
      await upsertMetadata(
        workbookId(role),
        "schema.version",
        CURRENT_SCHEMA_VERSION,
      );
    }
  }
  return { status, verification };
}

export async function verifyMigration(run) {
  const issues = await datasetShapeIssues(run, true);
  for (const operation of run.plan.operations) {
    const current = await currentRow(operation);
    const state = current.duplicate
      ? "duplicate"
      : await rowState(operation, current.row);
    const valid = state === "postimage"
      || state === "equivalent"
      || (operation.classification === "unchanged" && state === "preimage");
    if (!valid) {
      issues.push({ unitId: operation.unitId, state });
    }
  }
  for (const item of run.plan.quarantined) {
    const current = await currentRow(item);
    const state = current.duplicate ? "duplicate" : await rowState(item, current.row);
    if (state !== "preimage") issues.push({ unitId: item.unitId, state: `quarantine-${state}` });
  }
  return {
    ok: issues.length === 0,
    issues,
    quarantineCount: run.plan.quarantined.length
      + issues.filter((issue) => issue.state !== "postimage").length,
  };
}

export async function rollbackMigration(run, { onProgress = () => {} } = {}) {
  const operations = run.plan.operations
    .filter((operation) => operation.classification === "apply")
    .reverse();
  const allItems = [...run.plan.operations, ...run.plan.quarantined];
  for (const role of ["register", "timesheets"]) {
    for (const [tab, headers] of Object.entries(run.plan.sourceHeaders[role])) {
      const rows = await readRows(workbookId(role), tab);
      const currentHeaders = rows[0] || [];
      const canonical = WORKBOOK_SCHEMAS[role][tab];
      const originalHeaders = await hashRow(currentHeaders) === await hashRow(headers);
      const migratedHeaders = await hashRow(currentHeaders) === await hashRow(canonical);
      if (!originalHeaders && !migratedHeaders) {
        throw new Error(`Rollback stopped because the ${tab} headers changed after migration.`);
      }
      const expectedCount = allItems.filter((item) =>
        item.workbookRole === role && item.tab === tab).length;
      const currentCount = rows.slice(1).filter((row) => String(row[0] || "").trim()).length;
      if (expectedCount !== currentCount) {
        throw new Error(`Rollback stopped because rows were added to or removed from ${tab}.`);
      }
    }
  }
  for (const operation of run.plan.operations) {
    const current = await currentRow(operation);
    const state = current.duplicate ? "duplicate" : await rowState(operation, current.row);
    if (!["preimage", "postimage", "equivalent"].includes(state)) {
      throw new Error(`Rollback stopped because ${operation.unitId} changed after migration.`);
    }
  }
  const quarantineGroups = new Map();
  for (const item of run.plan.quarantined) {
    const key = `${item.workbookRole}:${item.tab}`;
    quarantineGroups.set(key, [...(quarantineGroups.get(key) || []), item]);
  }
  for (const items of quarantineGroups.values()) {
    const [{ workbookRole, tab }] = items;
    const keys = new Set(items.map((item) => item.logicalKey));
    const rows = (await readRows(workbookId(workbookRole), tab)).slice(1)
      .filter((row) => keys.has(String(row[0] || "").trim()));
    const currentHashes = (await Promise.all(rows.map(hashRow))).sort();
    const expectedHashes = (await Promise.all(items.map((item) => hashRow(item.source)))).sort();
    if (currentHashes.join(":") !== expectedHashes.join(":")) {
      throw new Error(`Rollback stopped because quarantined rows in ${tab} changed.`);
    }
  }
  let checkpoint = 0;
  for (const operation of operations) {
    const current = await currentRow(operation);
    const state = current.duplicate
      ? "duplicate"
      : await rowState(operation, current.row);
    if (state === "preimage" || state === "equivalent") {
      checkpoint += 1;
      continue;
    }
    if (state !== "postimage") {
      throw new Error(`Rollback stopped because ${operation.unitId} changed after migration.`);
    }
    const endColumn = columnLetter(operation.target.length - 1);
    await clearValues(
      operation.spreadsheetId,
      `${operation.tab}!A${current.rowNumber}:${endColumn}${current.rowNumber}`,
    );
    if (operation.source.length) {
      const sourceEnd = columnLetter(operation.source.length - 1);
      await updateValues(
        operation.spreadsheetId,
        `${operation.tab}!A${current.rowNumber}:${sourceEnd}${current.rowNumber}`,
        [operation.source],
      );
    }
    const restored = await currentRow(operation);
    if (!["preimage", "equivalent"].includes(await rowState(operation, restored.row))) {
      throw new Error(`Could not verify rollback for ${operation.unitId}.`);
    }
    checkpoint += 1;
    onProgress({ checkpoint, total: operations.length, operation });
  }
  for (const role of ["register", "timesheets"]) {
    for (const [tab, headers] of Object.entries(run.plan.sourceHeaders[role])) {
      const canonical = WORKBOOK_SCHEMAS[role][tab];
      const currentHeaders = (await readRows(workbookId(role), tab))[0] || [];
      if (await hashRow(currentHeaders) === await hashRow(headers)) continue;
      if (await hashRow(currentHeaders) !== await hashRow(canonical)) {
        throw new Error(`Rollback stopped because the ${tab} headers changed after migration.`);
      }
      await clearValues(
        workbookId(role),
        `${tab}!A1:${columnLetter(canonical.length - 1)}1`,
      );
      if (headers.length) await updateValues(workbookId(role), `${tab}!A1`, [headers]);
    }
  }
  for (const role of ["register", "timesheets"]) {
    await upsertMetadata(workbookId(role), "schema.version", run.plan.fromVersion);
    await upsertMetadata(workbookId(role), "migration.state", "ROLLED_BACK", {
      runId: run.runId,
    });
    await writeLedger(run, role, "ROLLED_BACK", checkpoint, isoNow());
  }
  return { status: "ROLLED_BACK", checkpoint };
}

export async function loadMigrationRun(runId) {
  const rows = await readRows(workbookId("register"), "Migrations");
  const row = rows.find((item, index) => index > 0 && item[0] === runId);
  if (!row) throw new Error("Migration run could not be found.");
  const manifest = await readJsonFile(row[8]);
  return {
    ...manifest,
    planFileId: row[8],
    backupFolderId: JSON.parse(row[10] || "{}").backupFolderId,
  };
}

export async function resumeMigration(runId, options = {}) {
  return applyMigration(await loadMigrationRun(runId), options);
}

export async function latestMigrationRun() {
  const tabs = await getSpreadsheetTabs(workbookId("register"));
  if (!tabs.some((tab) => tab.title === "Migrations")) return null;
  const rows = await readRows(workbookId("register"), "Migrations");
  const row = rows.at(-1);
  if (!row || row[0] === SYSTEM_SCHEMAS.Migrations[0]) return null;
  return {
    runId: row[0],
    status: row[6],
    checkpoint: Number(row[7]) || 0,
    planFileId: row[8],
    data: JSON.parse(row[10] || "{}"),
  };
}

export async function findBackupRun(runId) {
  const ctx = context();
  const rootMatches = await findFilesExact("Migration Backups", {
    mimeType: "application/vnd.google-apps.folder",
    parentId: ctx.folderId,
  });
  if (rootMatches.length !== 1) return null;
  const matches = await findFilesExact(runId, {
    mimeType: "application/vnd.google-apps.folder",
    parentId: rootMatches[0].id,
  });
  return matches.length === 1 ? matches[0] : null;
}
