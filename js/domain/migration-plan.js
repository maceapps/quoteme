import {
  CURRENT_SCHEMA_VERSION, REGISTER_SCHEMAS, TIMESHEET_SCHEMAS,
  decodeDataEnvelope, encodeDataEnvelope, fileIdFromDriveLink, headerIndex,
} from "./data-schema.js";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export async function hashValue(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalRow(row) {
  const values = [...(row || [])].map((value) => value ?? "");
  while (values.length && values.at(-1) === "") values.pop();
  return values;
}

export function hashRow(row) {
  return hashValue(canonicalRow(row));
}

export async function deterministicUuid(seed) {
  const hash = await hashValue(seed);
  const chars = hash.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = (parseInt(chars[16], 16) & 0x3 | 0x8).toString(16);
  const compact = chars.join("");
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

function setCell(row, index, name, value) {
  const position = index.get(name);
  if (position != null) row[position] = value ?? "";
}

function sameRow(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if ((left[index] ?? "") !== (right[index] ?? "")) return false;
  }
  return true;
}

function duplicateKeys(entries) {
  const counts = new Map();
  entries.forEach((entry) => counts.set(entry.logicalKey, (counts.get(entry.logicalKey) || 0) + 1));
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

async function sourceEntry(workbookRole, spreadsheetId, tab, rowNumber, headers, row) {
  const logicalKey = String(row[0] || "").trim();
  return {
    unitId: `${workbookRole}:${tab}:${logicalKey}:${rowNumber}`,
    workbookRole,
    spreadsheetId,
    tab,
    rowNumber,
    logicalKey,
    source: [...row],
    sourceHash: await hashRow(row),
    headers,
  };
}

async function collectEntries(workbookRole, workbook, tab) {
  const rows = workbook.tabs[tab] || [];
  const headers = rows[0] || [];
  const entries = [];
  for (let index = 1; index < rows.length; index++) {
    if (!String(rows[index][0] || "").trim()) continue;
    entries.push(await sourceEntry(
      workbookRole,
      workbook.spreadsheetId,
      tab,
      index + 1,
      headers,
      rows[index],
    ));
  }
  return entries;
}

function quarantine(entry, reasons, candidates = []) {
  const entityType = {
    Quotes: "quote",
    Invoices: "invoice",
    Jobs: "job",
    Workers: "worker",
    Timesheets: "timesheet",
  }[entry.tab] || "";
  return {
    ...entry,
    entityType,
    classification: "quarantine",
    reasons,
    candidates,
  };
}

async function targetOperation(entry, headers, target, entityType) {
  const normalizedTarget = headers.map((_, index) => target[index] ?? "");
  const targetHash = await hashRow(normalizedTarget);
  return {
    ...entry,
    entityType,
    classification: sameRow(entry.source, normalizedTarget) ? "unchanged" : "apply",
    target: normalizedTarget,
    targetHash,
    targetHeaders: headers,
  };
}

async function documentIdentityMaps(register, datasetId, references) {
  const maps = {};
  for (const tab of ["Quotes", "Invoices"]) {
    const entries = await collectEntries("register", register, tab);
    const duplicates = duplicateKeys(entries);
    const sourceHeaders = entries[0]?.headers || register.tabs[tab]?.[0] || [];
    const sourceIndex = headerIndex(sourceHeaders);
    const ids = new Map();
    for (const entry of entries) {
      if (duplicates.has(entry.logicalKey)) continue;
      const row = rowObject(sourceHeaders, entry.source);
      const decoded = decodeDataEnvelope(row.DataJSON, tab === "Quotes" ? "quote" : "invoice");
      if (decoded.error) continue;
      const jobId = row["Job ID"] || decoded.payload?.jobId || "";
      if (!references.jobIds.has(jobId)) continue;
      if (row.DocLink && !fileIdFromDriveLink(row.DocLink)) continue;
      if (row.PdfLink && !fileIdFromDriveLink(row.PdfLink)) continue;
      const id = entry.source[sourceIndex.get("Record ID")] || decoded.payload?.recordId
        || await deterministicUuid(`${datasetId}:${register.spreadsheetId}:${tab}:${entry.logicalKey}`);
      ids.set(entry.logicalKey, id);
    }
    maps[tab] = { entries, duplicates, ids };
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [tab, relationshipColumn, targetTab] of [
      ["Quotes", "Converted to Inv.", "Invoices"],
      ["Invoices", "Quote Ref", "Quotes"],
    ]) {
      for (const entry of maps[tab].entries) {
        if (!maps[tab].ids.has(entry.logicalKey)) continue;
        const source = rowObject(entry.headers, entry.source);
        const reference = source[relationshipColumn];
        if (reference && !maps[targetTab].ids.has(reference)) {
          maps[tab].ids.delete(entry.logicalKey);
          changed = true;
        }
      }
    }
  }
  return maps;
}

function buildReferenceContext(workbook) {
  const jobRows = workbook.tabs.Jobs || [];
  const workerRows = workbook.tabs.Workers || [];
  const jobHeaders = jobRows[0] || [];
  const workerHeaders = workerRows[0] || [];
  const jobs = jobRows.slice(1).filter((row) => row[0]);
  const workers = workerRows.slice(1).filter((row) => row[0]);
  const validJobs = jobs.filter((row) =>
    !decodeDataEnvelope(rowObject(jobHeaders, row).DataJSON, "job").error);
  const validWorkers = workers.filter((row) =>
    !decodeDataEnvelope(rowObject(workerHeaders, row).DataJSON, "worker").error);
  const jobCounts = new Map();
  const workerCounts = new Map();
  jobs.forEach((row) => jobCounts.set(String(row[0]), (jobCounts.get(String(row[0])) || 0) + 1));
  workers.forEach((row) =>
    workerCounts.set(String(row[0]), (workerCounts.get(String(row[0])) || 0) + 1));
  const validJobIdSet = new Set(validJobs.map((row) => String(row[0])));
  const validWorkerIdSet = new Set(validWorkers.map((row) => String(row[0])));
  const jobIds = new Set([...jobCounts]
    .filter(([id, count]) => count === 1 && validJobIdSet.has(id))
    .map(([id]) => id));
  const workerIds = new Set([...workerCounts]
    .filter(([id, count]) => count === 1 && validWorkerIdSet.has(id))
    .map(([id]) => id));
  const workersByName = new Map();
  for (const row of validWorkers) {
    const worker = rowObject(workerHeaders, row);
    const name = `${worker["First Name"] || ""} ${worker["Last Name"] || ""}`.trim().toLowerCase();
    if (name) workersByName.set(name, [...(workersByName.get(name) || []), String(row[0])]);
  }
  const legacyWorkersByJob = new Map();
  for (const row of validJobs) {
    const job = rowObject(jobHeaders, row);
    let ids = [];
    try { ids = JSON.parse(job["Legacy Worker IDs (unused)"] || "[]"); } catch {}
    if (!ids.length) {
      const decoded = decodeDataEnvelope(job.DataJSON, "job");
      if (Array.isArray(decoded.payload?.workerIds)) ids = decoded.payload.workerIds;
    }
    legacyWorkersByJob.set(String(row[0]), new Set(ids.map(String)));
  }
  return { jobIds, workerIds, workersByName, legacyWorkersByJob };
}

async function planDocuments(register, datasetId, migratedAt, references) {
  const maps = await documentIdentityMaps(register, datasetId, references);
  const operations = [];
  const quarantined = [];
  for (const tab of ["Quotes", "Invoices"]) {
    const entityType = tab === "Quotes" ? "quote" : "invoice";
    const canonicalHeaders = REGISTER_SCHEMAS[tab];
    const canonicalIndex = headerIndex(canonicalHeaders);
    const { entries, duplicates, ids } = maps[tab];
    for (const entry of entries) {
      if (duplicates.has(entry.logicalKey)) {
        quarantined.push(quarantine(entry, ["duplicate-human-number"]));
        continue;
      }
      const source = rowObject(entry.headers, entry.source);
      const decoded = decodeDataEnvelope(source.DataJSON, entityType);
      if (decoded.error || !decoded.payload) {
        quarantined.push(quarantine(entry, [decoded.error || "missing-payload"]));
        continue;
      }
      const payload = decoded.payload;
      const jobId = source["Job ID"] || payload.jobId || "";
      if (!jobId) {
        quarantined.push(quarantine(entry, ["missing-job-id"]));
        continue;
      }
      if (!references.jobIds.has(jobId)) {
        quarantined.push(quarantine(entry, ["unresolved-job-id"], [...references.jobIds]));
        continue;
      }
      const docFileId = source["Doc File ID"] || fileIdFromDriveLink(source.DocLink);
      const pdfFileId = source["PDF File ID"] || fileIdFromDriveLink(source.PdfLink);
      const reasons = [];
      if (source.DocLink && !docFileId) reasons.push("invalid-doc-link");
      if (source.PdfLink && !pdfFileId) reasons.push("invalid-pdf-link");
      let relationshipId = "";
      if (tab === "Invoices" && source["Quote Ref"]) {
        relationshipId = maps.Quotes.ids.get(source["Quote Ref"]) || "";
        if (!relationshipId) reasons.push("unresolved-source-quote");
      }
      if (tab === "Quotes" && source["Converted to Inv."]) {
        relationshipId = maps.Invoices.ids.get(source["Converted to Inv."]) || "";
        if (!relationshipId) reasons.push("unresolved-converted-invoice");
      }
      if (reasons.length) {
        quarantined.push(quarantine(entry, reasons));
        continue;
      }
      const target = [...entry.source];
      target.length = canonicalHeaders.length;
      const sourceIndex = headerIndex(entry.headers);
      const recordId = entry.source[sourceIndex.get("Record ID")] || ids.get(entry.logicalKey);
      setCell(target, canonicalIndex, "DataJSON", encodeDataEnvelope(entityType, payload));
      setCell(target, canonicalIndex, "Record ID", recordId);
      setCell(target, canonicalIndex, "Revision", Number(source.Revision) || 1);
      setCell(target, canonicalIndex, "Row Schema", CURRENT_SCHEMA_VERSION);
      setCell(target, canonicalIndex, "Job ID", jobId);
      setCell(target, canonicalIndex,
        tab === "Quotes" ? "Converted Invoice ID" : "Source Quote ID",
        relationshipId);
      setCell(target, canonicalIndex, "Doc File ID", docFileId);
      setCell(target, canonicalIndex, "PDF File ID", pdfFileId);
      setCell(target, canonicalIndex, "Created", source.Created || migratedAt);
      setCell(target, canonicalIndex, "Updated", source.Updated || migratedAt);
      setCell(target, canonicalIndex, "Deleted At", source["Deleted At"] || payload.deletedAt || "");
      operations.push(await targetOperation(entry, canonicalHeaders, target, entityType));
    }
  }
  return { operations, quarantined, documentMaps: maps };
}

async function planTimesheetWorkbook(workbook, references) {
  const operations = [];
  const quarantined = [];
  const definitions = [
    ["Jobs", "job"],
    ["Workers", "worker"],
    ["Timesheets", "timesheet"],
  ];
  for (const [tab, entityType] of definitions) {
    const entries = await collectEntries("timesheets", workbook, tab);
    const duplicates = duplicateKeys(entries);
    const canonicalHeaders = TIMESHEET_SCHEMAS[tab];
    const canonicalIndex = headerIndex(canonicalHeaders);
    for (const entry of entries) {
      if (duplicates.has(entry.logicalKey)) {
        quarantined.push(quarantine(entry, ["duplicate-record-id"]));
        continue;
      }
      const source = rowObject(entry.headers, entry.source);
      const decoded = decodeDataEnvelope(source.DataJSON, entityType);
      if (decoded.error || !decoded.payload) {
        quarantined.push(quarantine(entry, [decoded.error || "missing-payload"]));
        continue;
      }
      const payload = { ...decoded.payload };
      const target = [...entry.source];
      target.length = canonicalHeaders.length;
      setCell(target, canonicalIndex, "Revision", Number(source.Revision) || 1);
      setCell(target, canonicalIndex, "Row Schema", CURRENT_SCHEMA_VERSION);
      setCell(target, canonicalIndex, "Deleted At", source["Deleted At"] || decoded.payload.deletedAt || "");
      if (tab === "Timesheets") {
        const jobId = source["Job ID"] || payload.jobId || "";
        let workerId = source["Worker ID"] || payload.workerId || "";
        if (!workerId && source.Worker) {
          let candidates = references.workersByName
            .get(String(source.Worker).trim().toLowerCase()) || [];
          if (candidates.length > 1) {
            const assigned = references.legacyWorkersByJob.get(jobId) || new Set();
            candidates = candidates.filter((id) => assigned.has(id));
          }
          if (candidates.length === 1) {
            [workerId] = candidates;
            payload.workerId = workerId;
            setCell(target, canonicalIndex, "Worker ID", workerId);
          }
        }
        const docFileId = source["Doc File ID"] || fileIdFromDriveLink(source.DocLink);
        const pdfFileId = source["PDF File ID"] || fileIdFromDriveLink(source.PdfLink);
        const reasons = [];
        if (source.DocLink && !docFileId) reasons.push("invalid-doc-link");
        if (source.PdfLink && !pdfFileId) reasons.push("invalid-pdf-link");
        if (!jobId) reasons.push("missing-job-id");
        else if (!references.jobIds.has(jobId)) reasons.push("unresolved-job-id");
        if (!workerId) reasons.push("missing-worker-id");
        else if (!references.workerIds.has(workerId)) reasons.push("unresolved-worker-id");
        if (reasons.length) {
          quarantined.push(quarantine(entry, reasons));
          continue;
        }
        setCell(target, canonicalIndex, "Doc File ID", docFileId);
        setCell(target, canonicalIndex, "PDF File ID", pdfFileId);
      }
      setCell(target, canonicalIndex, "DataJSON", encodeDataEnvelope(entityType, payload));
      operations.push(await targetOperation(entry, canonicalHeaders, target, entityType));
    }
  }
  return { operations, quarantined };
}

export async function buildMigrationPlan({
  datasetId,
  register,
  timesheets,
  now = new Date().toISOString(),
}) {
  const references = buildReferenceContext(timesheets);
  const documents = await planDocuments(register, datasetId, now, references);
  const domain = await planTimesheetWorkbook(timesheets, references);
  const operations = [...documents.operations, ...domain.operations];
  const quarantined = [...documents.quarantined, ...domain.quarantined];
  const blockingIssues = [];
  for (const [role, workbook] of [["register", register], ["timesheets", timesheets]]) {
    for (const [tab, rows] of Object.entries(workbook.tabs)) {
      if (!rows.length) blockingIssues.push({
        code: "missing-entity-tab",
        workbookRole: role,
        tab,
        message: `${role} workbook is missing the ${tab} tab`,
      });
    }
  }
  const plan = {
    datasetId,
    fromVersion: 1,
    toVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    workbooks: {
      register: register.spreadsheetId,
      timesheets: timesheets.spreadsheetId,
    },
    sourceHeaders: {
      register: Object.fromEntries(Object.entries(register.tabs)
        .map(([tab, rows]) => [tab, rows[0] || []])),
      timesheets: Object.fromEntries(Object.entries(timesheets.tabs)
        .map(([tab, rows]) => [tab, rows[0] || []])),
    },
    operations,
    quarantined,
    blockingIssues,
    summary: {
      scanned: operations.length + quarantined.length,
      apply: operations.filter((operation) => operation.classification === "apply").length,
      unchanged: operations.filter((operation) => operation.classification === "unchanged").length,
      quarantine: quarantined.length,
      blocking: blockingIssues.length,
    },
  };
  return { ...plan, planHash: await hashValue(plan) };
}

export async function verifyOperation(operation, currentRow) {
  return {
    preimage: await hashRow(currentRow) === operation.sourceHash,
    postimage: await hashRow(currentRow) === operation.targetHash,
  };
}
