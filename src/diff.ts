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
