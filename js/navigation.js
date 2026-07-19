const guards = new Set();

function hasDirtyForms() {
  return [...guards].some((guard) => guard.isDirty());
}

window.addEventListener("beforeunload", (event) => {
  if (!hasDirtyForms()) return;
  event.preventDefault();
  event.returnValue = "";
});

export function confirmNavigation() {
  return !hasDirtyForms() || confirm("Discard your unsaved changes?");
}

export function discardAllFormGuards() {
  for (const guard of [...guards]) guard.discard();
}

export function guardForm(form, {
  message = "Discard your unsaved changes?",
  dirtySelector = "input, textarea, select",
  onDiscard = null,
} = {}) {
  let dirty = false;
  let disposed = false;

  const markDirty = (event) => {
    if (event.target.matches(dirtySelector)) dirty = true;
  };
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);

  const controller = {
    isDirty: () => dirty && !disposed,
    markDirty: () => { if (!disposed) dirty = true; },
    markClean: () => { dirty = false; },
    confirmDiscard: () => !dirty || confirm(message),
    leave(action) {
      if (!controller.confirmDiscard()) return false;
      controller.dispose();
      action?.();
      return true;
    },
    discard() {
      controller.dispose();
      onDiscard?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dirty = false;
      form.removeEventListener("input", markDirty);
      form.removeEventListener("change", markDirty);
      guards.delete(controller);
    },
  };

  guards.add(controller);
  return controller;
}
