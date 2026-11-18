// Text and URL normalisation (SPEC §4.1, §4.2). Pure functions, no I/O.

/**
 * Comparison form of a text: Unicode NFC → trim → collapse internal
 * whitespace to one space → lower case (de-DE). No other folding
 * (no ä/ae, ß/ss, plural or fuzzy handling).
 */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("de-DE");
}

const DM_HOSTS: ReadonlySet<string> = new Set(["www.dm.de", "dm.de"]);

/**
 * Normalised dm product URL (SPEC §4.2): scheme https, host lower-cased,
 * `dm.de` mapped to `www.dm.de`, query string and fragment removed, trailing
 * slash removed, path otherwise kept as is.
 *
 * Returns `undefined` if the value is not an absolute http(s) URL on
 * `www.dm.de` or `dm.de`, if it carries credentials or a non-default port,
 * or if it is the dm start page (empty path after normalisation): different
 * products must never share an identifier through the start page.
 */
export function normalizeDmUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  // `host` is already lower-cased by the URL parser and includes a
  // non-default port, which is therefore rejected as well.
  if (!DM_HOSTS.has(url.host)) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") return undefined;
  return `https://www.dm.de${path}`;
}
