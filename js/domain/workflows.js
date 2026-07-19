export async function generateFilesWithCleanup({
  uploadDocument,
  exportPdf,
  cleanupFile,
}) {
  const doc = await uploadDocument();
  try {
    const pdf = await exportPdf(doc);
    return { doc, pdf };
  } catch (error) {
    try {
      await cleanupFile(doc);
    } catch {
      // Preserve the generation error; reconciliation can report orphan files.
    }
    throw error;
  }
}

export async function commitWithReconciliation({
  write,
  reconcile,
  cleanup,
  ambiguousMessage,
}) {
  try {
    await write();
    return;
  } catch (writeError) {
    let committed;
    try {
      committed = await reconcile();
    } catch (reconcileError) {
      throw new Error(ambiguousMessage, {
        cause: new AggregateError([writeError, reconcileError]),
      });
    }
    if (committed) return;
    await cleanup();
    throw writeError;
  }
}

export async function runDeletedStateChange({
  deleting,
  writeState,
  moveFiles,
  partialMessage,
}) {
  if (deleting) await writeState();
  try {
    await moveFiles();
  } catch (error) {
    throw new Error(partialMessage, { cause: error });
  }
  if (!deleting) await writeState();
}
