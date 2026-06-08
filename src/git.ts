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

const git: SimpleGit = simpleGit();

export async function resolveRepo(): Promise<Repo> {
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not inside a git repository.');
  }
  const root = (await git.revparse(['--show-toplevel'])).trim();
  let hasHead = true;
  try {
    await git.revparse(['HEAD']);
  } catch {
    hasHead = false;
  }
  return { root, hasHead };
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
