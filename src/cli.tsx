#!/usr/bin/env node
import { render } from 'ink';
import App from './app.js';
import { enterAltScreen, leaveAltScreen } from './screen.js';

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`differ — a git TUI where editing a diff is the point

Usage:
  differ                 View and edit the working-tree diff
  differ <commit-ish>    View the diff a commit introduced (e.g. a SHA,
                         HEAD, HEAD^, HEAD~3, a tag, or a branch name)

Keys: ↑↓/jk move · tab switch pane · e edit file at line · r refresh · q quit`);
  process.exit(0);
}

// The first non-flag argument is the commit-ish to view, if any.
const target = argv.find((a) => !a.startsWith('-'));

enterAltScreen();

const { waitUntilExit } = render(<App target={target} />, { exitOnCtrlC: false });

// Restore the user's terminal no matter how we leave.
const restore = () => leaveAltScreen();
process.on('exit', restore);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

waitUntilExit().then(() => {
  leaveAltScreen();
  process.exit(0);
});
