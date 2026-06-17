#!/usr/bin/env node
import { render } from 'ink';
import App from './app.js';
import { cleanupWorktrees } from './git.js';
import { addComments, listComments, parseFindings } from './headless.js';
import { enterAltScreen, leaveAltScreen } from './screen.js';

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`differ — a git TUI where editing a diff is the point

Usage:
  differ                       View and edit the working-tree diff
  differ <commit-ish>          View the diff a commit introduced (SHA, HEAD,
                               HEAD^, HEAD~3, a tag, or a branch name)
  differ --pr <number>         Review a GitHub pull request's aggregate diff
                               (requires the gh CLI, authenticated)

Headless (for scripts / model-driven review; require --pr):
  differ --pr <n> add-comments    Add draft comments from JSON on stdin:
                                  [{ "path", "line", "side"?, "startLine"?,
                                     "body"?, "suggestion"? }, ...]
  differ --pr <n> list-comments   Print the current draft comments as JSON

Keys: ↑↓/jk move · tab switch pane · e edit/suggest · o view · c comment · S submit · q quit`);
  process.exit(0);
}

// --pr <number>
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

const SUBCOMMANDS = ['add-comments', 'list-comments'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const prValue = prFlag !== -1 ? argv[prFlag + 1] : undefined;
const positionals = argv.filter((a) => !a.startsWith('-') && a !== prValue);
const sub = positionals.find((a): a is Subcommand => (SUBCOMMANDS as readonly string[]).includes(a));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function runHeadless(command: Subcommand, prNumber: number): Promise<never> {
  try {
    if (command === 'list-comments') {
      console.log(JSON.stringify(await listComments(prNumber), null, 2));
      process.exit(0);
    }

    const raw = await readStdin();
    if (!raw.trim()) {
      console.error('differ: add-comments expects a JSON array of findings on stdin');
      process.exit(1);
    }
    let findings;
    try {
      findings = parseFindings(JSON.parse(raw));
    } catch (err) {
      console.error(`differ: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const result = await addComments(prNumber, findings);
    console.log(
      `PR #${prNumber}: added ${result.added}, updated ${result.updated}, rejected ${result.rejected.length}.`,
    );
    for (const r of result.rejected) console.log(`  rejected: ${r.reason}`);
    process.exit(0);
  } catch (err) {
    console.error(`differ: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (sub) {
  if (pr === undefined) {
    console.error(`differ: ${sub} requires --pr <number>`);
    process.exit(1);
  }
  void runHeadless(sub, pr);
} else {
  // Interactive TUI.
  const target = positionals[0];
  enterAltScreen();
  const { waitUntilExit } = render(<App target={target} pr={pr} />, { exitOnCtrlC: false });

  // Restore the terminal and remove temp worktrees, no matter how we leave.
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
}
