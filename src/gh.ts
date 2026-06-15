import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeKind, ChangedFile } from './git.js';

const pExecFile = promisify(execFile);

export interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author: string;
  url: string;
}

/** One file's section of a PR's aggregate diff. */
export interface PrFileDiff {
  path: string;
  kind: ChangeKind;
  /** Single-letter status used as the file-list marker. */
  code: string;
  /** The raw unified diff text for just this file. */
  raw: string;
}

/** Run `gh` and return stdout, turning failures into actionable errors. */
async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await pExecFile('gh', args, { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        'GitHub CLI (gh) not found. Install it from https://cli.github.com, then run `gh auth login`.',
      );
    }
    const stderr = (e.stderr ?? '').toString().trim();
    throw new Error(stderr || e.message || 'gh command failed');
  }
}

/** Look up PR metadata. Throws if gh is missing/unauthenticated or the PR is unknown. */
export async function resolvePr(n: number): Promise<PrInfo> {
  const json = await runGh([
    'pr',
    'view',
    String(n),
    '--json',
    'number,title,headRefName,headRefOid,baseRefName,author,url',
  ]);
  const data = JSON.parse(json) as {
    number: number;
    title: string;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    author?: { login?: string };
    url: string;
  };
  return {
    number: data.number,
    title: data.title,
    headRefName: data.headRefName,
    headRefOid: data.headRefOid,
    baseRefName: data.baseRefName,
    author: data.author?.login ?? '',
    url: data.url,
  };
}

/** Fetch the PR's aggregate (base...head) diff and split it per file. */
export async function fetchPrDiff(n: number): Promise<PrFileDiff[]> {
  const raw = await runGh(['pr', 'diff', String(n)]);
  return splitUnifiedDiff(raw);
}

/** URL of the base repository (where refs/pull/<n>/head lives, even for forks). */
export async function repoUrl(): Promise<string> {
  const json = await runGh(['repo', 'view', '--json', 'url']);
  return (JSON.parse(json) as { url: string }).url;
}

function unquotePath(p: string): string {
  const t = p.trim();
  // git quotes paths containing unusual characters in double quotes.
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Strip a leading a/ or b/ from a diff header path; /dev/null → undefined. */
function headerPath(raw: string): string | undefined {
  const p = unquotePath(raw);
  if (p === '/dev/null') return undefined;
  return p.replace(/^[ab]\//, '');
}

function parseFileSection(raw: string): PrFileDiff {
  const lines = raw.split('\n');
  let kind: ChangeKind = 'modified';
  let oldPath: string | undefined;
  let newPath: string | undefined;

  for (const l of lines) {
    if (l.startsWith('new file mode')) kind = 'added';
    else if (l.startsWith('deleted file mode')) kind = 'deleted';
    else if (l.startsWith('rename from') || l.startsWith('rename to')) kind = 'renamed';
    else if (l.startsWith('--- ')) oldPath = headerPath(l.slice(4));
    else if (l.startsWith('+++ ')) newPath = headerPath(l.slice(4));
  }

  // Fall back to the `diff --git a/… b/…` header when the file is empty (e.g.
  // a pure mode change has no ---/+++ lines).
  let path = newPath ?? oldPath;
  if (!path) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0] ?? '');
    if (m) path = unquotePath(m[2]);
  }

  const code =
    kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind === 'renamed' ? 'R' : 'M';
  return { path: path ?? '(unknown)', kind, code, raw };
}

/**
 * Split a multi-file unified diff into per-file sections. Pure function so it
 * can be tested without invoking gh. Each section starts at a `diff --git` line.
 */
export function splitUnifiedDiff(raw: string): PrFileDiff[] {
  const out: PrFileDiff[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (current) out.push(parseFileSection(current.join('\n')));
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return out;
}

/** Map PR file diffs into the ChangedFile shape the UI consumes. */
export function prChangedFiles(files: PrFileDiff[]): ChangedFile[] {
  return files
    .map((f) => ({ path: f.path, kind: f.kind, untracked: false, code: f.code }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
