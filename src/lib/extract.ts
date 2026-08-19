// The pure extraction heuristic (issue 17, Seam 2) — a chrome-stripping
// heuristic (ported from the reference `wayfinder` plugin's
// `last_meaningful_line`) that pulls the last line of real agent content out of
// a terminal snapshot, skipping TUI chrome, box-drawing status bars, and
// spinners. No IO — the write-back path that uses it lives in ./ingester.ts.

/** Chrome markers that disqualify a line — TUI key hints and status chrome. */
const CHROME_MARKERS: readonly string[] = [
  "esc interrupt",
  "ctrl+p",
  "manual mode",
  "baked for",
  "cooked for",
  "commands",
  "alt+",
  "opencode zen",
];

/** Box-drawing / full-width status-bar glyphs (wayfinder's set). */
const BLOCKY = /[┃╹▀▄█─│║╔╗╚╝┌┐└┘■▪·✕×⬝⬛▮▯▰▱]/;

/** A line must contain a real word to be agent content. */
const WORD_RE = /[a-z0-9]{3,}/i;

/** Leading spinner/whitespace to strip off an otherwise meaningful line. */
const SPINNER_RE = /^[\s⠁-⠿]+/;

const WHITESPACE_RE = /\s+/g;

/** Lines longer than this are status/chrome, not content. */
export const MAX_MEANINGFUL_LINE_LEN = 240;

/** The result budget (wayfinder truncates to 200 chars). */
export const MAX_RESULT_LEN = 200;

/**
 * The last line of real agent content in a terminal snapshot, chrome-stripped
 * (Seam 2 — pure). Walks lines from the end: empty lines, over-long lines,
 * chrome-marker lines, and heavy box-drawing lines are skipped; a candidate's
 * spinner prefix is stripped and internal whitespace collapsed; the result is
 * truncated to the 200-char budget. Null when nothing meaningful survives.
 */
export function extractResult(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_MEANINGFUL_LINE_LEN) continue;
    const lower = trimmed.toLowerCase();
    if (CHROME_MARKERS.some((m) => lower.includes(m))) continue;
    let boxCount = 0;
    for (const _ of trimmed.match(BLOCKY) ?? []) boxCount++;
    if (boxCount / trimmed.length > 0.2) continue;
    // A framed status bar (`│ opencode · idle · 00:12 │`) — boxy edges at both
    // ends, however light the bar. The 20% ratio alone misses it, so a line
    // that opens AND closes on a box glyph is chrome regardless of density.
    if (BLOCKY.test(trimmed[0]!) && BLOCKY.test(trimmed[trimmed.length - 1]!)) continue;
    if (!WORD_RE.test(trimmed)) continue;
    const normalized = trimmed.replace(SPINNER_RE, "").replace(WHITESPACE_RE, " ").trim();
    if (!normalized) continue;
    return normalized.length <= MAX_RESULT_LEN ? normalized : normalized.slice(0, MAX_RESULT_LEN);
  }
  return null;
}