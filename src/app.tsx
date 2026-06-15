import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { type ChangedFile, type Repo, gitDir, resolveCommit, resolveRepo } from './git.js';
import { type PrComment, fetchPrComments, fetchPrDiff, resolvePr } from './gh.js';
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

/** Tracks the live terminal size so panes can resize with the window. */
function useTerminalSize(): { rows: number; columns: number } {
  const [size, setSize] = useState({
    rows: process.stdout.rows ?? 24,
    columns: process.stdout.columns ?? 80,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 });
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
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

/** A single rendered line within a comment block shown under a diff line. */
function CommentRow({ text, meta, tone }: { text: string; meta: boolean; tone: 'draft' | 'existing' }) {
  return (
    <Text wrap="truncate" color={tone === 'draft' ? 'yellow' : 'cyan'} dimColor={meta}>
      {text.length > 0 ? text : ' '}
    </Text>
  );
}

/**
 * What actually gets drawn in the diff pane: each diff line, optionally
 * followed by the rendered lines of comments anchored to it.
 */
type RenderRow =
  | { kind: 'diff'; diffIndex: number; line: DiffLine; commented: boolean }
  | { kind: 'comment'; diffIndex: number; text: string; meta: boolean; tone: 'draft' | 'existing' };

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
  const rows: RenderRow[] = [
    { kind: 'comment', diffIndex, text: '    ┌ you (draft)', meta: true, tone: 'draft' },
  ];
  for (const b of c.body.split('\n')) {
    rows.push({ kind: 'comment', diffIndex, text: `    │ ${b}`, meta: false, tone: 'draft' });
  }
  rows.push({ kind: 'comment', diffIndex, text: '    └ c edit · d delete', meta: true, tone: 'draft' });
  return rows;
}

/** Render an existing PR thread (one or more comments) read-only beneath its line. */
function existingCommentBlock(diffIndex: number, comments: PrComment[]): RenderRow[] {
  const rows: RenderRow[] = [];
  comments.forEach((c, idx) => {
    rows.push({
      kind: 'comment',
      diffIndex,
      text: `    ${idx === 0 ? '┌' : '├'} ${c.author}:`,
      meta: true,
      tone: 'existing',
    });
    for (const b of c.body.split('\n')) {
      rows.push({ kind: 'comment', diffIndex, text: `    │ ${b}`, meta: false, tone: 'existing' });
    }
  });
  rows.push({ kind: 'comment', diffIndex, text: '    └ (read-only)', meta: true, tone: 'existing' });
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

  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [diffCursor, setDiffCursor] = useState(0);
  // Scroll offset into the rendered rows (diff lines + inline comment blocks).
  const [renderTop, setRenderTop] = useState(0);

  // Draft review comments (PR mode), persisted to .git/differ/pr-<n>.json.
  const [comments, setComments] = useState<DraftComment[]>([]);
  const draftsFileRef = useRef<string | null>(null);
  const headShaRef = useRef<string | null>(null);

  // Existing inline comments already on the PR (read-only).
  const [prComments, setPrComments] = useState<PrComment[]>([]);

  // After an editor round-trip, the working-tree line we want the diff cursor
  // to land on. Read by the diff-load effect, then cleared.
  const pendingCursorLine = useRef<number | null>(null);

  const [status, setStatus] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);

  const selectedFile = files[fileIdx];

  // Layout math: 1 row header + 1 row footer, the rest is the body.
  const bodyHeight = Math.max(3, rows - 2);
  const diffViewport = bodyHeight; // rows available inside the diff pane

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
        setRenderTop(0);
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

  // Per-file draft-comment counts, for the file-list badges.
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments]);

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

  // The drawn rows: each diff line, then any existing thread, then a draft.
  const renderRows = useMemo(() => {
    const rows: RenderRow[] = [];
    const path = selectedFile?.path;
    diffLines.forEach((line, i) => {
      let existing: PrComment[] = [];
      let draft: DraftComment | undefined;
      if (path) {
        for (const k of lineAnchorKeys(line, path)) {
          const list = existingByAnchor.get(k);
          if (list) existing = existing.concat(list);
        }
        const a = anchorForLine(line);
        if (a) draft = commentMap.get(anchorKey(path, a.side, a.line));
      }
      rows.push({ kind: 'diff', diffIndex: i, line, commented: existing.length > 0 || !!draft });
      if (existing.length > 0) rows.push(...existingCommentBlock(i, existing));
      if (draft) rows.push(...commentBlock(i, draft));
    });
    return rows;
  }, [diffLines, commentMap, existingByAnchor, selectedFile?.path]);

  // Where the cursor's diff line sits among the rendered rows.
  const cursorRenderIndex = useMemo(
    () => renderRows.findIndex((r) => r.kind === 'diff' && r.diffIndex === diffCursor),
    [renderRows, diffCursor],
  );

  // Keep the cursor's rendered row inside the visible viewport.
  useEffect(() => {
    if (cursorRenderIndex < 0) return;
    if (cursorRenderIndex < renderTop) setRenderTop(cursorRenderIndex);
    else if (cursorRenderIndex >= renderTop + diffViewport)
      setRenderTop(cursorRenderIndex - diffViewport + 1);
  }, [cursorRenderIndex, renderTop, diffViewport]);

  const visibleRows = useMemo(
    () => renderRows.slice(renderTop, renderTop + diffViewport),
    [renderRows, renderTop, diffViewport],
  );

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

  // Delete the draft comment on the current diff line, if any.
  const deleteComment = useCallback(() => {
    if (source?.kind !== 'pr' || !selectedFile) return;
    const row = diffLines[diffCursor];
    const anchor = row ? anchorForLine(row) : null;
    if (!anchor || !commentMap.has(anchorKey(selectedFile.path, anchor.side, anchor.line))) {
      setStatus('No comment on this line.');
      return;
    }
    const next = comments.filter(
      (c) => !(c.path === selectedFile.path && c.side === anchor.side && c.line === anchor.line),
    );
    setComments(next);
    persist(next);
    setStatus('Comment removed.');
  }, [source, selectedFile, diffLines, diffCursor, comments, commentMap, persist]);

  useInput(
    (input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === 'r') {
      void reloadFiles();
      return;
    }
    if (key.tab || input === 'h' || input === 'l' || key.leftArrow || key.rightArrow) {
      setPane((p) => (p === 'files' ? 'diff' : 'files'));
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

  return (
    <Box flexDirection="column" width={columns} height={rows}>
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
          width={FILE_COL_WIDTH}
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
              .slice(0, bodyHeight - 2)
              .map((f, i) => (
                <FileRow
                  key={f.path}
                  file={f}
                  active={pane === 'files'}
                  selected={i === fileIdx}
                  comments={commentCounts.get(f.path) ?? 0}
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
            visibleRows.map((row, i) =>
              row.kind === 'comment' ? (
                <CommentRow key={renderTop + i} text={row.text} meta={row.meta} tone={row.tone} />
              ) : (
                <DiffRow
                  key={renderTop + i}
                  line={row.line}
                  selected={pane === 'diff' && row.diffIndex === diffCursor}
                  gutter={source?.kind === 'pr' ? (row.commented ? '● ' : '  ') : undefined}
                />
              ),
            )
          )}
        </Box>
      </Box>

      {/* Footer */}
      <Box>
        <Text>
          <Text color="cyan">↑↓/jk</Text> move <Text color="cyan">tab</Text> pane{' '}
          {source?.editable ? (
            <Text>
              <Text color="cyan">e</Text> edit@line{' '}
            </Text>
          ) : null}
          <Text color="cyan">o</Text> view{' '}
          {source?.kind === 'pr' ? (
            <Text>
              <Text color="cyan">c</Text> comment <Text color="cyan">d</Text> delete{' '}
            </Text>
          ) : null}
          <Text color="cyan">r</Text> refresh <Text color="cyan">q</Text> quit
        </Text>
        <Text dimColor> — {status}</Text>
        {source?.kind === 'pr' && prComments.length > 0 ? (
          <Text dimColor>
            {' '}
            · {prComments.length} comment{prComments.length === 1 ? '' : 's'}
            {outdatedCount > 0 ? ` · ${outdatedCount} outdated` : ''}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
