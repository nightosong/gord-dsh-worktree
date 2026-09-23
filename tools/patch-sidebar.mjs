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

/**
 * One behaviour, its marker, and the replacements that install it.
 *
 * A group is the unit of idempotence: it is applied when its marker is absent,
 * so adding a group to this file still reaches an install that already carries
 * the others.
 */
const GROUPS = [
  {
    marker: MARKER,
    what: 'nested worktree grouping',
    replacements: [
      { original: ORIGINAL, patched: PATCHED, what: 'the workspace grouping' },
      { original: ACCOUNT_ORIGINAL, patched: ACCOUNT_PATCHED, what: 'the blank-session account key' },
    ],
  },
  {
    marker: RENAME_MARKER,
    what: 'double-click to rename a session',
    replacements: [{ original: ROW_ORIGINAL, patched: ROW_PATCHED, what: 'the session row' }],
  },
]

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
const pending = GROUPS.filter((group) => !source.includes(group.marker))

if (flag('--check')) {
  for (const group of GROUPS) {
    process.stdout.write(`${source.includes(group.marker) ? 'patched ' : 'original'} ${group.what}\n`)
  }
  process.stdout.write(`${target}\n`)
  process.exit(pending.length === 0 ? 0 : 2)
}

if (flag('--revert')) {
  if (pending.length === GROUPS.length) {
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

if (pending.length === 0) {
  process.stdout.write(`already patched: ${target}\n`)
  process.exit(0)
}

// Every replacement of every pending group is checked before any is written, so
// a build that has moved on leaves the file untouched instead of half patched.
const missing = pending.flatMap((group) => group.replacements).filter((entry) => !source.includes(entry.original))
if (missing.length > 0) {
  for (const entry of missing) {
    process.stderr.write(`not in the expected shape: ${entry.what} at ${target}\n`)
  }
  process.stderr.write('this DSH build differs; the patch needs updating rather than forcing\n')
  process.exit(1)
}

// Kept before the first patch, so a revert always restores what shipped rather
// than a previous patch of ours.
if (!existsSync(backup)) copyFileSync(target, backup)
let next = source
for (const group of pending) {
  for (const entry of group.replacements) next = next.replace(entry.original, entry.patched)
}
writeFileSync(target, next)
for (const group of pending) process.stdout.write(`patched ${group.what}\n`)
process.stdout.write(`restart dsh web for the sidebar to pick it up\n`)
