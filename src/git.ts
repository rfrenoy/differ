import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  /** Path relative to the repo root. For renames, the new path. */
  path: string;
  kind: ChangeKind;
  /** True when the file has no committed counterpart to diff against. */
  untracked: boolean;
  /** Short status code from git, e.g. " M", "??", "A ". */
  code: string;
}

export interface Repo {
  root: string;
  hasHead: boolean;
}

// Bound to the current directory at startup; re-pinned to the repo root by
// resolveRepo so that `status` and `diff` always run from the same base.
// Otherwise, running differ from a subdirectory makes git status report
// root-relative paths while diff resolves them against the subdir, yielding
// empty diffs.
let git: SimpleGit = simpleGit();
// Repo root, captured by resolveRepo; needed for synchronous worktree cleanup.
let repoRoot = '';

export async function resolveRepo(): Promise<Repo> {
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not inside a git repository.');
  }
  const root = (await git.revparse(['--show-toplevel'])).trim();
  // Re-pin every subsequent git command to the repo root.
  git = simpleGit(root);
  repoRoot = root;
  let hasHead = true;
  try {
    await git.revparse(['HEAD']);
  } catch {
    hasHead = false;
  }
  return { root, hasHead };
}

/** Absolute path to the repo's git directory (for storing differ's own state). */
export async function gitDir(): Promise<string> {
  return (await git.revparse(['--absolute-git-dir'])).trim();
}

function kindFromCode(code: string): ChangeKind {
  const c = code.trim();
  if (code === '??') return 'untracked';
  if (c.includes('R')) return 'renamed';
  if (c.includes('D')) return 'deleted';
  if (c.includes('A')) return 'added';
  return 'modified';
}

/** All files that differ from HEAD (staged + unstaged), plus untracked files. */
export async function listChangedFiles(): Promise<ChangedFile[]> {
  const status = await git.status();
  const files: ChangedFile[] = status.files.map((f) => {
    const code = `${f.index}${f.working_dir}`;
    const untracked = code === '??';
    return {
      path: f.path,
      kind: kindFromCode(code),
      untracked,
      code,
    };
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Raw unified diff for a single file, comparing the working tree against HEAD
 * so both staged and unstaged edits show up. Untracked files are rendered as
 * an all-additions diff against /dev/null.
 */
export async function diffForFile(file: ChangedFile, hasHead: boolean): Promise<string> {
  if (file.untracked) {
    return git.diff(['--no-color', '--no-index', '--', '/dev/null', file.path]).catch(
      // --no-index exits 1 when there is a diff; simple-git treats that as an
      // error, but the stdout it captured is still the diff we want.
      (err: { stdout?: string }) => err.stdout ?? '',
    );
  }
  const args = hasHead
    ? ['--no-color', 'HEAD', '--', file.path]
    : ['--no-color', '--', file.path];
  return git.diff(args);
}

export interface CommitInfo {
  /** The ref as the user typed it, e.g. "HEAD~3". */
  ref: string;
  /** Full resolved SHA. */
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** False for a root commit (diff against the empty tree instead of `^`). */
  hasParent: boolean;
}

// git's well-known empty-tree object; diffing against it yields an all-added
// diff, which is what we want for a root commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Resolve a commit-ish (sha, HEAD~3, HEAD^, tag, …) to a commit, or throw. */
export async function resolveCommit(ref: string): Promise<CommitInfo> {
  let sha: string;
  try {
    // ^{commit} forces it to resolve to a commit object (not a tree/blob/tag).
    sha = (await git.revparse([`${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`Not a valid commit: ${ref}`);
  }

  let hasParent = true;
  try {
    await git.revparse([`${sha}^`]);
  } catch {
    hasParent = false;
  }

  // NUL-separated so subjects with unusual characters stay intact.
  const meta = (await git.raw(['show', '-s', '--format=%h%x00%s%x00%an', sha])).trim();
  const [shortSha = sha.slice(0, 9), subject = '', author = ''] = meta.split('\0');

  return { ref, sha, shortSha, subject, author, hasParent };
}

/** Files changed by `commit` relative to its parent (or the empty tree). */
export async function listCommitFiles(commit: CommitInfo): Promise<ChangedFile[]> {
  const base = commit.hasParent ? `${commit.sha}^` : EMPTY_TREE;
  const raw = await git.raw(['diff', '--name-status', '--no-renames', base, commit.sha]);

  const files: ChangedFile[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const letter = line[0];
    const path = line.slice(tab + 1).trim();
    const kind: ChangeKind =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ path, kind, untracked: false, code: letter });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Unified diff for one file as introduced by `commit`. */
export async function diffForCommitFile(commit: CommitInfo, file: ChangedFile): Promise<string> {
  const base = commit.hasParent ? `${commit.sha}^` : EMPTY_TREE;
  return git.diff(['--no-color', base, commit.sha, '--', file.path]);
}

// Temp worktrees created for read-only browsing, removed on exit.
const tempWorktrees: string[] = [];

/**
 * Check out `commitish` into a fresh detached worktree under a temp directory
 * and return its path. The user's working tree and current branch are left
 * untouched. The objects for `commitish` must already be present locally.
 */
export async function addDetachedWorktree(commitish: string): Promise<string> {
  // git refuses to create a worktree in an existing directory, so point it at a
  // not-yet-existing leaf inside a temp dir we own.
  const dir = join(mkdtempSync(join(tmpdir(), 'differ-wt-')), 'tree');
  await git.raw(['worktree', 'add', '--detach', dir, commitish]);
  tempWorktrees.push(dir);
  return dir;
}

/** Fetch a single ref (e.g. a PR's pull/N/head) from a remote URL into the object store. */
export async function fetchRef(remote: string, ref: string): Promise<void> {
  await git.fetch([remote, ref]);
}

/** Diff a file in a worktree against its HEAD (i.e. the user's just-made edits). */
export async function diffWorktreeFile(worktreeDir: string, filePath: string): Promise<string> {
  return simpleGit(worktreeDir).diff(['--no-color', '--', filePath]);
}

/** Remove every temp worktree we created. Synchronous, safe to call from a process-exit handler. */
export function cleanupWorktrees(): void {
  for (const dir of tempWorktrees.splice(0)) {
    spawnSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
  }
}
