# gord-dsh-worktree

Git worktree management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — isolate
parallel work in its own directory and branch. It also ships **Fast mode (快速模式)** as an agent preset
and an opt-in patch that lets read-only tool calls run concurrently.

[中文说明](README.zh.md) · [Long-form notes](docs/internals.md)

## Features

1. **Create worktrees** — an isolated checkout and branch in one atomic command, from the agent
   (`worktree_list`, `worktree_create`, `worktree_status`, `worktree_remove`, `worktree_prune`,
   `worktree_relocate`) or from *Settings → Worktrees*.
2. **Start a session in a worktree** — the New Session row carries a working-location picker: stay in the
   current worktree, or create a fresh one and open the session inside it.
3. **Review changes** — the right sidebar's *Changes* tab shows the uncommitted diff of the session's own
   directory: every changed file with its counts, and the selected file's patch.
4. **Manage archived sessions** — *Settings → Worktrees* lists every session archived on this machine, with
   **Unarchive** per row, a delete icon, and **Delete all** for the set.
5. **Double-click to rename** — rename a session from its sidebar row, without the menu.
6. **Fast mode (快速模式)** — a slim agent preset that ships in the bundle patch, so the preset picker has it
   as soon as the plugin is installed.
7. **Concurrent read-only tool calls** — an opt-in patch for `bash`, `glob` and `grep`, so a step that
   batches reads overlaps them instead of running them one after another.
8. **Session hover card** — hovering a session names the workspace it runs in at the top (the workspace
   title: `skyrouter`, or `skyrouter · ed466e1a` for a worktree of it) with the branch of its directory
   below.

![The worktree selector on the New Session row, open, showing the current worktree and a new one](docs/images/new-session-worktree-picker.png)

![The Worktrees settings page: the worktree list with its actions and the archived-sessions card](docs/images/settings-worktrees.png)

## Where worktrees live

A worktree is created inside its own project, at `<project>/.dsh/worktrees/<code>`: the directory really
being inside the project is what lets each sidebar nest it under that project. It still never pollutes the
project's `git status` or its diffs, because the plugin adds `/.dsh/worktrees/` to that repository's own
`.git/info/exclude`. A different parent can be configured (`defaultParent`).

Worktrees made by an earlier release, which lived in the shared `$DSH_HOME/worktree/`, keep working: **Move
into project** in *Settings → Worktrees*, or `worktree_relocate` from the agent, moves them in and leaves a
symlink at each old path so anything pointed there still resolves.

## Sidebar nesting

Both shells fold a worktree under its project. `dsh web` gets there through the patch this plugin puts into
the browser bundle, which it re-applies on load (or by hand: `npm run patch:sidebar`). The desktop app has
that nesting natively in its **workspace tree** grouping, and the Worktrees page offers that switch wherever
the client store has one. The desktop cannot be patched — its shell lives inside the signed app bundle — so
that switch, not a patch, is how its sidebar nests.

A tree also draws a folder line for the worktree itself, which the patched web sidebar does not. The
matching checkbox, **Hide worktree rows (sessions stay)**, is on by default and removes exactly those lines:
their sessions move out to the project's own indent, and a worktree with no live session keeps its row,
because that row is the only way to reach its own `+` and `…` actions. It is display only — the workspace
itself is untouched, and unchecking the box brings every line back.

## Install

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

Then restart `dsh web` (a reload is enough once the bundle is on the layer stack) and open
**Settings → Worktrees**. Nothing else needs editing: the package declares `dsh.bundle.patch`, so the CLI
adds it to the profile's bundle stack itself.

Fast mode arrives with it — the same patch declares the `fast` agent preset, so the preset picker has
**快速模式** without a profile file being edited. If the profile's own `cordis.patch.yml` already declares a
`preset-fast` row (the hand-written way), delete that row: the bundle layer merges first, and two rows with
the same id mount the preset twice, which the loader does not refuse. Which preset new sessions *start* in
stays a user choice (`agent-preset-registry` in the profile patch); the bundle never sets it. The flip side
of that split: this bundle is what declares Fast mode, so if you uninstall the plugin, change or remove that
`default: fast` row as well — otherwise it names a preset that no longer exists.

The concurrency patch is the one opt-in step, because it edits core tool packages rather than the plugin's
own composition:

```sh
cd /path/to/gord-dsh-worktree
npm run patch:concurrency     # --check to inspect first, --revert to undo
```

It needs a `dsh web` restart, it is idempotent, and it stays manual by design: it touches `dsh-tool-bash` and
`dsh-tool-fs-search`, which the desktop app can never carry, so leaving it out keeps both hosts scheduling
read-only calls the same way. A DSH upgrade restores those files — re-run it after one, and use
`npm run check:concurrency` to see where it stands: `patched`, `original`, or `unknown` when the build moved
on, which the tool refuses to force and reports instead.

## Across DSH versions

Supports dsh `>=0.1.5-rc.1 <0.2.0` — the whole 0.1.x line from `0.1.5-rc.1` on. Three of them are tested:
`0.1.5-rc.1`, `0.1.6-alpha.2` and `0.1.7-rc.2`. Glyph export names, session navigation and the plugin
settings interface all changed across that span, and the plugin handles each shape:

| Interface | 0.1.5 / 0.1.6 | 0.1.7 on | What the plugin does |
| --------- | ------------- | -------- | -------------------- |
| Glyph export names | `IconTrashOutline16` and friends, size-suffixed | `IconTrashOutlineRegular` and friends, weight-suffixed | Tries both names, draws nothing if neither exists, and never hands React an `undefined` element type |
| Session navigation | `sessions.open(id)` | `uiWorkspace.openSession(id)`; `sessions.open` is gone | Reveals through the workspace view, falls back to the old call when there is none |
| Plugin settings namespace | `settings.register(ns, schema)` | no such method; the profile's own form model replaces it | Registers a namespace only where that method exists, and reads the entry's config directly otherwise |

Both `uiWorkspace` and `settings` are read optionally (`ctx.get`), so a profile composed without a workspace
view, or without settings, loses one feature rather than failing to apply.

Two features added in 0.3.0 need more than the floor does, so the minimum is per feature rather than per
package: **Fast mode** needs `0.1.7` (a preset is an `@deepseek-ai/dsh-agent-preset` composition row, and
0.1.7 replaced the `$DSH_HOME/.agent-presets` discovery), and the **concurrency patch** needs `0.1.7`,
because it matches those core files exactly.

## In detail

[docs/internals.md](docs/internals.md) covers the design: the worktree lifecycle, the patch contracts, the
archive and its storage, and the configuration keys — [中文版](docs/internals.zh.md).

## License

MIT
