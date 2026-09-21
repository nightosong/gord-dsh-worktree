# gord-dsh-worktree

Git worktree management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — isolate
parallel work in its own directory and branch, from the agent or from Settings.

[中文说明](README.zh.md)

## What it does

- **Agent tools** — `worktree_list`, `worktree_create`, `worktree_status`, `worktree_remove`, `worktree_prune`.
  An agent can branch off an isolated checkout for a task instead of doing everything in one working tree.
- **Settings page** — *Settings → Worktrees*: the repository's worktrees with branch/HEAD and
  current/detached/locked/pruned badges, a create form (branch, base, directory), dry-run prune, and
  one-click **Open as workspace** so a new worktree becomes a sidebar workspace you can start a session in.
- **No manual git** — creation is one atomic `git worktree add -b`, and the new directory defaults to a
  sibling `<repo>-worktrees/<branch>` so a worktree never lands inside the repository it came from.

## Renamed from `dsh-worktree`

The package id, module id, HTTP routes, and settings namespace are all
`gord-dsh-worktree` now. If you installed under the old name:

```sh
dsh plugin --profile web remove dsh-worktree
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

## Install

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

Then restart `dsh web` (a reload is enough once the bundle is on the layer stack) and open
**Settings → Worktrees**. Nothing else needs editing: the package declares `dsh.bundle.patch`, so the
CLI adds it to the profile's bundle stack itself.

Requires dsh `0.1.5-rc.1` or newer.

## Tools

| Tool | What it does |
| ---- | ------------ |
| `worktree_list` | Every worktree of a repository: path, branch, HEAD, and current/detached/locked/pruned state. |
| `worktree_create` | Creates the directory and its branch in one command; checks out an existing branch instead of recreating it. |
| `worktree_status` | One worktree's branch, upstream line, and changed files. |
| `worktree_remove` | Removes a worktree. Refuses when it holds uncommitted or untracked changes; `force` discards them on purpose. |
| `worktree_prune` | Drops records of worktrees whose directories are gone. Deletes no files. |

All five resolve the repository from the session directory by default and accept `workdir` (or `repo`) to
point at another one.

## Safety rules

- The main worktree is never removable.
- A dirty worktree is never removed without `force` — and "dirty" counts untracked files, because
  `worktree remove --force` would delete them.
- A locked worktree is reported, not silently unlocked.
- Branch names are validated by `git check-ref-format`, and every worktree path is passed to git as a
  positional argument, never through a shell, so a name can never become a flag.
- The HTTP surface the panel uses runs git on this machine, so the mutating route accepts same-origin
  and loopback callers only. It is not a remote API.

## Settings

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `defaultParent` | *(empty)* | Directory new worktrees are created in. Empty uses a sibling `<repo>-worktrees/` directory. |
| `adoptWorkspace` | `true` | Register a worktree created from the panel as a DSH workspace. |

## Development

The plugin is plain ESM with no build step: `lib/index.js` is the host half, `lib/client.js` is the
browser bundle loaded through `window.__ModuleLoader__`, and `lib/service.js` + `lib/worktree.js` hold the
git logic both halves share.

```sh
# install a checkout into a profile as a live dependency
dsh plugin --profile web add /absolute/path/to/gord-dsh-worktree
```

A checkout installed by path resolves Node imports from its own directory, while DSH's packages resolve
from the profile — so the host half cannot see `@deepseek-ai/dsh-tools` unless the checkout can reach
them. Link the peers once in a local checkout (they are gitignored):

```sh
mkdir -p node_modules/@deepseek-ai
SRC=$(dirname "$(readlink -f "$(which dsh)")")/../node_modules/@deepseek-ai
for p in schemastery dsh-tools dsh-settings cordis; do
  ln -sfn "$SRC/$p" "node_modules/@deepseek-ai/$p"
done
```

An install from GitHub or npm inside a profile needs none of this: there the peers resolve through the
profile's own `node_modules`, exactly as for every other plugin.

Because the host half is mounted as a bundle layer, host-side changes need a `dsh web` restart; client
changes reload with the GUI's normal module reload.

`npm test` runs both smoke suites — the host one against a throwaway git repository, the client one
against a minimal React runtime — with no test framework to install.

## License

MIT