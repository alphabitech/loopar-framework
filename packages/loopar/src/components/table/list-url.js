/**
 * List state lives in the URL (filters, page, sort, report): helpers to read
 * it and to build the next URL. `url` is the workspace's current path with
 * its query (`useWorkspace().pathname`).
 */
export const queryOf = (url) => new URLSearchParams(String(url || "").split("?")[1] || "");

/** `url` with its query changed by `mutate(params)`. */
export function urlWith(url, mutate) {
  const [path] = String(url || "").split("?");
  const params = queryOf(url);
  mutate(params);
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}

export function sameUrl(a, b) {
  const path = (u) => String(u || "").split("?")[0];
  return path(a) === path(b) && queryOf(a).toString() === queryOf(b).toString();
}

/** Saves `text` as a file from the browser. */
export function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
