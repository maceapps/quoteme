const GOOGLE_LINK_HOSTS = new Set(["docs.google.com", "drive.google.com"]);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

export function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

export function safeGoogleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && GOOGLE_LINK_HOSTS.has(url.hostname)
      ? url.href
      : "";
  } catch {
    return "";
  }
}
