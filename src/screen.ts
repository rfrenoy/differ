/** Low-level terminal screen control used to give differ a full-window TUI. */

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function enterAltScreen(): void {
  process.stdout.write(ENTER_ALT + HOME + HIDE_CURSOR);
}

export function leaveAltScreen(): void {
  process.stdout.write(SHOW_CURSOR + LEAVE_ALT);
}
