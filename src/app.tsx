import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import {
  type ChangedFile,
  type Repo,
  diffForFile,
  listChangedFiles,
  resolveRepo,
} from './git.js';
import { type DiffLine, newLineAt, parseDiff } from './diff.js';
import { openInEditor } from './editor.js';
import { enterAltScreen, leaveAltScreen } from './screen.js';

type Pane = 'files' | 'diff';

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

function FileRow({ file, active, selected }: { file: ChangedFile; active: boolean; selected: boolean }) {
  const marker = file.code.replace(/ /g, '·');
  return (
    <Text
      wrap="truncate"
      inverse={selected && active}
      bold={selected}
      color={selected && !active ? 'white' : undefined}
    >
      <Text color={STATUS_COLOR[file.kind]}>{marker}</Text> {file.path}
    </Text>
  );
}

function DiffRow({ line, selected }: { line: DiffLine; selected: boolean }) {
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
    <Text wrap="truncate" color={color} dimColor={dimColor} inverse={selected}>
      {line.text.length > 0 ? line.text : ' '}
    </Text>
  );
}

export default function App() {
  const { exit } = useApp();
  const { setRawMode, isRawModeSupported } = useStdin();
  const { rows, columns } = useTerminalSize();

  const [repo, setRepo] = useState<Repo | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [pane, setPane] = useState<Pane>('files');

  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [diffCursor, setDiffCursor] = useState(0);
  const [diffTop, setDiffTop] = useState(0);

  const [status, setStatus] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);

  const selectedFile = files[fileIdx];

  // Layout math: 1 row header + 1 row footer, the rest is the body.
  const bodyHeight = Math.max(3, rows - 2);
  const fileColWidth = Math.min(42, Math.max(24, Math.floor(columns * 0.3)));
  const diffViewport = bodyHeight; // rows available inside the diff pane

  const reloadFiles = useCallback(async () => {
    try {
      const list = await listChangedFiles();
      setFiles(list);
      setFileIdx((i) => Math.min(i, Math.max(0, list.length - 1)));
      setError(null);
      setStatus(list.length === 0 ? 'No changes — working tree clean.' : `${list.length} changed file(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const r = await resolveRepo();
        setRepo(r);
        await reloadFiles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [reloadFiles]);

  // Load the diff whenever the selected file changes.
  useEffect(() => {
    if (!repo || !selectedFile) {
      setDiffLines([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = await diffForFile(selectedFile, repo.hasHead);
        if (cancelled) return;
        setDiffLines(parseDiff(raw));
        setDiffCursor(0);
        setDiffTop(0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, selectedFile, selectedFile?.path]);

  // Keep the diff cursor inside the visible viewport.
  useEffect(() => {
    if (diffCursor < diffTop) setDiffTop(diffCursor);
    else if (diffCursor >= diffTop + diffViewport) setDiffTop(diffCursor - diffViewport + 1);
  }, [diffCursor, diffTop, diffViewport]);

  const visibleDiff = useMemo(
    () => diffLines.slice(diffTop, diffTop + diffViewport),
    [diffLines, diffTop, diffViewport],
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

    // The file (and its status) may have changed; refresh both.
    void (async () => {
      await reloadFiles();
      if (repo && selectedFile) {
        try {
          const raw = await diffForFile(selectedFile, repo.hasHead);
          setDiffLines(parseDiff(raw));
          setDiffCursor((c) => c); // keep position; effect will clamp the view
        } catch {
          /* surfaced on next interaction */
        }
      }
    })();
  }, [repo, selectedFile, diffLines, diffCursor, reloadFiles, setRawMode]);

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
      openEditor();
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
        <Text backgroundColor="blue" color="white" bold>
          {' differ '}
        </Text>
        <Text> {repo ? repo.root : '…'}</Text>
      </Box>

      {/* Body */}
      <Box height={bodyHeight}>
        <Box
          flexDirection="column"
          width={fileColWidth}
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
                <FileRow key={f.path} file={f} active={pane === 'files'} selected={i === fileIdx} />
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
          {visibleDiff.length === 0 ? (
            <Text dimColor>{selectedFile ? '(no diff)' : 'Select a file'}</Text>
          ) : (
            visibleDiff.map((line, i) => (
              <DiffRow key={diffTop + i} line={line} selected={pane === 'diff' && diffTop + i === diffCursor} />
            ))
          )}
        </Box>
      </Box>

      {/* Footer */}
      <Box>
        <Text>
          <Text color="cyan">↑↓/jk</Text> move <Text color="cyan">tab</Text> pane{' '}
          <Text color="cyan">e</Text> edit@line <Text color="cyan">r</Text> refresh{' '}
          <Text color="cyan">q</Text> quit
        </Text>
        <Text dimColor> — {status}</Text>
      </Box>
    </Box>
  );
}
