# gord-dsh-worktree

Git worktree management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — isolate
parallel work in its own directory and branch.

[中文说明](README.zh.md)

## Features

1. **Create worktrees** — an isolated checkout and branch in one atomic command, from the agent
   (`worktree_list`, `worktree_create`, `worktree_status`, `worktree_remove`, `worktree_prune`) or from
   *Settings → Worktrees*.
2. **Start a session in a worktree** — the New Session row carries a working-location picker: stay in the
   current worktree, or create a fresh one and open the session inside it.
3. **Review changes** — the right sidebar's *Changes* tab shows the uncommitted diff of the session's own
   directory: every changed file with its counts, and the selected file's patch.
4. **Manage archived sessions** — *Settings → Worktrees* lists every session archived on this machine, with
   **Unarchive** per row, a delete icon, and **Delete all** for the set.
5. **Double-click to rename** — rename a session from its sidebar row, without the menu.

![The worktree selector on the New Session row, open, showing the current worktree and a new one](docs/images/new-session-worktree-picker.png)

![A session running in a worktree, with the New Session row's working-location picker](docs/images/session-in-worktree.png)

![The Worktrees settings page: repository, create form, the worktree list with its actions, and the archived-sessions card](docs/images/worktree-settings.png)

## Install

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

Then restart `dsh web` (a reload is enough once the bundle is on the layer stack) and open
**Settings → Worktrees**. Nothing else needs editing: the package declares `dsh.bundle.patch`, so the
CLI adds it to the profile's bundle stack itself.

Requires dsh `0.1.5-rc.1` or newer.

## In detail

### Picking up someone else's branch

`worktree_create` with `branch: colleague/feature` and **no** `base` starts from
`origin/colleague/feature` and tracks it. This is the case that used to be quietly wrong: the branch
did not exist locally, so git created a fresh empty branch of the same name off the current one and
the caller believed they held the colleague's commits.

An explicit `base` is still honoured — a deliberate *new branch from main* has to stay possible — but
the result then carries `shadowedRemote` so the ambiguity is visible.

### Working location for a New Session

The menu offers exactly two entries: **Current worktree**, where a session starts unless you ask
otherwise, and **New worktree**. Existing worktrees are deliberately not listed — they are second
checkouts of a project the session already belongs to, so a worktree is reached by its path rather than
by a second sidebar entry.

**New worktree takes no input and asks no questions.** The branch is cut from the current one and named
for the code that names the directory, so the whole decision is "a fresh checkout" versus "here". Pick
it and you are in the new worktree: the worktree is made, registered, and a session is started and
opened inside it, ready for your first message. Once there, the branch is yours — create or switch
branches with ordinary git when the task calls for it; changing branch does not need a new worktree.

**It has to happen on the click, not on the first message.** A session's directory is fixed when the
session is created, and the blank session in the composer is created before anything is typed, so there
is no later moment at which a message could be aimed at a directory that does not exist yet. Creating
the worktree and the session together is the only order that works; a version that created the worktree
and left the session alone reported success and quietly ran the conversation in the project anyway.

**A worktree is registered as a workspace, and that is not a choice.** Workspace membership is exact
path equality (`sessionPath(id) === record.path`), `attachSession` rejects a session whose cwd differs
from its workspace path, and the record itself carries no hidden or archived flag. A session rooted in a
worktree therefore needs a workspace at that path — without one the shell has nowhere to draw it and
shows *choose a workspace to start* over a session that does exist. So each worktree you start a session
in appears in the sidebar beside the project, titled by its directory code, exactly as the core's own
*new workspace* flow would leave it. Registering on its own is also available as the explicit
**Open as workspace** action in Settings.

Only this route adopts. `worktree_create` does not: a worktree made mid-conversation leaves the session
where it is, so it needs no workspace, and adopting there would add a sidebar entry nobody asked for.

#### The sidebar patch: nesting, and double-click to rename

Two things the sidebar should do and does not: show a worktree's sessions under the project they were
cut from, and rename a session by double-clicking its row. Both are patched into DSH by this
repository:

```sh
npm run patch:sidebar     # then restart dsh web
npm run unpatch:sidebar   # to restore the shipped bundle
```

**Nesting** changes one small function — `groupByWorkspace`, the whole of the sidebar's grouping — so a
worktree's sessions fold into the project's group and the worktree stops being a group of its own. That
is how Codex reads, and for the same reason: it groups threads by project and treats the worktree as a
thread attribute, while DSH's grouping key is the directory and its records have no parent field. Two
rules decide the parent: a workspace whose directory is inside another's, and a parent map this plugin
publishes for worktrees kept outside the project — which is the default, `$DSH_HOME/worktree/<code>`.
The map is read from `localStorage` because the first render after a reload already needs the answer and
a fetch would land too late.

**Double-click to rename** adds one prop to the session row, calling the handler the row's own menu
already calls — so the dialog, its validation and its error text are core's, not a second copy of them.
Blank sessions are skipped, matching that menu, which hides its actions for them: a blank session has no
title to edit yet (the dialog would open empty) and the first message names it afterwards, so the edit
would be overwritten rather than kept.

Why patches and not the plugin: a client plugin can only nest by taking over the whole
`sidebar.workspaces` slot, which is `single` and owns the section header, the search box, every session
row and every workspace dialog — 14 components, with drag reordering, rename, archive and fork. Taking it
over would mean reimplementing all of it and drifting from core on every release. The grouping function
is a dozen lines, and the rename hook is one prop.

**A DSH upgrade replaces the file, so re-run `npm run patch:sidebar` after one.** The script is
idempotent, keeps the shipped bundle at `client.js.orig` before the first patch, and refuses to guess if
the code is not in the shape it expects — a newer DSH needs the patch updated rather than forced. Each
patch carries its own marker, so an install that already has one still receives the other, and a patch
is only written once every replacement it needs has been found. `npm run patch:sidebar -- --check` prints
one line per patch and exits non-zero unless all of them are applied.

#### Keeping the sidebar clean

The worktree's workspace is titled after its project — `repo · 1dda6ec0`, not a bare `1dda6ec0` — because
the title is the only place that relationship can be shown. The sidebar groups by workspace, one group per
directory, with no nesting and no hidden flag on the record, so a worktree is a group of its own whether or
not it looks like one. Codex reads cleanly here for a structural reason rather than a smarter trick: it
groups threads by *project* and treats the worktree as an attribute of a thread, so a worktree thread simply
lands under its project. DSH's grouping key is the directory, so there is nothing to nest into.

If you would rather not see the groups at all, the shell already has the mode for it: **View options →
Group by → In one list** in the sidebar header. Sessions from every workspace become one recency-ordered
list, so a worktree session sits beside the project's with no heading of its own. It is a saved preference,
it applies immediately, and no plugin change is involved — it is the closest thing to Codex's sidebar that
the current shell offers.

The menu dismisses on a pointer anywhere outside the control and on Escape (which also returns focus to
the trigger). The core selectors get that from the shared `Menu` primitive; this one cannot use it,
because this panel is not a flat `{id, label}` list — it carries a status line and a busy state — so the
behaviour is reproduced directly.

It sits on the Hero's own working-location row, beside the workspace and preset controls, and is styled
to match them exactly: the same borderless 16px-radius pill, the same 13px/500 type, the same shared
chevron and icon package. The icons come from `@deepseek-ai/dsh-client-ui-primitives`, which is
declared in `dsh.client.inject` — a client plugin can only `require` a package the boot graph wires in.
That row is
laid out by the core plugin and all three `conversation.hero.*` slots are `single`, where a second
occupant *shadows* the first instead of sitting beside it — so the control is rendered onto the row's
element with `createPortal`, which is how the core plugins place themselves inside surfaces they do
not own. The row is found from this plugin's own host outward via the `conversation.hero.workspace`
`data-slot` anchor, not by a document-wide query. If no row can be found the control renders in place
rather than disappearing.

### Reviewing changes in the sidebar

The right sidebar's *Changes* tab shows the uncommitted diff of the session's own directory: every
file that differs from `HEAD`, its status and line counts, and the selected file's patch with both
line-number columns. It is the working tree against `HEAD` — staged and unstaged together — rather
than the session's own edits, because what a person reviews before committing is what is on disk,
whichever tool put it there: an agent's file edit, a formatter, or their own editor in the next
window. The session's own edits are already diffed inline in the conversation, from the tools' own
reports.

A worktree is an ordinary repository to it. The tab asks the host about the directory the session
runs in, so a session that moves into a worktree follows along without the tab being told it did.

![The Changes tab: six changed files with statuses and counts, and the selected file's patch](docs/images/sidebar-changes-tab.png)

It is registered through the same `sidebarRightTabs` registry the built-in file tree and document
preview use, and both of its slots — the body and the tab title — are injected from a child scope, so
a profile composed without the right sidebar loses the tab instead of failing to apply the plugin.
Open it from the right sidebar's start page, where it is listed beside *Workspace files*.

### The archive

DSH archives a session by adding its id to one array on the workspace registry, and it offers no way
back: the remote contract has one archive method and nothing else, no CLI command touches it, and no
screen lists what was archived — the whole client carries exactly one archive string, the menu item
that does the archiving. A session that is archived leaves every grouping surface with no record to
review and no control to undo it.

**Settings → Worktrees** now ends with an *Archived sessions* card listing every session archived on
this machine, newest archive first: its title, the project it ran in, when it was created, when it was
archived, and how much its log takes on disk. Each row carries **Unarchive** and a delete icon, and the card's
top right carries **Delete all**.

Unarchiving writes through the registry's own serialized operation queue and its `setState` — the pair
`archiveSession` itself uses — so the change is durable *and* lands on screen at once: the sidebar gets
the session back in its original position, with no restart. Archiving only ever hid it; nothing was
moved or deleted.

**Delete all** is the one irreversible control in the plugin. It removes each listed session's log
directory, its cached projections and its workspace membership, behind a confirmation that names the
count. **Each row has the same delete as an icon**, for the far more common case of one session
archived by mistake rather than ninety. Both send back the exact ids they listed rather than a "delete
everything" flag, so a session archived between the listing and the click is never swept up. A session
that is still live is skipped and reported, instead of having its log pulled out from under a running
agent.

The archive entry is the one thing deletion keeps. Core's only switch for "do not show this Session"
is the archive set — `sessionVisible` consults it on every render — and core cannot express "this
session is gone" at all. An id whose log is removed but which is left unarchived falls out of its
workspace and into the browser's *Ungrouped* bucket, as an empty group that survives until the page is
reloaded. Keeping the entry is what makes the session stay hidden, immediately and after every reload;
the panel drops these ids from its own listing because there is nothing left to show.

Each row carries one date, and it is the session's last write — read off the newest mtime in its log
directory during the same scan that measures its size. That is the honest answer to "when was this last
used", which is the question a list of archived sessions is actually asked. A projection could answer
`lastPromptAt` instead, the field the sidebar itself sorts by, but it only exists for a session the
projection cache holds a row for, and cold-reading the rest costs a whole log per row — so a session
that never wrote after it was created falls back to its own creation date, and that is the only case in
which a row shows one.

Archive *times* are not DSH's to give either: the archive set is a bare id array with no timestamps
anywhere. The plugin records them itself, in `$DSH_HOME/gord-dsh-worktree/archived-at.json`, from the
moment it loads, and uses them to keep the list newest-archived-first. They are deliberately **not
shown** on a row: they are the plugin's own bookkeeping rather than a fact about the session, and a row
is easier to read with one date than three.

### Renamed from `dsh-worktree`

The package id, module id, HTTP routes, and settings namespace are all
`gord-dsh-worktree` now. If you installed under the old name:

```sh
dsh plugin --profile web remove dsh-worktree
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

## Tools

| Tool | What it does |
| ---- | ------------ |
| `worktree_list` | Every worktree of a repository: path, branch, HEAD, and current/detached/locked/pruned state — plus every local and remote-tracking branch, which is what to consult before naming a base. |
| `worktree_create` | Creates the directory and its branch in one command; checks out an existing branch instead of recreating it, and starts from a remote-tracking branch of the same name when only that exists. |
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
- Deleting archived sessions is the only destructive operation that is not about git, and the only one
  that cannot be undone. It is behind an explicit confirmation, it removes only the ids it was handed,
  and it refuses to touch a session that is still running.

## Settings

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `defaultParent` | *(empty)* | Directory new worktrees are created in. Empty uses `$DSH_HOME/worktree/`. |

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