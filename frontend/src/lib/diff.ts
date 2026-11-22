import type { DiffLine, DiffResult } from "../api/types";

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses unified diff text (as produced by Python difflib) into the line model used by <DiffView>.
 * File headers are skipped only before the first hunk, so a removed line starting with "--" stays a removal.
 * Lines that are not part of the diff grammar (e.g. "… (diff сокращён)") are kept as notes.
 */
export function parseUnifiedDiff(text: string): DiffResult {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", old_no: null, new_no: null, text: raw });
      continue;
    }
    if (!inHunk) continue; // "--- a" / "+++ b" headers
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      additions += 1;
      lines.push({ kind: "add", old_no: null, new_no: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      deletions += 1;
      lines.push({ kind: "remove", old_no: oldNo++, new_no: null, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", old_no: oldNo++, new_no: newNo++, text: raw.slice(1) });
    } else if (raw.trim()) {
      lines.push({ kind: "hunk", old_no: null, new_no: null, text: raw });
    }
  }
  return { unified: text, lines, additions, deletions, changed: additions + deletions > 0 };
}
