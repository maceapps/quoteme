import test from "node:test";
import assert from "node:assert/strict";

import {
  commitWithReconciliation, generateFilesWithCleanup, runDeletedStateChange,
} from "../js/domain/workflows.js";

test("PDF failure cleans up its generated document", async () => {
  const calls = [];
  const failure = new Error("PDF failed");
  await assert.rejects(generateFilesWithCleanup({
    uploadDocument: async () => {
      calls.push("upload");
      return { id: "doc-1" };
    },
    exportPdf: async () => {
      calls.push("export");
      throw failure;
    },
    cleanupFile: async () => calls.push("cleanup-doc"),
  }), failure);
  assert.deepEqual(calls, ["upload", "export", "cleanup-doc"]);
});

test("ambiguous commits reconcile before cleanup", async () => {
  const calls = [];
  await commitWithReconciliation({
    write: async () => {
      calls.push("write");
      throw new Error("connection lost");
    },
    reconcile: async () => {
      calls.push("reconcile");
      return true;
    },
    cleanup: async () => calls.push("cleanup"),
    ambiguousMessage: "Unknown save state",
  });
  assert.deepEqual(calls, ["write", "reconcile"]);
});

test("confirmed failed commits clean generated files", async () => {
  const calls = [];
  await assert.rejects(commitWithReconciliation({
    write: async () => {
      calls.push("write");
      throw new Error("write failed");
    },
    reconcile: async () => {
      calls.push("reconcile");
      return false;
    },
    cleanup: async () => calls.push("cleanup"),
    ambiguousMessage: "Unknown save state",
  }), /write failed/);
  assert.deepEqual(calls, ["write", "reconcile", "cleanup"]);
});

test("unreconciled commits preserve files and report ambiguity", async () => {
  const calls = [];
  await assert.rejects(commitWithReconciliation({
    write: async () => {
      calls.push("write");
      throw new Error("write failed");
    },
    reconcile: async () => {
      calls.push("reconcile");
      throw new Error("read failed");
    },
    cleanup: async () => calls.push("cleanup"),
    ambiguousMessage: "Unknown save state",
  }), /Unknown save state/);
  assert.deepEqual(calls, ["write", "reconcile"]);
});

test("delete and restore use safe opposite ordering", async () => {
  const deleted = [];
  await runDeletedStateChange({
    deleting: true,
    writeState: async () => deleted.push("state"),
    moveFiles: async () => deleted.push("files"),
    partialMessage: "Delete partial",
  });
  assert.deepEqual(deleted, ["state", "files"]);

  const restored = [];
  await runDeletedStateChange({
    deleting: false,
    writeState: async () => restored.push("state"),
    moveFiles: async () => restored.push("files"),
    partialMessage: "Restore partial",
  });
  assert.deepEqual(restored, ["files", "state"]);
});
