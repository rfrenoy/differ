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

## Keys

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `↑`/`↓`, `j`/`k` | Move within the active pane                       |
| `Tab`, `←`/`→`   | Switch between the file list and the diff         |
| `e`            | Open the current file in `$EDITOR` at the cursor line |
| `r`            | Refresh                                           |
| `q`            | Quit                                              |

## Editor

differ uses `$VISUAL`, then `$EDITOR`, falling back to `nvim`. It knows the
jump-to-line syntax for vi/vim/nvim/nano/emacs (`+LINE`), the VS Code family
(`-g file:LINE`), Sublime (`file:LINE`), and JetBrains IDEs (`--line LINE`).

