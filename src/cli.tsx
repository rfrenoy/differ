#!/usr/bin/env node
import { render } from 'ink';
import App from './app.js';
import { cleanupWorktrees } from './git.js';
import { enterAltScreen, leaveAltScreen } from './screen.js';

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`differ — a git TUI where editing a diff is the point

Usage:
  differ                 View and edit the working-tree diff
  differ <commit-ish>    View the diff a commit introduced (e.g. a SHA,
                         HEAD, HEAD^, HEAD~3, a tag, or a branch name)
  differ --pr <number>   Review a GitHub pull request's aggregate diff
                         (requires the gh CLI, authenticated)

Keys: ↑↓/jk move · tab switch pane · e edit file at line · r refresh · q quit`);
  process.exit(0);
}

// --pr <number>: review a GitHub pull request.
let pr: number | undefined;
const prFlag = argv.indexOf('--pr');
if (prFlag !== -1) {
  const value = argv[prFlag + 1];
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n <= 0) {
    console.error(`differ: --pr requires a positive PR number (got ${value ?? '<nothing>'})`);
    process.exit(1);
  }
  pr = n;
}

// The first non-flag argument is the commit-ish to view, if any. Skip the
// value consumed by --pr.
const prValue = prFlag !== -1 ? argv[prFlag + 1] : undefined;
const target = argv.find((a) => !a.startsWith('-') && a !== prValue);

enterAltScreen();

const { waitUntilExit } = render(<App target={target} pr={pr} />, { exitOnCtrlC: false });

// Restore the user's terminal and remove any temp worktrees, no matter how we leave.
const restore = () => {
  cleanupWorktrees();
  leaveAltScreen();
};
process.on('exit', restore);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

waitUntilExit().then(() => {
  leaveAltScreen();
  process.exit(0);
});
