import { parseDiff } from './diff.js';
import { suggestionBody } from './comments.js';

/** A draft derived from editing the file: either a clickable suggestion or, when
 *  the edit falls outside the PR diff, a regular comment carrying the code. */
export interface DerivedDraft {
  side: 'RIGHT';
  /** First line of the anchor for a multi-line suggestion; omitted otherwise. */
  startLine?: number;
  line: number;
  body: string;
  kind: 'suggestion' | 'comment';
  /** The head line the edit was really about (for messaging). */
  about: number;
}

/** Closest value in `set` to `n` (used to re-anchor off-diff edits to a nearby diff line). */
function nearest(set: Set<number>, n: number): number {
  let best = n;
  let bestDist = Infinity;
  for (const v of set) {
    const d = Math.abs(v - n);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

function rangeLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

function offDiffReplaceBody(start: number, end: number, content: string): string {
  return `Suggested change for ${rangeLabel(start, end)} (outside this PR's diff):\n\n\`\`\`\n${content}\n\`\`\``;
}

function insertBody(after: number, content: string): string {
  return `Suggested insertion after line ${after}:\n\n\`\`\`\n${content}\n\`\`\``;
}

interface Run {
  dels: number[]; // head line numbers being replaced/removed
  adds: string[]; // new content lines (markers stripped)
  anchorBefore: number; // head line preceding the run (for pure insertions)
}

/**
 * Turn the diff of an edited working-tree file (head vs. the user's edits) into
 * draft suggestions. Each contiguous run of changed lines becomes one draft:
 *  - replacement/deletion whose head lines are all in the PR diff → a suggestion
 *  - anything else (off-diff edit, or a pure insertion) → a code-block comment
 *    anchored to the nearest in-diff line, so the edit is preserved, not dropped.
 *
 * `validRight` is the set of RIGHT-side (head-file) line numbers that are part
 * of the PR diff and can therefore carry an inline comment.
 */
export function deriveSuggestions(worktreeDiffRaw: string, validRight: Set<number>): DerivedDraft[] {
  const lines = parseDiff(worktreeDiffRaw);
  const drafts: DerivedDraft[] = [];
  let run: Run | null = null;
  let lastOld = 0; // most recent head-file line position

  const flush = () => {
    if (!run) return;
    const { dels, adds, anchorBefore } = run;
    run = null;
    if (dels.length === 0 && adds.length === 0) return;
    const content = adds.join('\n');

    if (dels.length > 0) {
      const start = dels[0];
      const end = dels[dels.length - 1];
      if (validRight.has(start) && validRight.has(end)) {
        drafts.push({
          side: 'RIGHT',
          startLine: start === end ? undefined : start,
          line: end,
          body: suggestionBody(content),
          kind: 'suggestion',
          about: start,
        });
      } else {
        drafts.push({
          side: 'RIGHT',
          line: nearest(validRight, end),
          body: offDiffReplaceBody(start, end, content),
          kind: 'comment',
          about: start,
        });
      }
      return;
    }

    // Pure insertion: suggestions can't cleanly insert without replacing, so we
    // record it as a code comment anchored at (or near) the preceding line.
    const target = validRight.has(anchorBefore) ? anchorBefore : nearest(validRight, anchorBefore);
    drafts.push({
      side: 'RIGHT',
      line: Math.max(1, target),
      body: insertBody(anchorBefore, content),
      kind: 'comment',
      about: anchorBefore,
    });
  };

  for (const ln of lines) {
    if (ln.type === 'del') {
      if (!run) run = { dels: [], adds: [], anchorBefore: lastOld };
      if (ln.oldLine !== undefined) {
        run.dels.push(ln.oldLine);
        lastOld = ln.oldLine;
      }
    } else if (ln.type === 'add') {
      if (!run) run = { dels: [], adds: [], anchorBefore: lastOld };
      run.adds.push(ln.text.slice(1));
    } else {
      flush();
      if (ln.type === 'context' && ln.oldLine !== undefined) lastOld = ln.oldLine;
    }
  }
  flush();
  return drafts;
}
