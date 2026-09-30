#!/usr/bin/env node
/**
 * The two sidebar behaviours this plugin needs from a core it does not own:
 * nested worktree grouping, and double-click on a session row to rename it.
 *
 * DSH's sidebar groups by workspace — one group per directory — and its records
 * carry no parent field, so a worktree is a group of its own whether or not it
 * looks like one. The grouping is one small function, so this patches it rather
 * than forking the browser: a plugin cannot nest without taking over the whole
 * `sidebar.workspaces` slot, which owns the header, search, every session row
 * and every workspace dialog.
 *
 * Two rules, because one is not enough. A workspace whose directory is inside
 * another's folds into it — that covers a worktree kept inside the project. A
 * worktree kept outside it (the plugin's default, `$DSH_HOME/worktree/<code>`)
 * is covered by a parent map the plugin publishes, read from localStorage so it
 * is available synchronously on the very first render after a reload.
 *
 * Each patch carries its own marker, so an install that already has one of
 * them still receives the other; a single marker would have made the second
 * patch invisible to everyone who had run the first. Idempotent, and
 * reversible with `--revert`. A DSH upgrade restores the original file, so
 * re-run this after one.
 *
 * Usage:
 *   node tools/patch-sidebar-grouping.mjs [--target <client.js>] [--revert] [--check]
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const MARKER = 'gord-dsh-worktree: nested worktree grouping'

const ORIGINAL = `function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			for (const workspace of workspaces) {
				const members = [];
				for (const id of workspace.sessionIds) {
					const summary = list.byId[id];
					if (summary === void 0) continue;
					accounted.add(id);
					if (!sessionVisible(summary, list.current, archived)) continue;
					members.push(summary);
				}
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members, "account"));
			}`

const PATCHED = `// ${MARKER}
		//
		// The project a worktree belongs to, or undefined when it is not one. The
		// sidebar's hierarchy is one level deep — a workspace group, then session
		// rows — and the workspace record carries no parent field, so folding is
		// the only way a worktree's sessions can sit under the project they were
		// cut from instead of beside it as a second project.
		function projectWorkspace(workspaces, workspace) {
			const path = workspace.path;
			if (typeof path !== "string") return;
			let best;
			for (const candidate of workspaces) {
				if (typeof candidate.path !== "string" || candidate.path === path) continue;
				const prefix = candidate.path.endsWith("/") ? candidate.path : candidate.path + "/";
				if (path.startsWith(prefix) && (best === void 0 || candidate.path.length > best.path.length)) best = candidate;
			}
			if (best !== void 0) return best;
			// Outside every workspace's directory: a worktree kept in a home
			// directory, declared by the plugin that made it. Absent or stale
			// entries simply do not fold.
			try {
				const declared = JSON.parse(globalThis.localStorage?.getItem("gord-worktree:parents") ?? "{}");
				const parent = declared[path];
				if (typeof parent !== "string") return;
				return workspaces.find((candidate) => candidate.path === parent);
			} catch {
				return;
			}
		}
		function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			const membersByProject = /* @__PURE__ */ new Map();
			for (const workspace of workspaces) {
				const owner = projectWorkspace(workspaces, workspace) ?? workspace;
				const members = membersByProject.get(owner.workspaceId) ?? [];
				for (const id of workspace.sessionIds) {
					const summary = list.byId[id];
					if (summary === void 0) continue;
					accounted.add(id);
					if (!sessionVisible(summary, list.current, archived)) continue;
					members.push(summary);
				}
				membersByProject.set(owner.workspaceId, members);
			}
			for (const workspace of workspaces) {
				if (projectWorkspace(workspaces, workspace) !== void 0) continue;
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, membersByProject.get(workspace.workspaceId) ?? [], "account"));
			}`

const ACCOUNT_ORIGINAL = `function owningGroupKey(workspaces, sessionId) {
			return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId ?? "";
		}`

const ACCOUNT_PATCHED = `function owningGroupKey(workspaces, sessionId) {
			// Folded the way the grouping folds it. This key is the account whose
			// manual order the current blank session is promoted to the top of, and
			// a folded worktree has no group of its own to be promoted within.
			const owner = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId));
			if (owner === void 0) return "";
			return (projectWorkspace(workspaces, owner) ?? owner).workspaceId;
		}`

const RENAME_MARKER = 'gord-dsh-worktree: double-click a session to rename it'

const ROW_ORIGINAL = `					role: "treeitem",
					"aria-selected": selected,
					onClick: () => {
						onOpen(node.id);
					},`

const ROW_PATCHED = `					role: "treeitem",
					"aria-selected": selected,
					onClick: () => {
						onOpen(node.id);
					},
					// ${RENAME_MARKER}
					//
					// The row's own menu already offers Rename, but reaching it
					// costs a hover and two clicks, and a title is the one thing
					// about a session worth fixing on sight. Blank sessions are
					// skipped to match that menu, which hides its actions for them:
					// their title is provisional until the first message names
					// them, so an edit there would be overwritten rather than kept.
					onDoubleClick: () => {
						if (row.blank || onRename === void 0) return;
						onRename(node.id, row.title);
					},`

const LIST_MARKER = 'gord-dsh-worktree: nested worktree grouping (session list)'

// dsh 0.1.7 widened this function with an archived filter. Same grouping, one
// more parameter — and an anchor for the old shape never matches it, so the
// session list silently stayed unpatched while the workspace tree was patched,
// which is the state a worktree shows up in as its own group.
const LIST_ORIGINAL = `function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
			const current = mainSessionId(list);
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			for (const workspace of workspaces) {
				const members = [];`

const LIST_PATCHED = `// ${LIST_MARKER}
		//
		// The project a worktree belongs to, or undefined when it is not one. The
		// sidebar's hierarchy is one level deep — a workspace group, then session
		// rows — and the workspace record carries no parent field, so folding is
		// the only way a worktree's sessions can sit under the project they were
		// cut from instead of beside it as a second project.
		function projectWorkspace(workspaces, workspace) {
			const path = workspace.path;
			if (typeof path !== "string") return;
			let best;
			for (const candidate of workspaces) {
				if (typeof candidate.path !== "string" || candidate.path === path) continue;
				const prefix = candidate.path.endsWith("/") ? candidate.path : candidate.path + "/";
				if (path.startsWith(prefix) && (best === void 0 || candidate.path.length > best.path.length)) best = candidate;
			}
			if (best !== void 0) return best;
			// Outside every workspace's directory: a worktree kept in a home
			// directory, declared by the plugin that made it. Absent or stale
			// entries simply do not fold.
			try {
				const declared = JSON.parse(globalThis.localStorage?.getItem("gord-worktree:parents") ?? "{}");
				const parent = declared[path];
				if (typeof parent !== "string") return;
				return workspaces.find((candidate) => candidate.path === parent);
			} catch {
				return;
			}
		}
		function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
			const current = mainSessionId(list);
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			const membersByProject = /* @__PURE__ */ new Map();
			for (const workspace of workspaces) {
				const owner = projectWorkspace(workspaces, workspace) ?? workspace;
				const members = membersByProject.get(owner.workspaceId) ?? [];`

const LIST_TAIL_ORIGINAL = `				if (archivedFilter === "only" && members.length === 0) continue;
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members));
			}`

const LIST_TAIL_PATCHED = `				membersByProject.set(owner.workspaceId, members);
			}
			for (const workspace of workspaces) {
				if (projectWorkspace(workspaces, workspace) !== void 0) continue;
				const members = membersByProject.get(workspace.workspaceId) ?? [];
				if (archivedFilter === "only" && members.length === 0) continue;
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members));
			}`

const TREE_MARKER = 'gord-dsh-worktree: nested worktree grouping (workspace tree)'

const TREE_ORIGINAL = `		function owningParentFolder(path, parents) {
			const child = folderPath(path);
			let owner;
			let length = -1;
			for (const parent of parents) {
				const root = folderPath(parent);
				if (root.length > length && child !== root && child.startsWith(\`\${root}/\`)) {
					owner = parent;
					length = root.length;
				}
			}
			return owner;
		}`

const TREE_PATCHED = `		// ${TREE_MARKER}
		//
		// The path rule below folds one Workspace into another only when the
		// child's directory sits inside it. A worktree this plugin creates outside
		// its project — the default parent is $DSH_HOME/worktree — is nobody's
		// child by path, so those pairs are published as { <worktree path>:
		// <project path> } in localStorage instead: a map rather than a fetch,
		// because the first render after a reload needs the answer synchronously.
		// Entries for paths that are gone fold nothing, and a parent that is not a
		// registered Workspace — or that is the child itself, or inside it — is
		// ignored, which is what keeps this honest when the map is stale.
		function owningParentFolder(path, parents) {
			const child = folderPath(path);
			let owner;
			let length = -1;
			for (const parent of parents) {
				const root = folderPath(parent);
				if (root.length > length && child !== root && child.startsWith(\`\${root}/\`)) {
					owner = parent;
					length = root.length;
				}
			}
			if (owner !== void 0) return owner;
			try {
				const declared = JSON.parse(globalThis.localStorage?.getItem("gord-worktree:parents") ?? "{}");
				const parent = declared[path];
				if (typeof parent !== "string" || !parents.includes(parent)) return void 0;
				const root = folderPath(parent);
				return root === child || child.startsWith(\`\${root}/\`) ? void 0 : parent;
			} catch {
				return;
			}
		}`

/**
 * One behaviour, and every way this plugin knows to install it.
 *
 * A variant is the unit of idempotence: its marker means the file already
 * carries it. Variants are tried newest first, and a marker found anywhere wins
 * over an anchor set — which is what lets a patched file be recognized even
 * after the anchors around it changed.
 *
 * `nativeWhen` is the honest escape for a behaviour the build grew on its own:
 * 0.1.7 gave the session row the double-click rename this patch used to add, so
 * there the patch has nothing left to install and says so instead of reporting
 * a missing anchor.
 */
const BEHAVIOURS = [
  {
    // The session list is what the left sidebar shows, and it is a separate
    // patch site from the workspace tree: one behaviour per site, so a build
    // that moved one of them on cannot hide the other.
    what: 'nested worktree grouping (session list)',
    variants: [
      {
        family: 'the 0.1.7 session list',
        marker: LIST_MARKER,
        replacements: [
          { original: LIST_ORIGINAL, patched: LIST_PATCHED, what: 'the workspace grouping' },
          { original: LIST_TAIL_ORIGINAL, patched: LIST_TAIL_PATCHED, what: 'the group assembly' },
          { original: ACCOUNT_ORIGINAL, patched: ACCOUNT_PATCHED, what: 'the blank-session account key' },
        ],
      },
      {
        family: 'the 0.1.5 inline grouping',
        marker: MARKER,
        replacements: [
          { original: ORIGINAL, patched: PATCHED, what: 'the workspace grouping' },
          { original: ACCOUNT_ORIGINAL, patched: ACCOUNT_PATCHED, what: 'the blank-session account key' },
        ],
      },
    ],
  },
  {
    what: 'nested worktree grouping (workspace tree)',
    variants: [
      {
        family: 'the 0.1.6+ tree view',
        marker: TREE_MARKER,
        replacements: [{ original: TREE_ORIGINAL, patched: TREE_PATCHED, what: 'the worktree ownership rule' }],
      },
    ],
  },
  {
    what: 'double-click to rename a session',
    nativeWhen: (text) => text.includes('onDoubleClick:') && text.includes('onRenameRequest('),
    nativeNote: 'provided by dsh 0.1.7+',
    variants: [
      {
        family: 'the 0.1.5/0.1.6 session row',
        marker: RENAME_MARKER,
        replacements: [{ original: ROW_ORIGINAL, patched: ROW_PATCHED, what: 'the session row' }],
      },
    ],
  },
]

/**
 * What this file is, per behaviour.
 *
 * `patched` and `original` are the two patchable states, `native` is a build
 * that ships the behaviour itself, and `unknown` means the script has no anchor
 * for this build and must not write anything.
 */
/**
 * Whether a marker is on a line of its own.
 *
 * Markers are comments, so a line that ends with one is a patch that is really
 * there. Matching the substring is not enough: the session-list marker is a
 * prefix of the workspace-tree marker, so a build patched at only the tree site
 * reported both as patched and the missing one was never installed.
 */
function markerPresent(text, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*$`, 'm').test(text)
}

function inspect(text) {
  return BEHAVIOURS.map((behaviour) => {
    const patched = behaviour.variants.find((variant) => markerPresent(text, variant.marker))
    if (patched !== undefined) return { behaviour, variant: patched, status: 'patched' }
    if (behaviour.nativeWhen?.(text) === true) return { behaviour, status: 'native' }
    const variant = behaviour.variants.find((candidate) =>
      candidate.replacements.every((entry) => text.includes(entry.original)),
    )
    if (variant !== undefined) return { behaviour, variant, status: 'original' }
    return { behaviour, status: 'unknown' }
  })
}

/**
 * The tree view is what makes the grouping visible, and 0.1.6+ defaults to the
 * plain per-workspace grouping — a worktree in its own group rather than under
 * its project. Nothing here writes the user's view options, so the note is all
 * this can say.
 */
const treeView = (rows) => rows.some((row) => row.variant?.family === 'the 0.1.6+ tree view')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const BUNDLE = ['node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js']

/**
 * Locate the installed browser bundle.
 *
 * The `dsh` binary is the reliable anchor: this plugin is installed into a
 * profile, not next to the core, so resolving from here would look in the
 * profile's own node_modules and find nothing. `dsh` itself is a symlink into
 * the install, and walking up from its real path reaches the core packages.
 */
function resolveTarget() {
  const explicit = value('--target')
  if (explicit !== undefined) return explicit
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-workspace/package.json')), 'lib', 'client.js')
  } catch {
    // Not a dependency of this package; fall through to the install.
  }
  let bin
  try {
    bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  if (bin === '') return undefined
  let directory = dirname(realpathSync(bin))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, ...BUNDLE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

const target = resolveTarget()
if (target === undefined || !existsSync(target)) {
  process.stderr.write(`could not find the workspace browser bundle${target === undefined ? '' : ` at ${target}`}\n`)
  process.stderr.write('pass --target <path to dsh-client-ui-workspace/lib/client.js>\n')
  process.exit(1)
}

const backup = `${target}.orig`
const source = readFileSync(target, 'utf8')
const rows = inspect(source)
const describeRole = (row) => {
  if (row.status === 'patched') return ` (${row.variant.family})`
  if (row.status === 'native') return ` (${row.behaviour.nativeNote})`
  if (row.status === 'original') return ` (${row.variant.family})`
  return ''
}
const pending = rows.filter((row) => row.status === 'original')
const unknown = rows.filter((row) => row.status === 'unknown')

if (flag('--check')) {
  for (const row of rows) {
    process.stdout.write(`${row.status.padEnd(8)} ${row.behaviour.what}${describeRole(row)}\n`)
  }
  process.stdout.write(`${target}\n`)
  if (unknown.length > 0) {
    for (const row of unknown) {
      process.stderr.write(`not in the expected shape: ${row.behaviour.what} at ${target}\n`)
    }
    process.stderr.write('this DSH build differs; the patch needs updating rather than forcing\n')
    process.exit(1)
  }
  process.exit(pending.length === 0 ? 0 : 2)
}

if (flag('--revert')) {
  if (!rows.some((row) => row.status === 'patched')) {
    process.stdout.write(`nothing to revert: ${target} carries none of these patches\n`)
    process.exit(0)
  }
  if (!existsSync(backup)) {
    process.stderr.write(`no backup at ${backup}; reinstall the package to restore it\n`)
    process.exit(1)
  }
  copyFileSync(backup, target)
  process.stdout.write(`reverted ${target}\n`)
  process.exit(0)
}

if (unknown.length > 0) {
  for (const row of unknown) {
    process.stderr.write(`not in the expected shape: ${row.behaviour.what} at ${target}\n`)
  }
  process.stderr.write('this DSH build differs; the patch needs updating rather than forcing\n')
  process.exit(1)
}

if (pending.length === 0) {
  process.stdout.write(`already patched: ${target}\n`)
  process.exit(0)
}

// Anchors are matched per behaviour before anything is written, so a build that
// has moved on leaves the file untouched instead of half patched.
if (!existsSync(backup)) copyFileSync(target, backup)
let next = source
for (const row of pending) {
  for (const entry of row.variant.replacements) next = next.replace(entry.original, entry.patched)
}
writeFileSync(target, next)
for (const row of pending) process.stdout.write(`patched ${row.behaviour.what}\n`)
for (const row of rows) {
  if (row.status === 'native') process.stdout.write(`nothing to do: ${row.behaviour.what} is ${row.behaviour.nativeNote}\n`)
}
if (treeView([...rows.filter((row) => row.status !== 'unknown')])) {
  process.stdout.write('pick Group by \u2192 Workspace tree in the sidebar for the nesting to show\n')
}
process.stdout.write(`restart dsh web for the sidebar to pick it up\n`)
