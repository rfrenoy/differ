import type { DiffLine } from './diff.js';
import { type Side, anchorKey } from './comments.js';

/** The anchor (side + file line) for a *new draft* on a diff row, if any. */
export function anchorForLine(line: DiffLine): { side: Side; line: number } | null {
  if (line.type === 'del') {
    return line.oldLine === undefined ? null : { side: 'LEFT', line: line.oldLine };
  }
  if (line.type === 'add' || line.type === 'context') {
    return line.newLine === undefined ? null : { side: 'RIGHT', line: line.newLine };
  }
  return null;
}

/**
 * Every anchor key a diff row can carry. Context lines exist on both sides, so
 * they can hold a comment keyed to either the old (LEFT) or new (RIGHT) line.
 */
export function lineAnchorKeys(line: DiffLine, path: string): string[] {
  const keys: string[] = [];
  if (line.type === 'del' && line.oldLine !== undefined) keys.push(anchorKey(path, 'LEFT', line.oldLine));
  if (line.type === 'add' && line.newLine !== undefined) keys.push(anchorKey(path, 'RIGHT', line.newLine));
  if (line.type === 'context') {
    if (line.newLine !== undefined) keys.push(anchorKey(path, 'RIGHT', line.newLine));
    if (line.oldLine !== undefined) keys.push(anchorKey(path, 'LEFT', line.oldLine));
  }
  return keys;
}

/**
 * The set of `(side, line)` positions a parsed diff can carry an inline comment
 * on — i.e. the lines GitHub will accept a comment/suggestion against. Keys are
 * `"<SIDE> <line>"`. Used to validate caller-supplied anchors (headless API).
 */
export function validAnchors(lines: DiffLine[]): Set<string> {
  const set = new Set<string>();
  for (const l of lines) {
    if ((l.type === 'add' || l.type === 'context') && l.newLine !== undefined) {
      set.add(`RIGHT ${l.newLine}`);
    }
    if ((l.type === 'del' || l.type === 'context') && l.oldLine !== undefined) {
      set.add(`LEFT ${l.oldLine}`);
    }
  }
  return set;
}
