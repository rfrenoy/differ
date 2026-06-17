# differ

A git TUI inspired by [lazygit](https://github.com/jesseduffield/lazygit) — with one
opinionated twist: **editing a file straight from its diff is the whole point.**

In lazygit you can stage and unstage hunks, but the diff is read-only. In differ,
you put your cursor on any line of a diff and press `e` to open that exact line in
your editor (`nvim` by default). The diff shows you the `+`/`-`; your editor opens
the *full* file parked on the right line, so its own git gutter keeps the change
markers visible while you edit. Save, and differ re-reads the file and refreshes.

> Status: **v0.1** — diff viewer + jump-to-line editing. Staging, committing, and
> branch management are next.

## Install

```bash
npm install
npm run build
npm link        # optional: puts `differ` on your PATH
```

## Run

```bash
npm run dev     # run from source with tsx
# or, after build:
differ          # if you ran `npm link`
node dist/cli.js
```

Run it from inside any git repository.

### Viewing a commit

Pass a commit-ish to see the diff that commit introduced (relative to its
parent, or the empty tree for a root commit):

```bash
differ HEAD        # the most recent commit
differ HEAD^       # its parent
differ HEAD~3      # three commits back
differ a1b2c3d     # a specific SHA (also tags, branch names)
```

Editing still works in this mode: `e` opens the file at the commit's line
number in your editor. Note the working-tree file may have changed since that
commit, so the line is a best-effort landing point.

### Reviewing a pull request

Pass a GitHub PR number to view its aggregate (`base...head`) diff — the same
view as GitHub's "Files changed" tab:

```bash
differ --pr 234
```

This shells out to the [GitHub CLI](https://cli.github.com) (`gh pr diff`), so
`gh` must be installed and authenticated (`gh auth login`). It is **fetch-only**:
your working tree and current branch are left untouched. Browse with `o`, leave
review comments with `c`, and propose changes with `e` (see below).

### Commenting on a PR

In PR mode, put the cursor on any diff line and press `c` to write a review
comment in `$EDITOR`; press `c` again on a commented line to edit it, or `d` to
delete it. Comments appear inline beneath their line, the file list shows a
`●n` badge per file, and drafts are saved to `.git/differ/pr-<n>.json` so they
survive across runs. Submitting the review to GitHub is the next milestone.

The PR's **existing** review comments are also fetched and shown inline (in
cyan, with the author's name and any reply thread). Pressing `d` on an existing
comment marks it for deletion (`✗`, in red); the deletion is applied when you
submit. Comments whose line no longer maps to the current diff are counted as
"outdated" in the status bar rather than shown. `r` re-fetches the PR's
comments.

### Proposing changes (code suggestions)

In PR mode, press `e` to **edit the file and have your edits become GitHub code
suggestions** — the edit-from-diff idea pointed at review. differ opens the file
(from a temporary checkout of the PR head) in `$EDITOR`; when you save, it diffs
your edits and turns each change into a draft:

- A change that lands on a line the PR touched becomes a clickable
  ```suggestion (multi-line edits become multi-line suggestions automatically).
- A change **outside** the PR's diff — where GitHub can't anchor an inline
  comment — is preserved as a code-block comment anchored to the nearest diff
  line, noting where it really belongs (so no edit is lost).

You can press `c` on a resulting suggestion to add an explanatory note above it.
A status line summarizes what was created (e.g. `Added 2 suggestions · 1 code
comment`). Suggestions submit with the rest of your review via `S`.

### Submitting the review

Press `S` to open the submit screen: pick a verdict (comment / approve /
request changes) with `↑`/`↓`, optionally write an overall summary with `m`
(opens `$EDITOR`), review the comments grouped by file, and press `enter` to
send — or `esc` to cancel. differ posts the whole review in one call, applies
any pending deletions, then re-fetches the PR's comments so your just-submitted
comments stay visible (now read-only) and deleted ones disappear — no restart.
Local drafts are cleared on success. Comments are anchored to the commit you
reviewed; if the PR head moved meanwhile, the screen warns you.

### Scripting: draft comments from the CLI

differ can create draft comments without the TUI, so another tool — e.g. a
model reviewing a PR — can propose comments that you then curate and submit
interactively. Both commands require `--pr`.

```bash
# Add draft comments from a JSON array on stdin
differ --pr 234 add-comments <<'JSON'
[
  { "path": "src/auth.ts", "line": 42, "body": "[GEN6] use a switch + assertNever" },
  { "path": "src/auth.ts", "line": 88, "suggestion": "return check(user, opts)" },
  { "path": "src/db.ts", "line": 20, "startLine": 18, "body": "covers lines 18-20" }
]
JSON

# Print the current drafts as JSON
differ --pr 234 list-comments
```

Each finding takes `path` and `line` (plus optional `side` — defaults to
`RIGHT` —, `startLine` for a multi-line anchor, `body`, and `suggestion`, which
is wrapped in a ```suggestion block). differ validates every anchor against the
PR's diff and **rejects** any that aren't on a diff line (reporting why), so the
model gets immediate feedback instead of a failure at submit time. Drafts land
in the same `.git/differ/pr-<n>.json` the TUI reads — open `differ --pr 234` to
review, edit, and submit them.

## Keys

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `↑`/`↓`, `j`/`k` | Move within the active pane                       |
| `Tab`, `←`/`→`   | Switch between the file list and the diff         |
| `z`            | Widen the file pane to show full names (toggle)   |
| `H`/`M`/`L`     | Jump to the top/middle/bottom visible diff line   |
| `e`            | Edit the file at the cursor line — direct edit, or in PR mode propose changes as suggestions |
| `o`            | Open the current file read-only at the cursor line (browse)  |
| `n`/`N`         | Jump to the next/previous commented line (PR mode) |
| `c`            | Write/edit a review comment on the line (PR mode) |
| `d`            | Delete the review comment on the line (PR mode)   |
| `S`            | Submit the review to GitHub (PR mode)             |
| `r`            | Refresh                                           |
| `q`            | Quit                                              |

## Browsing around a diff (`o`)

`o` opens the current file **read-only** (`nvim -R`, `view`, …) at the cursor's
line, so you can scroll past the diff hunks and follow code into other files —
useful when a change calls a function you can't see in the diff.

In working-tree mode this opens the live file. In commit and PR modes it opens
the file from a **detached `git worktree`** checked out at that revision (the
commit, or the PR head), so you see the code exactly as of that point and get
full cross-file navigation / LSP. The worktree is created on first use and
removed on exit; your branch and working tree are never touched. For a PR this
fetches `refs/pull/<n>/head` the first time (works for forks too).

## Editor

differ uses `$VISUAL`, then `$EDITOR`, falling back to `nvim`. It knows the
jump-to-line syntax for vi/vim/nvim/nano/emacs (`+LINE`), the VS Code family
(`-g file:LINE`), Sublime (`file:LINE`), and JetBrains IDEs (`--line LINE`).

