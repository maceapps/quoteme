// ============================================================================
//  ui.js — a full-screen blocking loading overlay shared across the app.
//  Use withLoading() to wrap any action the user should wait for.
// ============================================================================
let overlayEl = null;
let count = 0; // supports overlapping/nested loads

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "loading-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML = `
    <div class="loading-box">
      <div class="spinner"></div>
      <div class="loading-msg"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

export function showLoading(message = "Working…") {
  const el = ensureOverlay();
  count += 1;
  el.querySelector(".loading-msg").textContent = message;
  el.hidden = false;
}

export function hideLoading() {
  count = Math.max(0, count - 1);
  if (count === 0 && overlayEl) overlayEl.hidden = true;
}

// Run an async action with the overlay shown until it settles.
export async function withLoading(message, fn) {
  showLoading(message);
  try {
    return await fn();
  } finally {
    hideLoading();
  }
}
