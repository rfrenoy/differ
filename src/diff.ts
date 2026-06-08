export type DiffLineType = 'meta' | 'hunk' | 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** The raw text of the line, including its leading +/-/space marker. */
  text: string;
  /** Line number in the new (working-tree) file, when one applies. */
  newLine?: number;
  /** Line number in the old (HEAD) file, when one applies. */
  oldLine?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff for a single file into annotated lines. The annotation
 * we care about most is `newLine`: the line in the working-tree file that a
 * given diff row corresponds to, so the editor can be opened right there.
 */
export function parseDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let newLine = 0;
  let oldLine = 0;

  for (const text of raw.split('\n')) {
    // Drop the trailing empty element from a final newline.
    if (text === '' && out.length > 0) continue;

    const hunk = HUNK_RE.exec(text);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      out.push({ type: 'hunk', text });
      continue;
    }

    if (
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file') ||
      text.startsWith('similarity ') ||
      text.startsWith('rename ') ||
      text.startsWith('\\ No newline')
    ) {
      out.push({ type: 'meta', text });
      continue;
    }

    if (text.startsWith('+')) {
      out.push({ type: 'add', text, newLine });
      newLine++;
    } else if (text.startsWith('-')) {
      out.push({ type: 'del', text, oldLine });
      oldLine++;
    } else {
      // Context line (leading space), present in both versions.
      out.push({ type: 'context', text, newLine, oldLine });
      newLine++;
      oldLine++;
    }
  }

  return out;
}

/**
 * The diff row that best corresponds to working-tree line `target`. Prefers an
 * exact match; otherwise picks the row whose new-file line is closest, so the
 * cursor lands near the right place even when the diff shifted under it.
 * Returns 0 when nothing maps (e.g. an empty diff).
 */
export function rowForNewLine(lines: DiffLine[], target: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const n = lines[i].newLine;
    if (n === undefined) continue;
    const dist = Math.abs(n - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
    if (dist === 0) break;
  }
  return best === -1 ? 0 : best;
}

/**
 * Best-effort working-tree line number for the row at `index`. Falls back to
 * the nearest preceding row that maps to a new-file line (e.g. when the cursor
 * sits on a deletion, we aim at the surrounding context).
 */
export function newLineAt(lines: DiffLine[], index: number): number {
  for (let i = index; i >= 0; i--) {
    const n = lines[i]?.newLine;
    if (n !== undefined) return n;
  }
  for (const line of lines) {
    if (line.newLine !== undefined) return line.newLine;
  }
  return 1;
}
