import { gitDir, resolveRepo } from './git.js';
import { fetchPrDiff, resolvePr } from './gh.js';
import { parseDiff } from './diff.js';
import { validAnchors } from './anchor.js';
import {
  type DraftComment,
  type DraftFile,
  type Side,
  draftsPath,
  loadDrafts,
  saveDrafts,
  suggestionBody,
} from './comments.js';

/** One caller-supplied review comment to add as a draft. */
export interface Finding {
  path: string;
  /** End line of the anchor (file line: new-file for RIGHT, old-file for LEFT). */
  line: number;
  /** Start line for a multi-line anchor (e.g. a multi-line suggestion). */
  startLine?: number;
  /** Defaults to RIGHT (the new file) when omitted. */
  side?: Side;
  /** Comment text. Optional if `suggestion` is given. */
  body?: string;
  /** Replacement code; wrapped in a ```suggestion block (appended after body). */
  suggestion?: string;
}

export interface AddResult {
  added: number;
  updated: number;
  rejected: { finding: Finding; reason: string }[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate and coerce arbitrary parsed JSON into Findings, or throw. */
export function parseFindings(input: unknown): Finding[] {
  if (!Array.isArray(input)) {
    throw new Error('Expected a JSON array of findings.');
  }
  return input.map((raw, i) => {
    if (!isPlainObject(raw)) throw new Error(`findings[${i}] is not an object`);
    const { path, line, startLine, side, body, suggestion } = raw;
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`findings[${i}].path must be a non-empty string`);
    }
    if (!Number.isInteger(line)) throw new Error(`findings[${i}].line must be an integer`);
    if (startLine !== undefined && !Number.isInteger(startLine)) {
      throw new Error(`findings[${i}].startLine must be an integer`);
    }
    if (side !== undefined && side !== 'LEFT' && side !== 'RIGHT') {
      throw new Error(`findings[${i}].side must be "LEFT" or "RIGHT"`);
    }
    if (body !== undefined && typeof body !== 'string') {
      throw new Error(`findings[${i}].body must be a string`);
    }
    if (suggestion !== undefined && typeof suggestion !== 'string') {
      throw new Error(`findings[${i}].suggestion must be a string`);
    }
    if (body === undefined && suggestion === undefined) {
      throw new Error(`findings[${i}] needs a body or a suggestion`);
    }
    return {
      path,
      line: line as number,
      startLine: startLine as number | undefined,
      side: side as Side | undefined,
      body: body as string | undefined,
      suggestion: suggestion as string | undefined,
    };
  });
}

/**
 * Add findings as draft comments for PR `n`, validating each anchor against the
 * PR's diff (so un-postable comments are rejected up front rather than at submit
 * time). Merges into the existing drafts file, keyed by (path, side, line).
 */
export async function addComments(n: number, findings: Finding[]): Promise<AddResult> {
  await resolveRepo();
  const [info, files] = await Promise.all([resolvePr(n), fetchPrDiff(n)]);

  const validByPath = new Map<string, Set<string>>();
  for (const f of files) validByPath.set(f.path, validAnchors(parseDiff(f.raw)));

  const dpath = draftsPath(await gitDir(), n);
  const comments: DraftComment[] = loadDrafts(dpath)?.comments.slice() ?? [];

  const result: AddResult = { added: 0, updated: 0, rejected: [] };
  const reject = (finding: Finding, reason: string) => result.rejected.push({ finding, reason });

  for (const f of findings) {
    const side: Side = f.side ?? 'RIGHT';
    const valid = validByPath.get(f.path);
    if (!valid) {
      reject(f, `file is not part of PR #${n}'s diff: ${f.path}`);
      continue;
    }
    if (!valid.has(`${side} ${f.line}`)) {
      reject(f, `${f.path}:${f.line} (${side}) is not a line in the diff`);
      continue;
    }
    if (f.startLine !== undefined && !valid.has(`${side} ${f.startLine}`)) {
      reject(f, `${f.path}:${f.startLine} (${side}, start of range) is not a line in the diff`);
      continue;
    }

    let body = f.body ?? '';
    if (f.suggestion !== undefined) {
      body = (body ? `${body}\n\n` : '') + suggestionBody(f.suggestion);
    }
    if (body.trim().length === 0) {
      reject(f, 'empty comment body');
      continue;
    }

    const draft: DraftComment = {
      path: f.path,
      side,
      line: f.line,
      startLine: f.startLine !== undefined && f.startLine < f.line ? f.startLine : undefined,
      body,
      createdAt: new Date().toISOString(),
    };
    const idx = comments.findIndex(
      (c) => c.path === f.path && c.side === side && c.line === f.line,
    );
    if (idx >= 0) {
      comments[idx] = draft;
      result.updated++;
    } else {
      comments.push(draft);
      result.added++;
    }
  }

  saveDrafts(dpath, { pr: n, headSha: info.headRefOid, comments });
  return result;
}

/** The current drafts for PR `n` (empty shell if none yet). */
export async function listComments(n: number): Promise<DraftFile> {
  await resolveRepo();
  const dpath = draftsPath(await gitDir(), n);
  return loadDrafts(dpath) ?? { pr: n, headSha: '', comments: [] };
}
