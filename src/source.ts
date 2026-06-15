import {
  type ChangedFile,
  type CommitInfo,
  type Repo,
  addDetachedWorktree,
  diffForCommitFile,
  diffForFile,
  fetchRef,
  listChangedFiles,
  listCommitFiles,
} from './git.js';
import { type PrFileDiff, type PrInfo, prChangedFiles, repoUrl } from './gh.js';

export interface SourceHeader {
  /** Text shown in the colored badge at the left of the title bar. */
  badge: string;
  /** Background color of the badge. */
  color: string;
  /** Text shown after the badge. */
  detail: string;
}

/**
 * A unified view over the three things differ can show: the working tree, a
 * single commit, or a PR's aggregate diff. The UI talks only to this interface.
 */
export interface DiffSource {
  kind: 'worktree' | 'commit' | 'pr';
  header: SourceHeader;
  /** Whether `e` (edit the file at a line) applies in this mode. */
  editable: boolean;
  listFiles(): Promise<ChangedFile[]>;
  loadDiff(file: ChangedFile): Promise<string>;
  /** One-line status summarizing the file count. */
  status(count: number): string;
  /**
   * Directory to open files from for read-only browsing, provisioned lazily and
   * cached. The live tree for working-tree mode; a detached worktree at the
   * commit/PR head otherwise.
   */
  contextRoot(): Promise<string>;
}

export function worktreeSource(repo: Repo): DiffSource {
  return {
    kind: 'worktree',
    header: { badge: ' differ ', color: 'blue', detail: repo.root },
    editable: true,
    listFiles: () => listChangedFiles(),
    loadDiff: (file) => diffForFile(file, repo.hasHead),
    status: (count) =>
      count === 0 ? 'No changes — working tree clean.' : `${count} changed file(s)`,
    contextRoot: async () => repo.root,
  };
}

export function commitSource(commit: CommitInfo): DiffSource {
  let dirPromise: Promise<string> | null = null;
  return {
    kind: 'commit',
    header: {
      badge: ' differ · commit ',
      color: 'magenta',
      detail: `${commit.shortSha}  ${commit.subject}`,
    },
    editable: true,
    listFiles: () => listCommitFiles(commit),
    loadDiff: (file) => diffForCommitFile(commit, file),
    status: (count) => `${count} file(s) in ${commit.shortSha} — ${commit.subject}`,
    // The commit's objects are already local; just check it out detached.
    contextRoot: () => (dirPromise ??= addDetachedWorktree(commit.sha)),
  };
}

export function prSource(pr: PrInfo, files: PrFileDiff[]): DiffSource {
  const byPath = new Map(files.map((f) => [f.path, f.raw]));
  let dirPromise: Promise<string> | null = null;
  return {
    kind: 'pr',
    header: {
      badge: ` differ · PR #${pr.number} `,
      color: 'cyan',
      detail: `${pr.title}   ${pr.baseRefName} ← ${pr.headRefName}`,
    },
    // Fetch-only: the working tree isn't the PR, so editing a file here would
    // be misleading. PR-diff editing becomes code suggestions in a later step.
    editable: false,
    listFiles: async () => prChangedFiles(files),
    loadDiff: async (file) => byPath.get(file.path) ?? '',
    status: (count) => `${count} file(s) in PR #${pr.number}`,
    // Fetch the PR head objects (works for forks via refs/pull/N/head), then
    // check them out into a detached worktree for browsing.
    contextRoot: () =>
      (dirPromise ??= (async () => {
        await fetchRef(await repoUrl(), `pull/${pr.number}/head`);
        return addDetachedWorktree(pr.headRefOid);
      })()),
  };
}
