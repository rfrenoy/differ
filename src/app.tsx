import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { type ChangedFile, type Repo, gitDir, resolveCommit, resolveRepo } from './git.js';
import {
  type PrComment,
  type ReviewEvent,
  deletePrComment,
  fetchPrComments,
  fetchPrDiff,
  resolvePr,
  submitReview,
} from './gh.js';
import { type DiffSource, commitSource, prSource, worktreeSource } from './source.js';
import { type DiffLine, newLineAt, parseDiff, rowForNewLine } from './diff.js';
import { editTextInEditor, openInEditor, viewInEditor } from './editor.js';
import {
  type DraftComment,
  type Side,
  anchorKey,
  draftsPath,
  loadDrafts,
  saveDrafts,
} from './comments.js';
import { join } from 'node:path';
import { enterAltScreen, leaveAltScreen } from './screen.js';

type Pane = 'files' | 'diff';

/** Fixed width (in columns) of the file-list pane. The diff pane fills the rest. */
const FILE_COL_WIDTH = 36;

/**
 * Tracks the live terminal size so panes can resize with the window. Reads the
 * stdout Ink actually renders to (not the global), so our layout height always
 * matches what Ink paints — important to avoid tripping its fullscreen clear.
 */
function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout.rows ?? 24,
    columns: stdout.columns ?? 80,
  });
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

const STATUS_COLOR: Record<ChangedFile['kind'], string> = {
  modified: 'yellow',
  added: 'green',
  deleted: 'red',
  renamed: 'magenta',
  untracked: 'cyan',
};

function FileRow({
  file,
  active,
  selected,
  comments,
}: {
  file: ChangedFile;
  active: boolean;
  selected: boolean;
  comments: number;
}) {
  const marker = file.code.replace(/ /g, '·');
  return (
    <Text
      wrap="truncate"
      inverse={selected && active}
      bold={selected}
      color={selected && !active ? 'white' : undefined}
    >
      <Text color={STATUS_COLOR[file.kind]}>{marker}</Text> {file.path}
      {comments > 0 ? <Text color="yellow"> ●{comments}</Text> : null}
    </Text>
  );
}

function DiffRow({ line, selected, gutter }: { line: DiffLine; selected: boolean; gutter?: string }) {
  let color: string | undefined;
  let dimColor = false;
  switch (line.type) {
    case 'add':
      color = 'green';
      break;
    case 'del':
      color = 'red';
      break;
    case 'hunk':
      color = 'cyan';
      break;
    case 'meta':
      color = 'gray';
      dimColor = true;
      break;
  }
  return (
    <Text wrap="truncate" inverse={selected}>
      {gutter !== undefined ? <Text color="yellow">{gutter}</Text> : null}
      <Text color={color} dimColor={dimColor}>
        {line.text.length > 0 ? line.text : ' '}
      </Text>
    </Text>
  );
}

type CommentTone = 'draft' | 'existing' | 'tombstone';
const TONE_COLOR: Record<CommentTone, string> = {
  draft: 'yellow',
  existing: 'cyan',
  tombstone: 'red',
};

/** A single rendered line within a comment block shown under a diff line. */
function CommentRow({ text, meta, tone }: { text: string; meta: boolean; tone: CommentTone }) {
  return (
    <Text wrap="truncate" color={TONE_COLOR[tone]} dimColor={meta}>
      {text.length > 0 ? text : ' '}
    </Text>
  );
}

/**
 * What actually gets drawn in the diff pane: each diff line, optionally
 * followed by the rendered lines of comments anchored to it.
 */
type RenderRow = { key: string } & (
  | { kind: 'diff'; diffIndex: number; line: DiffLine; commented: boolean }
  | { kind: 'comment'; diffIndex: number; text: string; meta: boolean; tone: CommentTone }
);

/** The anchor (side + file line) for a *new draft* on a diff row, if any. */
function anchorForLine(line: DiffLine): { side: Side; line: number } | null {
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
function lineAnchorKeys(line: DiffLine, path: string): string[] {
  const keys: string[] = [];
  if (line.type === 'del' && line.oldLine !== undefined) keys.push(anchorKey(path, 'LEFT', line.oldLine));
  if (line.type === 'add' && line.newLine !== undefined) keys.push(anchorKey(path, 'RIGHT', line.newLine));
  if (line.type === 'context') {
    if (line.newLine !== undefined) keys.push(anchorKey(path, 'RIGHT', line.newLine));
    if (line.oldLine !== undefined) keys.push(anchorKey(path, 'LEFT', line.oldLine));
  }
  return keys;
}

/** Render a draft comment as indented lines beneath its diff line. */
function commentBlock(diffIndex: number, c: DraftComment): RenderRow[] {
  const lines = ['    ┌ you (draft)', ...c.body.split('\n').map((b) => `    │ ${b}`), '    └ c edit · d delete'];
  return lines.map((text, j) => ({
    key: `dr-${diffIndex}-${j}`,
    kind: 'comment' as const,
    diffIndex,
    text,
    meta: j === 0 || j === lines.length - 1,
    tone: 'draft' as const,
  }));
}

/** Existing PR comments anchored to a diff line, gathered across its anchor keys. */
function gatherExisting(line: DiffLine, path: string, byAnchor: Map<string, PrComment[]>): PrComment[] {
  let res: PrComment[] = [];
  for (const k of lineAnchorKeys(line, path)) {
    const list = byAnchor.get(k);
    if (list) res = res.concat(list);
  }
  return res;
}

/** Render an existing PR thread (one or more comments) read-only beneath its line. */
function existingCommentBlock(
  diffIndex: number,
  comments: PrComment[],
  tombstoned: Set<number>,
): RenderRow[] {
  const rows: RenderRow[] = [];
  let anyDead = false;
  const push = (text: string, meta: boolean, tone: CommentTone) =>
    rows.push({ key: `ex-${diffIndex}-${rows.length}`, kind: 'comment', diffIndex, text, meta, tone });
  comments.forEach((c, idx) => {
    const dead = tombstoned.has(c.id);
    if (dead) anyDead = true;
    const tone: CommentTone = dead ? 'tombstone' : 'existing';
    push(`    ${idx === 0 ? '┌' : '├'} ${dead ? '✗ ' : ''}${c.author}:`, true, tone);
    for (const b of c.body.split('\n')) push(`    │ ${b}`, false, tone);
  });
  push(
    anyDead ? '    └ marked for deletion · d to unmark' : '    └ (read-only) · d to delete',
    true,
    anyDead ? 'tombstone' : 'existing',
  );
  return rows;
}

export default function App({ target, pr }: { target?: string; pr?: number }) {
  const { exit } = useApp();
  const { setRawMode, isRawModeSupported } = useStdin();
  const { rows, columns } = useTerminalSize();

  const [repo, setRepo] = useState<Repo | null>(null);
  // What differ is showing: working tree, a commit, or a PR. Chosen at startup.
  const [source, setSource] = useState<DiffSource | null>(null);
  // Mirror of `source` for use inside stable callbacks without re-creating them.
  const sourceRef = useRef<DiffSource | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [pane, setPane] = useState<Pane>('files');
  // When true, widen the file pane to show full file names.
  const [filesExpanded, setFilesExpanded] = useState(false);

  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [diffCursor, setDiffCursor] = useState(0);
  // Scroll offset into the rendered rows (diff lines + inline comment blocks).
  // A ref, not state: it's clamped during render to keep the cursor visible, so
  // moving past the viewport edge needs no extra render (which would flicker).
  const renderTopRef = useRef(0);

  // Draft review comments (PR mode), persisted to .git/differ/pr-<n>.json.
  const [comments, setComments] = useState<DraftComment[]>([]);
  const draftsFileRef = useRef<string | null>(null);
  const headShaRef = useRef<string | null>(null);

  // Existing inline comments already on the PR (read-only).
  const [prComments, setPrComments] = useState<PrComment[]>([]);
  // Ids of existing comments marked for deletion on the next submit.
  const [tombstones, setTombstones] = useState<number[]>([]);

  // Submit-review screen state.
  const [submitView, setSubmitView] = useState(false);
  const [verdict, setVerdict] = useState<ReviewEvent>('COMMENT');
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Current PR head, re-resolved when opening the submit screen, to detect drift.
  const [currentHead, setCurrentHead] = useState<string | null>(null);

  // After an editor round-trip, the working-tree line we want the diff cursor
  // to land on. Read by the diff-load effect, then cleared.
  const pendingCursorLine = useRef<number | null>(null);

  const [status, setStatus] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);

  const selectedFile = files[fileIdx];

  // Layout math: 1 row title bar + 1 row footer, plus one spare row kept below
  // the body so total output stays under the terminal height — otherwise Ink
  // treats us as "fullscreen" and clears the whole screen each frame (flicker).
  const bodyHeight = Math.max(4, rows - 3);
  // Rows actually visible inside a pane: its height minus the rounded border (2)
  // and the one-line pane header. Rendering more than this overflows the pane.
  const paneRows = Math.max(1, bodyHeight - 3);
  const diffViewport = paneRows;

  const reloadFiles = useCallback(async () => {
    try {
      const src = sourceRef.current;
      if (!src) return;
      const list = await src.listFiles();
      setFiles(list);
      setFileIdx((i) => Math.min(i, Math.max(0, list.length - 1)));
      setError(null);
      setStatus(src.status(list.length));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Re-fetch the PR's existing comments (after a submit, or on manual refresh).
  const refreshPrComments = useCallback(() => {
    if (pr === undefined) return;
    void fetchPrComments(pr)
      .then(setPrComments)
      .catch(() => {
        /* best-effort */
      });
  }, [pr]);

  // Initial load: resolve the repo, pick the source, then list its files.
  useEffect(() => {
    (async () => {
      try {
        const r = await resolveRepo();
        setRepo(r);
        let src: DiffSource;
        let driftNote = '';
        if (pr !== undefined) {
          const [info, diffs, existing] = await Promise.all([
            resolvePr(pr),
            fetchPrDiff(pr),
            // A comments failure (e.g. permissions) shouldn't block the review.
            fetchPrComments(pr).catch(() => [] as PrComment[]),
          ]);
          src = prSource(info, diffs);
          setPrComments(existing);
          const dpath = draftsPath(await gitDir(), pr);
          draftsFileRef.current = dpath;
          headShaRef.current = info.headRefOid;
          const loaded = loadDrafts(dpath);
          if (loaded) {
            setComments(loaded.comments);
            if (loaded.headSha !== info.headRefOid) {
              driftNote = ' — ⚠ PR head moved since these drafts; anchors may be off';
            }
          }
        } else if (target) {
          src = commitSource(await resolveCommit(target));
        } else {
          src = worktreeSource(r);
        }
        sourceRef.current = src;
        setSource(src);
        await reloadFiles();
        if (driftNote) setStatus((s) => s + driftNote);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [reloadFiles, target, pr]);

  // Load the diff whenever the selected file (or source) changes.
  useEffect(() => {
    if (!repo || !source || !selectedFile) {
      setDiffLines([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = await source.loadDiff(selectedFile);
        if (cancelled) return;
        const lines = parseDiff(raw);
        setDiffLines(lines);
        // After an editor round-trip, restore the cursor to where it was in
        // the editor; otherwise start at the top of a freshly selected file.
        const pending = pendingCursorLine.current;
        pendingCursorLine.current = null;
        setDiffCursor(pending === null ? 0 : rowForNewLine(lines, pending));
        renderTopRef.current = 0;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, source, selectedFile, selectedFile?.path]);

  // Comments for the selected file, indexed by their (path, side, line) anchor.
  const commentMap = useMemo(() => {
    const m = new Map<string, DraftComment>();
    for (const c of comments) m.set(anchorKey(c.path, c.side, c.line), c);
    return m;
  }, [comments]);

  // Per-file message counts for the file-list badges: existing PR comments plus
  // your drafts (drafts/PR comments only exist in PR mode, so 0 elsewhere).
  const fileCommentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    for (const c of prComments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments, prComments]);

  // File-pane width: a fixed sidebar, or — when expanded — wide enough to show
  // the longest file name (with marker + badge), capped at 80% of the terminal.
  const fileColWidth = useMemo(() => {
    if (!filesExpanded) return FILE_COL_WIDTH;
    let longest = 0;
    for (const f of files) {
      const badge = (fileCommentCounts.get(f.path) ?? 0) > 0 ? 5 : 0; // " ●NN"
      longest = Math.max(longest, f.code.length + 1 + f.path.length + badge);
    }
    const want = longest + 4; // round borders (2) + paddingX (2)
    return Math.max(FILE_COL_WIDTH, Math.min(want, Math.floor(columns * 0.85)));
  }, [filesExpanded, files, fileCommentCounts, columns]);

  // Existing PR comments, grouped by anchor (skipping outdated ones).
  const existingByAnchor = useMemo(() => {
    const m = new Map<string, PrComment[]>();
    for (const c of prComments) {
      if (c.line === null) continue;
      const k = anchorKey(c.path, c.side, c.line);
      const arr = m.get(k);
      if (arr) arr.push(c);
      else m.set(k, [c]);
    }
    return m;
  }, [prComments]);

  // Outdated comments (their line no longer maps to the current diff) are hidden
  // inline but surfaced as a count.
  const outdatedCount = useMemo(
    () => prComments.filter((c) => c.line === null).length,
    [prComments],
  );

  const tombstoneSet = useMemo(() => new Set(tombstones), [tombstones]);

  // The drawn rows: each diff line, then any existing thread, then a draft.
  const renderRows = useMemo(() => {
    const rows: RenderRow[] = [];
    const path = selectedFile?.path;
    diffLines.forEach((line, i) => {
      let existing: PrComment[] = [];
      let draft: DraftComment | undefined;
      if (path) {
        existing = gatherExisting(line, path, existingByAnchor);
        const a = anchorForLine(line);
        if (a) draft = commentMap.get(anchorKey(path, a.side, a.line));
      }
      rows.push({
        key: `d-${i}`,
        kind: 'diff',
        diffIndex: i,
        line,
        commented: existing.length > 0 || !!draft,
      });
      if (existing.length > 0) rows.push(...existingCommentBlock(i, existing, tombstoneSet));
      if (draft) rows.push(...commentBlock(i, draft));
    });
    return rows;
  }, [diffLines, commentMap, existingByAnchor, tombstoneSet, selectedFile?.path]);

  // Where the cursor's diff line sits among the rendered rows.
  const cursorRenderIndex = useMemo(
    () => renderRows.findIndex((r) => r.kind === 'diff' && r.diffIndex === diffCursor),
    [renderRows, diffCursor],
  );

  // Clamp the scroll offset during render so the cursor stays visible. Writing
  // the ref here (no setState) means a move past the edge scrolls within the
  // same frame — no second render, no flicker.
  let viewTop = renderTopRef.current;
  if (cursorRenderIndex >= 0) {
    if (cursorRenderIndex < viewTop) viewTop = cursorRenderIndex;
    else if (cursorRenderIndex >= viewTop + diffViewport) viewTop = cursorRenderIndex - diffViewport + 1;
  }
  viewTop = Math.max(0, viewTop);
  renderTopRef.current = viewTop;
  const visibleRows = renderRows.slice(viewTop, viewTop + diffViewport);

  const openEditor = useCallback(() => {
    if (!repo || !selectedFile) return;
    const line = newLineAt(diffLines, diffCursor);

    // Hand the terminal over to the editor: drop raw mode, leave our alt
    // screen so the editor can run its own, then restore everything.
    setRawMode(false);
    leaveAltScreen();
    const result = openInEditor(selectedFile.path, line, repo.root);
    enterAltScreen();
    setRawMode(true);

    if (!result.ok) setError(result.error ?? 'Editor failed.');
    else setError(null);

    // Remember where to put the cursor: the editor's final line if we captured
    // it, otherwise the line we jumped from. Refreshing the file list re-selects
    // the file, and the diff-load effect repositions the cursor accordingly.
    pendingCursorLine.current = result.cursorLine ?? line;
    void reloadFiles();
  }, [repo, selectedFile, diffLines, diffCursor, reloadFiles, setRawMode]);

  // Open the current file read-only at the cursor line, so you can browse the
  // code around a diff. In commit/PR mode this is a detached worktree at the
  // right revision (provisioned on first use), enabling cross-file navigation.
  const openReadOnly = useCallback(() => {
    if (!source || !selectedFile) return;
    const line = newLineAt(diffLines, diffCursor);
    void (async () => {
      let dir: string;
      try {
        setStatus('Preparing read-only view…');
        dir = await source.contextRoot();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      setRawMode(false);
      leaveAltScreen();
      const result = viewInEditor(join(dir, selectedFile.path), line, dir);
      enterAltScreen();
      setRawMode(true);
      if (!result.ok) setError(result.error ?? 'Editor failed.');
      else setStatus(`Viewed ${selectedFile.path}`);
    })();
  }, [source, selectedFile, diffLines, diffCursor, setRawMode]);

  const persist = useCallback(
    (next: DraftComment[]) => {
      const file = draftsFileRef.current;
      if (!file || pr === undefined || !headShaRef.current) return;
      saveDrafts(file, { pr, headSha: headShaRef.current, comments: next });
    },
    [pr],
  );

  // Write or edit a draft comment on the current diff line (PR mode only).
  const commentOnLine = useCallback(() => {
    if (source?.kind !== 'pr' || !selectedFile) {
      setStatus('Comments are available in PR review mode (--pr <n>).');
      return;
    }
    const row = diffLines[diffCursor];
    const anchor = row ? anchorForLine(row) : null;
    if (!anchor) {
      setStatus('Move to an added, removed, or context line to comment.');
      return;
    }
    const existing = commentMap.get(anchorKey(selectedFile.path, anchor.side, anchor.line));

    setRawMode(false);
    leaveAltScreen();
    const result = editTextInEditor(existing?.body ?? '');
    enterAltScreen();
    setRawMode(true);

    if (!result.ok) {
      setError(result.error ?? 'Editor failed.');
      return;
    }
    const body = (result.text ?? '').trim();
    const next = comments.filter(
      (c) => !(c.path === selectedFile.path && c.side === anchor.side && c.line === anchor.line),
    );
    if (body) {
      next.push({
        path: selectedFile.path,
        side: anchor.side,
        line: anchor.line,
        body,
        createdAt: new Date().toISOString(),
      });
    }
    setComments(next);
    persist(next);
    setStatus(body ? 'Comment saved.' : 'Comment removed.');
  }, [source, selectedFile, diffLines, diffCursor, comments, commentMap, persist, setRawMode]);

  // `d` deletes your draft on the line if there is one; otherwise it toggles a
  // tombstone on the existing comment(s) there, to be deleted on submit.
  const deleteComment = useCallback(() => {
    if (source?.kind !== 'pr' || !selectedFile) return;
    const row = diffLines[diffCursor];
    if (!row) return;
    const anchor = anchorForLine(row);

    if (anchor && commentMap.has(anchorKey(selectedFile.path, anchor.side, anchor.line))) {
      const next = comments.filter(
        (c) => !(c.path === selectedFile.path && c.side === anchor.side && c.line === anchor.line),
      );
      setComments(next);
      persist(next);
      setStatus('Draft comment removed.');
      return;
    }

    const existing = gatherExisting(row, selectedFile.path, existingByAnchor);
    if (existing.length === 0) {
      setStatus('No comment on this line.');
      return;
    }
    const ids = existing.map((c) => c.id);
    const allMarked = ids.every((id) => tombstones.includes(id));
    setTombstones((prev) =>
      allMarked
        ? prev.filter((id) => !ids.includes(id))
        : Array.from(new Set([...prev, ...ids])),
    );
    setStatus(
      allMarked
        ? 'Unmarked for deletion.'
        : `Marked ${ids.length} comment(s) for deletion on submit.`,
    );
  }, [source, selectedFile, diffLines, diffCursor, comments, commentMap, existingByAnchor, tombstones, persist]);

  // Open the submit-review screen and re-resolve the PR head to detect drift.
  const openSubmitView = useCallback(() => {
    if (source?.kind !== 'pr' || pr === undefined) {
      setStatus('Submitting a review is only available in PR mode.');
      return;
    }
    setSubmitError(null);
    setCurrentHead(null);
    setSubmitView(true);
    void resolvePr(pr)
      .then((info) => setCurrentHead(info.headRefOid))
      .catch(() => {
        /* drift check is best-effort */
      });
  }, [source, pr]);

  const editSummary = useCallback(() => {
    setRawMode(false);
    leaveAltScreen();
    const result = editTextInEditor(summary);
    enterAltScreen();
    setRawMode(true);
    if (result.ok) setSummary((result.text ?? '').trim());
  }, [summary, setRawMode]);

  const doSubmit = useCallback(() => {
    if (pr === undefined || !headShaRef.current) return;
    const hasReview = comments.length > 0 || summary.trim().length > 0 || verdict !== 'COMMENT';
    if (!hasReview && tombstones.length === 0) {
      setSubmitError('Nothing to submit — add a comment, a summary, pick a verdict, or mark a deletion.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    void (async () => {
      // 1) Post the review (verdict + summary + new inline comments), if any.
      if (hasReview) {
        try {
          await submitReview(pr, {
            event: verdict,
            body: summary,
            // Anchor to the head the comments were drafted against.
            commitId: headShaRef.current!,
            comments: comments.map((c) => ({
              path: c.path,
              line: c.line,
              side: c.side,
              body: c.body,
            })),
          });
        } catch (err) {
          setSubmitting(false);
          setSubmitError(`Review submit failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      // 2) Delete tombstoned comments, tolerating per-comment failures.
      const failed: number[] = [];
      for (const id of tombstones) {
        try {
          await deletePrComment(id);
        } catch {
          failed.push(id);
        }
      }
      const posted = hasReview ? comments.length : 0;
      const deleted = tombstones.length - failed.length;
      // 3) Reflect the new state: re-fetch existing comments, clear drafts.
      const fresh = await fetchPrComments(pr).catch(() => [] as PrComment[]);
      setPrComments(fresh);
      setComments([]);
      persist([]);
      setTombstones(failed);
      setSubmitting(false);

      const summaryMsg =
        `Submitted as ${verdict}` +
        (posted ? ` · ${posted} comment(s)` : '') +
        (deleted ? ` · ${deleted} deleted` : '');
      if (failed.length > 0) {
        setSubmitError(`${summaryMsg}, but ${failed.length} deletion(s) failed (not yours?).`);
      } else {
        setSubmitView(false);
        setStatus(summaryMsg + '.');
      }
    })();
  }, [pr, comments, summary, verdict, tombstones, persist]);

  useInput(
    (input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Submit-review screen has its own keymap.
    if (submitView) {
      if (submitting) return;
      if (key.escape || input === 'q') {
        setSubmitView(false);
        return;
      }
      if (key.downArrow || input === 'j' || key.upArrow || input === 'k') {
        const order: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
        const dir = key.downArrow || input === 'j' ? 1 : -1;
        setVerdict((v) => order[(order.indexOf(v) + dir + order.length) % order.length]);
        return;
      }
      if (input === 'm') {
        editSummary();
        return;
      }
      if (key.return || input === 'y') {
        doSubmit();
        return;
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'S') {
      openSubmitView();
      return;
    }
    if (input === 'r') {
      void reloadFiles();
      if (sourceRef.current?.kind === 'pr') refreshPrComments();
      return;
    }
    if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
      setPane((p) => (p === 'files' ? 'diff' : 'files'));
      return;
    }
    if (input === 'z') {
      setFilesExpanded((v) => !v);
      return;
    }
    if (input === 'e') {
      if (!source?.editable) {
        setStatus('Editing is off while viewing a PR — code suggestions are coming.');
        return;
      }
      openEditor();
      return;
    }
    if (input === 'o') {
      openReadOnly();
      return;
    }
    if (input === 'c') {
      commentOnLine();
      return;
    }
    if (input === 'd') {
      deleteComment();
      return;
    }

    // H/M/L: jump the cursor to the top/middle/bottom visible diff line (vim
    // screen motions), within the current viewport — no scrolling.
    if (pane === 'diff' && (input === 'H' || input === 'M' || input === 'L')) {
      const top = renderTopRef.current;
      const visibleDiffRows = renderRows
        .slice(top, top + diffViewport)
        .filter((r) => r.kind === 'diff');
      if (visibleDiffRows.length > 0) {
        const pick =
          input === 'H' ? 0 : input === 'L' ? visibleDiffRows.length - 1 : (visibleDiffRows.length - 1) >> 1;
        const targetRow = visibleDiffRows[pick];
        if (targetRow.kind === 'diff') setDiffCursor(targetRow.diffIndex);
      }
      return;
    }

    const down = key.downArrow || input === 'j';
    const up = key.upArrow || input === 'k';
    if (!down && !up) return;

    if (pane === 'files') {
      setFileIdx((i) => {
        const next = down ? i + 1 : i - 1;
        return Math.max(0, Math.min(files.length - 1, next));
      });
    } else {
      setDiffCursor((c) => {
        const next = down ? c + 1 : c - 1;
        return Math.max(0, Math.min(diffLines.length - 1, next));
      });
    }
    },
    { isActive: isRawModeSupported },
  );

  if (!isRawModeSupported) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow" bold>
          differ needs an interactive terminal.
        </Text>
        <Text dimColor>
          Raw keyboard input isn&apos;t available here (stdin is not a TTY). Run differ directly in
          your terminal.
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Error
        </Text>
        <Text>{error}</Text>
        <Text dimColor>Press q to quit, r to retry.</Text>
      </Box>
    );
  }

  if (submitView) {
    const drift =
      currentHead !== null && headShaRef.current !== null && currentHead !== headShaRef.current;
    const byFile = new Map<string, DraftComment[]>();
    for (const c of comments) {
      const arr = byFile.get(c.path);
      if (arr) arr.push(c);
      else byFile.set(c.path, [c]);
    }
    const verdicts: { v: ReviewEvent; label: string }[] = [
      { v: 'COMMENT', label: 'Comment — feedback without explicit approval' },
      { v: 'APPROVE', label: 'Approve' },
      { v: 'REQUEST_CHANGES', label: 'Request changes' },
    ];
    return (
      <Box flexDirection="column" width={columns} height={rows - 1} padding={1}>
        <Text bold>
          Submit review · <Text color="cyan">PR #{pr}</Text>
        </Text>
        {drift ? (
          <Text color="yellow">
            ⚠ PR head moved since you started — comments anchor to the commit you reviewed.
          </Text>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Verdict</Text>
          {verdicts.map(({ v, label }) => (
            <Text key={v} color={v === verdict ? 'green' : undefined}>
              {v === verdict ? '❯ ' : '  '}
              {label}
            </Text>
          ))}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>
            Summary <Text dimColor>(m to edit)</Text>
          </Text>
          {summary ? (
            summary
              .split('\n')
              .slice(0, 4)
              .map((l, i) => <Text key={i}>{l.length > 0 ? l : ' '}</Text>)
          ) : (
            <Text dimColor>— none —</Text>
          )}
        </Box>

        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          <Text bold>Comments ({comments.length})</Text>
          {comments.length === 0 ? (
            <Text dimColor>— none —</Text>
          ) : (
            [...byFile.entries()].map(([path, cs]) => (
              <Box key={path} flexDirection="column">
                <Text color="cyan" wrap="truncate">
                  {path}
                </Text>
                {cs.map((c, i) => (
                  <Text key={i} dimColor wrap="truncate">
                    {'  '}
                    {c.side === 'LEFT' ? '-' : '+'}
                    {c.line} {c.body.split('\n')[0]}
                  </Text>
                ))}
              </Box>
            ))
          )}
        </Box>

        {tombstones.length > 0 ? (
          <Text color="red">
            Will delete {tombstones.length} existing comment{tombstones.length === 1 ? '' : 's'}.
          </Text>
        ) : null}
        {submitError ? (
          <Text color="red" wrap="truncate">
            {submitError}
          </Text>
        ) : null}
        <Text dimColor>
          {submitting ? 'Submitting…' : '↑↓ verdict · m summary · enter submit · esc cancel'}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows - 1}>
      {/* Header */}
      <Box>
        <Text backgroundColor={source?.header.color ?? 'blue'} color="white" bold>
          {source?.header.badge ?? ' differ '}
        </Text>
        <Text wrap="truncate"> {source ? source.header.detail : '…'}</Text>
      </Box>

      {/* Body */}
      <Box height={bodyHeight}>
        <Box
          flexDirection="column"
          width={fileColWidth}
          flexShrink={0}
          borderStyle="round"
          borderColor={pane === 'files' ? 'blue' : 'gray'}
          paddingX={1}
        >
          <Text dimColor>Changes</Text>
          {files.length === 0 ? (
            <Text dimColor>— none —</Text>
          ) : (
            files
              .slice(0, paneRows)
              .map((f, i) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={pane === 'files'}
                  selected={i === fileIdx}
                  comments={fileCommentCounts.get(f.path) ?? 0}
                />
              ))
          )}
        </Box>

        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={pane === 'diff' ? 'blue' : 'gray'}
          paddingX={1}
        >
          <Text dimColor wrap="truncate">
            {selectedFile ? selectedFile.path : 'Diff'}
          </Text>
          {visibleRows.length === 0 ? (
            <Text dimColor>{selectedFile ? '(no diff)' : 'Select a file'}</Text>
          ) : (
            visibleRows.map((row) =>
              row.kind === 'comment' ? (
                <CommentRow key={row.key} text={row.text} meta={row.meta} tone={row.tone} />
              ) : (
                <DiffRow
                  key={row.key}
                  line={row.line}
                  selected={pane === 'diff' && row.diffIndex === diffCursor}
                  gutter={source?.kind === 'pr' ? (row.commented ? '● ' : '  ') : undefined}
                />
              ),
            )
          )}
        </Box>
      </Box>

      {/* Footer — kept to a single truncated line so it never wraps (a wrapped
          footer would push output to full height and re-trigger Ink's clear). */}
      <Box>
        <Text wrap="truncate">
          <Text color="cyan">↑↓/jk</Text> move <Text color="cyan">tab</Text> pane{' '}
          <Text color="cyan">z</Text> {filesExpanded ? 'shrink' : 'widen'}{' '}
          {source?.editable ? (
            <Text>
              <Text color="cyan">e</Text> edit@line{' '}
            </Text>
          ) : null}
          <Text color="cyan">o</Text> view{' '}
          {source?.kind === 'pr' ? (
            <Text>
              <Text color="cyan">c</Text> comment <Text color="cyan">d</Text> delete{' '}
              <Text color="cyan">S</Text> submit{' '}
            </Text>
          ) : null}
          <Text color="cyan">r</Text> refresh <Text color="cyan">q</Text> quit
          <Text dimColor> — {status}</Text>
          {source?.kind === 'pr' && prComments.length > 0 ? (
            <Text dimColor>
              {' '}
              · {prComments.length} comment{prComments.length === 1 ? '' : 's'}
              {outdatedCount > 0 ? ` · ${outdatedCount} outdated` : ''}
            </Text>
          ) : null}
        </Text>
      </Box>
    </Box>
  );
}
