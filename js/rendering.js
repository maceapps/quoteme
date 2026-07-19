let sequence = 0;

// Async renderers capture this predicate before loading data. A later render
// invalidates it, preventing an older response from replacing newer UI.
export function beginRender(container) {
  const token = String(++sequence);
  container.dataset.renderToken = token;
  return () => container.dataset.renderToken === token && !container.hidden;
}
