import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Resolve the user's editor. We honor the conventional precedence
 * ($VISUAL, then $EDITOR) and fall back to nvim, then a couple of common
 * editors that are usually present.
 */
export function resolveEditor(): string {
  return process.env.VISUAL || process.env.EDITOR || 'nvim';
}

/** Editors we know how to ask for their final cursor line on exit. */
const VIM_FAMILY = new Set(['vi', 'vim', 'nvim', 'view']);

function editorName(editor: string): string {
  return basename(editor.split(/\s+/)[0]).toLowerCase();
}

/**
 * Build argv for opening `file` at `line`. Different editors spell the
 * "jump to line" flag differently; we special-case the common ones and fall
 * back to the widely-supported `+LINE file` form (vi/vim/nvim/nano/emacs).
 */
export function editorArgs(editor: string, file: string, line: number): string[] {
  const name = editorName(editor);

  switch (name) {
    case 'code':
    case 'code-insiders':
    case 'codium':
    case 'cursor':
      // VS Code family: -g file:line, -w to block until the file is closed.
      return ['-g', '-w', `${file}:${line}`];
    case 'subl':
    case 'sublime_text':
      return ['-w', `${file}:${line}`];
    case 'idea':
    case 'webstorm':
    case 'pycharm':
      return ['--line', String(line), file];
    default:
      // vi, vim, nvim, nano, emacs, etc.
      return [`+${line}`, file];
  }
}

export interface OpenResult {
  ok: boolean;
  error?: string;
  /** The editor's cursor line when it exited, if we were able to capture it. */
  cursorLine?: number;
}

/**
 * Open `file` at `line` in the user's editor, handing the terminal over to it
 * synchronously. The caller is responsible for suspending the TUI's hold on
 * stdin/stdout around this call.
 *
 * For vim-family editors we register a one-shot VimLeavePre autocmd that
 * records the final cursor line to a temp file, so differ can restore the
 * cursor to the same place on return. This is session-only and does not touch
 * the user's config.
 */
export function openInEditor(file: string, line: number, cwd: string): OpenResult {
  const editor = resolveEditor();
  const [cmd, ...preArgs] = editor.split(/\s+/);
  const name = editorName(editor);

  const args = [...preArgs];
  let cursorFile: string | undefined;
  let tmpDir: string | undefined;

  if (VIM_FAMILY.has(name)) {
    tmpDir = mkdtempSync(join(tmpdir(), 'differ-'));
    cursorFile = join(tmpDir, 'cursor');
    // Write the current line to cursorFile right before the editor exits.
    args.push('-c', `autocmd VimLeavePre * call writefile([line('.')], '${cursorFile}')`);
  }
  args.push(...editorArgs(editor, file, Math.max(1, line)));

  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });

  let cursorLine: number | undefined;
  if (cursorFile) {
    try {
      const captured = parseInt(readFileSync(cursorFile, 'utf8').trim(), 10);
      if (Number.isFinite(captured) && captured > 0) cursorLine = captured;
    } catch {
      // The file may not exist if the editor was killed or quit with :cq.
    }
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (result.error) {
    return { ok: false, error: `${cmd}: ${result.error.message}`, cursorLine };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, error: `${cmd} exited with status ${result.status}`, cursorLine };
  }
  return { ok: true, cursorLine };
}

/**
 * Open `file` at `line` read-only, for browsing code around a diff. Like
 * openInEditor but with no cursor capture (nothing changes) and the editor's
 * read-only flag where one exists (vim-family `-R`, nano `-v`).
 */
export function viewInEditor(file: string, line: number, cwd: string): OpenResult {
  const editor = resolveEditor();
  const [cmd, ...preArgs] = editor.split(/\s+/);
  const name = editorName(editor);

  const args = [...preArgs];
  if (VIM_FAMILY.has(name)) args.push('-R');
  else if (name === 'nano') args.push('-v');
  args.push(...editorArgs(editor, file, Math.max(1, line)));

  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (result.error) return { ok: false, error: `${cmd}: ${result.error.message}` };
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, error: `${cmd} exited with status ${result.status}` };
  }
  return { ok: true };
}
