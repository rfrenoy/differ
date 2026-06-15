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
your working tree and current branch are left untouched. Editing the diff is
disabled in this mode (code suggestions are coming), but you can browse with `o`
and leave review comments with `c`.

### Commenting on a PR

In PR mode, put the cursor on any diff line and press `c` to write a review
comment in `$EDITOR`; press `c` again on a commented line to edit it, or `d` to
delete it. Comments appear inline beneath their line, the file list shows a
`●n` badge per file, and drafts are saved to `.git/differ/pr-<n>.json` so they
survive across runs. Submitting the review to GitHub is the next milestone.

The PR's **existing** review comments are also fetched and shown inline (in
cyan, with the author's name and any reply thread) — read-only for now.
Comments whose line no longer maps to the current diff are counted as
"outdated" in the status bar rather than shown.

## Keys

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `↑`/`↓`, `j`/`k` | Move within the active pane                       |
| `Tab`, `←`/`→`   | Switch between the file list and the diff         |
| `e`            | Open the current file in `$EDITOR` at the cursor line (edit) |
| `o`            | Open the current file read-only at the cursor line (browse)  |
| `c`            | Write/edit a review comment on the line (PR mode) |
| `d`            | Delete the review comment on the line (PR mode)   |
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

