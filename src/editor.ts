import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Resolve the user's editor. We honor the conventional precedence
 * ($VISUAL, then $EDITOR) and fall back to nvim, then a couple of common
 * editors that are usually present.
 */
export function resolveEditor(): string {
  return process.env.VISUAL || process.env.EDITOR || 'nvim';
}

/**
 * Build argv for opening `file` at `line`. Different editors spell the
 * "jump to line" flag differently; we special-case the common ones and fall
 * back to the widely-supported `+LINE file` form (vi/vim/nvim/nano/emacs).
 */
export function editorArgs(editor: string, file: string, line: number): string[] {
  const name = basename(editor.split(/\s+/)[0]).toLowerCase();

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
}

/**
 * Open `file` at `line` in the user's editor, handing the terminal over to it
 * synchronously. The caller is responsible for suspending the TUI's hold on
 * stdin/stdout around this call.
 */
export function openInEditor(file: string, line: number, cwd: string): OpenResult {
  const editor = resolveEditor();
  const [cmd, ...preArgs] = editor.split(/\s+/);
  const args = [...preArgs, ...editorArgs(editor, file, Math.max(1, line))];

  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });

  if (result.error) {
    return { ok: false, error: `${cmd}: ${result.error.message}` };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false, error: `${cmd} exited with status ${result.status}` };
  }
  return { ok: true };
}
