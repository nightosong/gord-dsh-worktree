/**
 * gord-dsh-worktree — host half.
 *
 * Three contributions, all resting on the same `lib/service.js` operation
 * layer:
 *
 *   • a `worktree` service other host plugins can call directly;
 *   • five model-facing tools (`worktree_list/create/status/remove/prune`) so
 *     an agent can isolate its own work without shelling out to git;
 *   • a small JSON HTTP surface the browser panel calls, plus workspace
 *     adoption through `ctx.workspaceRegistry` and an optional
 *     `ctx.settings` namespace for the panel's defaults.
 *
 * The HTTP routes are gated on same-origin/loopback callers because DSH keeps
 * no session cookie: without the check any web page that can reach the port
 * could run git in the user's repositories.
 *
 * @module gord-dsh-worktree
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as archive from './archive.js'
import * as worktrees from './service.js'
import { WORKTREE_DIR, canonicalSpelling, defaultWorktreeParent, legacyWorktreeParent, repoInfo } from './worktree.js'
import { resolveProjectDir, positional, runGit } from './worktree.js'

/** Bumped with the package version; surfaced by `GET /gord-dsh-worktree/health`. */
export const PLUGIN_VERSION = '0.5.0'

/** Whether this host is the Electron desktop application rather than `dsh web`. */
export function isDesktopHost() {
  return typeof process !== 'undefined' && process.versions !== undefined && process.versions.electron !== undefined
}

/** The last bundle-patch report, surfaced by the health route. */
let lastPatchReport = []

/**
 * The one patch this plugin ensures on load: nested worktree grouping.
 *
 * Installing the plugin cannot install it: `dsh plugin add` hands its arguments
 * to pnpm, and pnpm runs no lifecycle script for a `link:` package — which is how
 * this plugin is normally installed — so the install step has nowhere to hook.
 * Loading it is the moment that does work, and it is also the moment that
 * matters: a DSH upgrade restores the file it patches, the plugin still loads,
 * and only the behaviour goes missing. Leaving it out is not an option either:
 * the 0.1.x sidebar has no nesting of its own, so without the patch a worktree
 * is a project of its own there while the desktop nests it natively — the two
 * shells would disagree about the same repository.
 *
 * Safe unattended because the tool refuses a build whose anchors have moved and
 * writes nothing then, keeps a backup beside the file, and reverts on demand.
 *
 * The concurrency patch is deliberately not in this list: it edits core tool
 * packages, so it stays the manual step it is documented as
 * (`npm run patch:concurrency`). That also keeps `bash`/`glob`/`grep` scheduling
 * alike on both hosts, since the desktop's signed bundle can never carry it.
 */
const BUNDLE_PATCHES = [
  { tool: 'patch-sidebar.mjs', what: '侧栏嵌套分组' },
]

const runBundleTool = (tool, args) =>
  spawnSync(process.execPath, [fileURLToPath(new URL(`../tools/${tool}`, import.meta.url)), ...args], { encoding: 'utf8' })

/**
 * Make sure every shipped bundle patch is installed, and report what happened.
 *
 * `--check` is asked first: 0 means every site is patched and nothing is
 * written, 2 means the anchors match and the patch is missing, and anything else
 * means this DSH build is not the shape the tools know — the case worth warning
 * about, because the plugin keeps working while the feature quietly does not.
 *
 * @param {{info?: Function, warn?: Function, debug?: Function}} [log] - DSH logger.
 * @param {(tool: string, args: string[]) => object} [run] - runs one tool; injected by tests.
 * @param {{desktop?: boolean}} [options] - host kind; injected by tests.
 * @returns {Array<{tool: string, state: 'ready'|'patched'|'desktop'|'unknown'}>} one row per patch.
 */
export function ensureBundlePatches(log, run = runBundleTool, options = {}) {
  // The desktop application serves its core from inside a signed `app.asar`:
  // the bundle the sidebar is built from cannot be rewritten, and the writable
  // copy a patch would land in is one that host never loads. Patching there is
  // not partial success but a silent no-op, so it is skipped and said out loud.
  // The desktop nests worktrees natively instead — its `workspace-tree`
  // grouping, plus a worktree directory that really is inside the project.
  if (options.desktop ?? isDesktopHost()) {
    log?.warn?.(
      'gord-dsh-worktree: 桌面应用的核心界面在签名包内，跳过侧栏折叠补丁；桌面端请用侧栏的「按工作区树」分组，并把工作树放在项目目录内',
    )
    return BUNDLE_PATCHES.map((entry) => ({ tool: entry.tool, state: 'desktop' }))
  }
  const results = []
  for (const entry of BUNDLE_PATCHES) {
    let checked
    try {
      checked = run(entry.tool, ['--check'])
    } catch (error) {
      log?.warn?.(`gord-dsh-worktree: ${entry.what}补丁无法检查：${String(error?.message ?? error)}`)
      results.push({ tool: entry.tool, state: 'unknown' })
      continue
    }
    if (checked.status === 0) {
      results.push({ tool: entry.tool, state: 'ready' })
      continue
    }
    if (checked.status !== 2) {
      const first = String(checked.stderr ?? '').trim().split('\n')[0]
      log?.warn?.(
        `gord-dsh-worktree: ${entry.what}补丁未安装，且这个 DSH 版本的形状与工具不符，需要更新插件${first === '' ? '' : `：${first}`}`,
      )
      results.push({ tool: entry.tool, state: 'unknown' })
      continue
    }
    const applied = run(entry.tool, [])
    if (applied.status === 0) {
      log?.info?.(`gord-dsh-worktree: 已为${entry.what}打上补丁，重启一次 dsh web 生效`)
      results.push({ tool: entry.tool, state: 'patched' })
      continue
    }
    const first = String(applied.stderr ?? '').trim().split('\n')[0]
    log?.warn?.(`gord-dsh-worktree: ${entry.what}补丁未打上${first === '' ? '' : `：${first}`}`)
    results.push({ tool: entry.tool, state: 'unknown' })
  }
  if (results.every((row) => row.state === 'ready')) log?.debug?.('gord-dsh-worktree: bundle patches ready')
  return results
}

/** Services whose activation this plugin waits for. */
export const inject = ['tools']

/**
 * Panel defaults. `defaultParent` empty means `<project>/.dsh/worktrees`, the
 * directory inside the project that both sidebar generations nest under it.
 */
export const Config = z.object({
  defaultParent: z.string().default(''),
})

const NS = 'gord-worktree'
/** Read-only metadata endpoint the panel uses to identify the host half. */
const HEALTH_PATH = '/gord-dsh-worktree/health'
const ROUTES_PATH = '/gord-dsh-worktree/api'
/** Guard against a pathologically large request body on the mutate route. */
const MAX_BODY_BYTES = 64 * 1024

/** The session's own directory, i.e. the same anchor the bash tool uses. */
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

/** Read the four fields every tool accepts to decide which repository to use. */
function targetArgs(args) {
  return {
    workdir: args.workdir,
    dir: args.repo,
  }
}

/** JSON response helper shared by every route. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Whether a request may mutate the host.
 *
 * Two callers are legitimate: a direct loopback client (`curl` on the same
 * machine, which sends no Origin) and the DSH browser app itself, which the
 * host serves from its own origin. Everything else — including a page on
 * another site targeting `127.0.0.1` — is refused, because this surface runs
 * arbitrary git operations in the user's repositories.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} port - the listening port.
 * @returns {boolean} true when the caller is accepted.
 */
function sameOrigin(req, port) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  return loopback && (port === 0 || parsed.port === '' || Number(parsed.port) === port)
}

/** Read and parse a JSON request body, or undefined when it is absent/invalid. */
function readJsonBody(req) {
  return new Promise((settle) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        settle(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        settle({})
        return
      }
      try {
        const value = JSON.parse(text)
        settle(value !== null && typeof value === 'object' ? value : undefined)
      } catch {
        settle(undefined)
      }
    })
    req.on('error', () => settle(undefined))
  })
}

/**
 * Session ids from a request body.
 *
 * The two archive mutations name their targets explicitly rather than carrying
 * a "delete everything" flag: the panel sends back the ids it actually listed,
 * so a session archived between the listing and the click can never be swept
 * up by a button the user pressed while looking at a different set.
 *
 * @param {unknown} value - the request's `ids` field.
 * @returns {string[]|undefined} ids, or undefined when the field is unusable.
 */
function idList(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const ids = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id !== '') ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

/**
 * Worktree operations exposed to the model.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugout context (tools available).
 * @param {{ get: () => { defaultParent: string } }} settings - resolved panel settings.
 * @returns {Array<() => void>} disposers for the registered tools.
 */
function registerTools(ctx, settings) {
  const list = ctx.tools.register(
    defineTool({
      name: 'worktree_list',
      description:
        'List the git worktrees of a repository: absolute path, branch, HEAD, and whether each is the current, detached, locked, or pruned one. ' +
        'Also returns every local and remote-tracking branch, which is what to consult before naming a base for worktree_create — ' +
        'picking up a branch that exists only on a remote means naming it in `branch` with no `base`, not inventing a base. ' +
        'Use it before creating or removing a worktree so the decision is based on the real state rather than an assumption. ' +
        'Resolves the repository from the session directory unless workdir/repo says otherwise.',
      parameters: {
        workdir: {
          type: 'string',
          description: 'Directory inside the repository to inspect; absolute, or relative to the session directory. Defaults to the session directory.',
        },
        repo: {
          type: 'string',
          description: 'Alternative spelling of workdir, for when the repository is selected explicitly rather than implied by the session.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            root: { type: 'string', required: true },
            mainRoot: { type: 'string', required: true },
            branch: { type: 'string', required: true },
            dirty: { type: 'boolean', required: true },
            branches: {
              type: 'array',
              required: true,
              description: 'Local and remote-tracking branch names; the remote-tracking ones are valid `base` values.',
              items: { type: 'string' },
            },
            localBranches: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
            worktrees: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  branch: { type: 'string', required: true },
                  head: { type: 'string', required: true },
                  current: { type: 'boolean', required: true },
                  detached: { type: 'boolean', required: true },
                  bare: { type: 'boolean', required: true },
                  locked: { type: 'boolean', required: true },
                  pruned: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Repository ${value.mainRoot} (branch ${value.branch}${value.dirty ? ', uncommitted changes' : ''})\n` +
              `${worktrees.formatWorktrees(value.worktrees, undefined)}\n` +
              `Branches: ${value.branches.join(', ') || '(none)'}`,
          },
        ],
      },
      async execute(args, exec) {
        const dir = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const result = await worktrees.listWorktrees(dir, exec.signal)
        if (!result.ok) throw new Error(`${dir} is not inside a git repository`)
        return {
          root: result.root,
          mainRoot: result.mainRoot,
          branch: result.branch,
          dirty: result.dirty,
          branches: result.branches ?? [],
          localBranches: result.localBranches ?? [],
          worktrees: result.worktrees.map(worktrees.worktreeView),
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'List git worktrees',
        kind: 'read',
        rawInput: targetArgs(args),
      }),
    }),
  )

  const create = ctx.tools.register(
    defineTool({
      name: 'worktree_create',
      description:
        'Create an isolated git worktree on its own branch, so parallel work never collides in one checkout. ' +
        'The branch is created in the same atomic git command; an existing branch is checked out instead. ' +
        'Naming a branch that exists only on a remote checks that remote branch out from its real commit and tracks it — ' +
        'omit `base` for that; if you pass one anyway the remote is reported back in `shadowedRemote` so the shadowed branch is never a silent surprise. ' +
        'The new directory goes to `$DSH_HOME/worktree/` by default — outside every repository, so it never ' +
        'appears in `git status` and needs no ignore rule. Its name is always a short random code, never the ' +
        'branch, because one branch can be checked out in several worktrees and a branch-named directory could ' +
        'not stay unique. Omit `branch` and the worktree holds the repository\'s current branch — a second ' +
        'checkout of the same line of work, not a new one. In a worktree the branch is yours to change: create or switch ' +
        'branches there with ordinary git when the task calls for it — changing branch does not need a new worktree. ' +
        '\n\n' +
        'A request to "work on this in a new worktree" mid-conversation: create it here, then do the work by passing ' +
        'the returned `path` as `workdir` to worktree_status and to later commands. A running session cannot be moved ' +
        'into a worktree — its directory is fixed when the session is created — so the conversation itself does not ' +
        'follow. Say which path you are working in rather than assuming the session moved. A session started from the ' +
        'New Session worktree dropdown is different: it is created rooted in its worktree, so it is already there.',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch to create or check out. Defaults to the repository\'s current branch, so the checkout is a copy of what the project is on.',
        },
        base: {
          type: 'string',
          description: 'Revision the new branch starts from (branch, tag, or commit). Defaults to the repository\'s current branch.',
        },
        path: {
          type: 'string',
          description: 'Absolute target directory, or a path relative to the repository root. Defaults to `$DSH_HOME/worktree/<code>`.',
        },
        parent: {
          type: 'string',
          description: 'Directory to create the worktree in when `path` is omitted.',
        },
        force: {
          type: 'boolean',
          description: 'Allow git to reuse a target directory that is not empty.',
        },
        workdir: {
          type: 'string',
          description: 'Directory inside the repository; absolute or relative to the session directory. Defaults to the session directory.',
        },
        repo: { type: 'string', description: 'Alternative spelling of workdir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            branch: { type: 'string', required: true },
            base: { type: 'string', required: true },
            createdBranch: { type: 'boolean', required: true },
            mainRoot: { type: 'string', required: true },
            pickedUpRemote: {
              type: 'string',
              description: 'Set when the new branch was started from this remote-tracking ref because no local branch of that name existed.',
            },
            shadowedRemote: {
              type: 'string',
              description: 'Set when an explicit base was honoured while a remote-tracking branch of the same name also existed.',
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Created worktree ${value.path} on ${value.createdBranch ? 'new branch' : 'existing branch'} ${value.branch} from ${value.base}.` +
              (value.pickedUpRemote === undefined ? '' : ` Picked up the remote branch ${value.pickedUpRemote} and set it as upstream.`) +
              (value.shadowedRemote === undefined
                ? ''
                : ` Note: remote branch ${value.shadowedRemote} of the same name exists but was not used, because ${value.base} was named as the base.`),
          },
        ],
      },
      async execute(args, exec) {
        const dir = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const result = await worktrees.createWorktree(
          {
            dir,
            branch: args.branch,
            base: args.base,
            path: args.path,
            parent: args.parent ?? (settings.get().defaultParent !== '' ? settings.get().defaultParent : undefined),
            force: args.force,
          },
          exec.signal,
        )
        if (!result.ok) throw new Error(result.message ?? result.error)
        // Remember which session asked for it: a worktree cut mid-conversation is
        // not where the session lives — its directory is fixed — but it is where
        // the session works, and its hover card follows that checkout's branch.
        await archive.rememberSessionWorktree(sessionCwd(exec), result.path)
        return {
          path: result.path,
          branch: result.branch,
          base: result.base,
          createdBranch: result.createdBranch,
          mainRoot: result.mainRoot,
          pickedUpRemote: result.pickedUpRemote,
          shadowedRemote: result.shadowedRemote,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Create worktree ${args.branch ?? ''}`.trim(),
        kind: 'move',
        rawInput: args,
      }),
    }),
  )

  const status = ctx.tools.register(
    defineTool({
      name: 'worktree_status',
      description:
        'Show one worktree\'s branch, upstream line, and changed files. ' +
        'Use it to decide whether a worktree can be removed without losing work, or to review what happened in it.',
      parameters: {
        path: {
          type: 'string',
          description: 'Worktree path, directory name, or branch. Defaults to the session directory.',
        },
        workdir: {
          type: 'string',
          description: 'Directory inside the repository; absolute or relative to the session directory. Defaults to the session directory.',
        },
        repo: { type: 'string', description: 'Alternative spelling of workdir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            branch: { type: 'string', required: true },
            dirty: { type: 'boolean', required: true },
            changes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.dirty
              ? `${value.path} (${value.branch}): ${value.changes.length} changed path(s)\n${value.changes.map((change) => `${change.code} ${change.path}`).join('\n')}`
              : `${value.path} (${value.branch}): clean`,
          },
        ],
      },
      async execute(args, exec) {
        const base = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const raw = args.path === undefined ? '' : String(args.path).trim()
        const dir = raw === '' || raw.startsWith('/') ? (raw === '' ? base : raw) : base
        const result = await worktrees.worktreeStatus(dir, exec.signal)
        if (!result.ok) throw new Error(`${dir} is not inside a git worktree`)
        return { path: result.path, branch: result.branch, dirty: result.dirty, changes: result.changes }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Worktree status',
        kind: 'read',
        rawInput: args.path ?? targetArgs(args),
      }),
    }),
  )

  const remove = ctx.tools.register(
    defineTool({
      name: 'worktree_remove',
      description:
        'Remove a worktree. Refuses by default when it holds uncommitted or untracked changes — pass force to discard them deliberately. ' +
        'The main worktree can never be removed. Set deleteBranch to also delete the branch (forced delete; its unmerged commits are dropped).',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Worktree path, directory name, or branch to remove.',
        },
        force: {
          type: 'boolean',
          description: 'Discard a dirty worktree instead of refusing.',
        },
        deleteBranch: {
          type: 'boolean',
          description: 'Also force-delete the branch the worktree was on.',
        },
        workdir: {
          type: 'string',
          description: 'Directory inside the repository; absolute or relative to the session directory. Defaults to the session directory.',
        },
        repo: { type: 'string', description: 'Alternative spelling of workdir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            removed: { type: 'string', required: true },
            branch: { type: 'string', required: true },
            branchDeleted: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Removed worktree ${value.removed}${value.branchDeleted ? ` and deleted branch ${value.branch}` : value.branch === '' ? '' : ` (branch ${value.branch} kept)`}.`,
          },
        ],
      },
      async execute(args, exec) {
        const dir = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const result = await worktrees.removeWorktree(
          {
            dir,
            path: positional(args.path, 'path'),
            force: args.force,
            deleteBranch: args.deleteBranch,
          },
          exec.signal,
        )
        if (!result.ok) throw new Error(result.message ?? result.error)
        return { removed: result.removed, branch: result.branch, branchDeleted: result.branchDeleted }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Remove worktree ${args.path}`,
        kind: 'delete',
        rawInput: args,
      }),
    }),
  )

  const prune = ctx.tools.register(
    defineTool({
      name: 'worktree_prune',
      description:
        'Drop administrative records of worktrees whose directories are gone (deleted by hand, or on a removed drive). ' +
        'Without dryRun it also expires stale locked records. It never deletes a directory.',
      parameters: {
        dryRun: { type: 'boolean', description: 'Report what would be pruned without changing anything.' },
        workdir: {
          type: 'string',
          description: 'Directory inside the repository; absolute or relative to the session directory. Defaults to the session directory.',
        },
        repo: { type: 'string', description: 'Alternative spelling of workdir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dryRun: { type: 'boolean', required: true },
            output: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.output.trim() === '' ? (value.dryRun ? 'Nothing to prune.' : 'Pruned.') : value.output.trim(),
          },
        ],
      },
      async execute(args, exec) {
        const dir = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const described = await worktrees.describeRepository(dir, exec.signal)
        if (!described.ok) throw new Error(`${dir} is not inside a git repository`)
        const argv = ['worktree', 'prune', ...(args.dryRun === true ? ['--dry-run'] : [])]
        const res = await runGit(argv, { cwd: described.root, signal: exec.signal })
        if (!res.ok) throw new Error(res.message)
        return { dryRun: args.dryRun === true, output: res.stdout + res.stderr }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.dryRun === true ? 'Prune worktrees (dry run)' : 'Prune worktrees',
        kind: 'other',
        rawInput: targetArgs(args),
      }),
    }),
  )

  const relocate = ctx.tools.register(
    defineTool({
      name: 'worktree_relocate',
      description:
        "Move this repository's worktrees that earlier releases left in the shared `$DSH_HOME/worktree` into the project " +
        '(`.dsh/worktrees/`), leaving a symlink at each old path so sessions made there keep working. A checkout made ' +
        'anywhere else is left alone, and a record whose directory is gone is only reported. Idempotent.',
      parameters: {
        workdir: {
          type: 'string',
          description: 'Directory inside the repository; absolute or relative to the session directory. Defaults to the session directory.',
        },
        repo: { type: 'string', description: 'Alternative spelling of workdir.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            moved: { type: 'array', required: true, items: { type: 'string' } },
            output: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.output.trim() === '' ? 'Nothing to move.' : value.output.trim() }],
      },
      async execute(args, exec) {
        const dir = resolveProjectDir(targetArgs(args), sessionCwd(exec))
        const result = await worktrees.relocateWorktrees({ dir }, exec.signal)
        if (result.ok !== true) throw new Error(`${dir} is not inside a git repository`)
        const lines = result.moved.map((row) => `${row.to}${row.linked ? '' : ' (no symlink left behind)'}`)
        const failures = result.failed.map((row) => `${row.path}: ${row.message}`)
        return {
          moved: result.moved.map((row) => row.to),
          output: [...lines, ...failures].join('\n'),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Move worktrees into the project', kind: 'other', rawInput: {} }),
    }),
  )

  return [list, create, status, remove, prune, relocate]
}

/**
 * Point the workspace of each relocated worktree at its new directory.
 *
 * The registry has no path update — a workspace *is* its directory — so this is a
 * hand-over: a workspace at the new path inherits the old record's title and
 * sessions, and the old record is retired. Attaching is validated against the
 * canonical form of a session's recorded directory, and the symlink left at the
 * old path resolves to the new one, which is exactly what lets a session made in
 * the old location land in the new group instead of falling out of the sidebar.
 *
 * @param {unknown} registry - the workspace registry, or undefined.
 * @param {Array<{from: string, to: string}>} moved - relocation receipt rows.
 * @returns {Promise<Array<object>>} one row per worktree handed over.
 */
/**
 * Workspace records that still name a worktree's old path after the checkout has
 * moved into the project.
 *
 * The registry has no path update, so a relocation whose hand-over failed — or
 * one interrupted between the move and the hand-over — leaves a record pointing
 * into the legacy home. By then the old path is a symlink into the project, so
 * canonicalizing it says where the worktree really is, and running the
 * relocation again finishes the job. A record whose directory is gone does not
 * resolve and is left alone.
 *
 * @param {readonly object[]} known - workspace records, as the registry lists them.
 * @param {string} root - the repository's main root.
 * @returns {Array<{from: string, to: string}>} rows to hand over.
 */
export function unfinishedRelocations(known, root) {
  const legacyRoot = legacyWorktreeParent()
  const managedRoot = defaultWorktreeParent(root)
  const rows = []
  for (const workspace of known) {
    if (typeof workspace?.path !== 'string' || !workspace.path.startsWith(`${legacyRoot}/`)) continue
    const target = canonicalSpelling(workspace.path)
    if (target !== workspace.path && target.startsWith(`${managedRoot}/`)) rows.push({ from: workspace.path, to: target })
  }
  return rows
}

/**
 * The title of the workspace a session runs in.
 *
 * A workspace's own title already reads the way the sidebar labels it — `app` for
 * a project, `app · ed466e1a` for a worktree cut from it — so nothing has to be
 * composed here, and the session hover card can name the workspace above the
 * session without the client knowing how a worktree is spelled.
 *
 * @param {readonly object[]} known - workspace records, as the registry lists them.
 * @param {string} sessionId - the session to place.
 * @returns {string} its workspace title, or '' when no workspace claims it.
 */
export function workspaceTitleOf(known, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const hit = (Array.isArray(known) ? known : []).find(
    (row) => typeof row?.title === 'string' && Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId),
  )
  return hit === undefined ? '' : hit.title.trim()
}

/**
 * The workspace rows that are only a worktree of another workspace.
 *
 * A sidebar tree gives every registered workspace a row, so a worktree adds a
 * folder line above its own sessions. Hiding that line is a display choice made
 * in the browser: the row is only the group's header, so the sessions keep
 * rendering one level up, the workspace stays registered, and one click brings
 * the line back. Only a worktree a live session lives in is named — one with
 * none keeps its row, because that row is the only way to reach its own `+` and
 * `…` actions.
 *
 * @param {readonly object[]} known - workspace records, as the registry lists them.
 * @param {readonly string[]|Set<string>} [archived] - session ids the archive holds.
 * @returns {string[]} the ids to hide.
 */
export function worktreeRowIds(known, archived = []) {
  const rows = (Array.isArray(known) ? known : []).filter(
    (row) => typeof row?.path === 'string' && row.path !== '' && typeof row.id === 'string' && row.id !== '',
  )
  const archivedIds = archived instanceof Set ? archived : new Set(Array.isArray(archived) ? archived : [])
  return rows
    .filter((row) => Array.isArray(row.sessionIds) && row.sessionIds.some((id) => !archivedIds.has(id)))
    .filter((row) =>
      rows.some(
        (other) =>
          other.path !== row.path && row.path.startsWith(`${other.path.replace(/\/+$/, '')}/${WORKTREE_DIR}/`),
      ),
    )
    .map((row) => row.id)
}

export async function repointWorkspaces(registry, moved) {
  if (registry === undefined || registry === null || !Array.isArray(moved) || moved.length === 0) return []
  let known = []
  try {
    known = typeof registry.list === 'function' ? registry.list() ?? [] : []
  } catch {
    known = []
  }
  const rows = []
  for (const row of moved) {
    const old = known.find((workspace) => workspace.path === row.from || workspace.path === canonicalSpelling(row.from))
    try {
      const created = await registry.create(row.to, old === undefined ? undefined : old.title)
      let attached = 0
      if (created !== undefined && typeof created.attachSession === 'function') {
        for (const id of old?.sessionIds ?? []) {
          try {
            await created.attachSession(id)
            attached += 1
          } catch {
            // A session whose directory did not survive the move stays where it
            // is; the row reports how many made it across.
          }
        }
      }
      let retired = false
      if (old !== undefined && typeof registry.delete === 'function') {
        try {
          await registry.delete(old.id)
          retired = true
        } catch {
          retired = false
        }
      }
      rows.push({ from: row.from, to: row.to, workspaceId: created?.id, sessions: attached, retired })
    } catch (error) {
      rows.push({ from: row.from, to: row.to, error: String(error?.message ?? error) })
    }
  }
  return rows
}

/**
 * Register the browser-facing HTTP surface.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ get: () => { defaultParent: string } }} settings - resolved panel settings.
 * @param {(dir: string) => Promise<object | undefined>} repoSummary - per-directory cache of {@link worktrees.listWorktrees}.
 */
/**
 * Sidebar title for a worktree's workspace.
 *
 * The project's own name first, because that is the grouping the sidebar cannot
 * express: a worktree belongs to the project it was cut from, but DSH groups by
 * directory, so the title is the only place that relationship can be shown.
 *
 * @param {{ repoRoot?: string, path: string }} result - a create result.
 * @returns {string} title such as `repo · 1dda6ec0`.
 */
function worktreeTitle(result) {
  const project = basename(result.repoRoot ?? '')
  const leaf = basename(result.path)
  return project === '' || project === leaf ? leaf : `${project} · ${leaf}`
}

/**
 * The repositories inside a directory that is not itself one.
 *
 * A workspace is very often a container of projects rather than a project —
 * `apifree` holds `backend/rest-atlas`, `backend/oms-atlas` and five frontends —
 * so a session parked in one would otherwise never find a repository to cut a
 * worktree from, which is what the control is for. Before this, such a
 * workspace was simply not a project, and every ask ended in "no repository".
 *
 * Deliberately bounded: three levels down, `node_modules` and dot-directories
 * skipped, and a directory that is itself a repository is not descended into —
 * otherwise a checkout would contribute its vendored copies as projects too.
 *
 * `activity` is the last write to the repository's own git metadata, which is
 * the cheapest honest answer to "which of these was worked on last": it moves
 * on commit, checkout, fetch and status, unlike the commit date.
 *
 * @param {string} root - the directory to search.
 * @param {number} limit - how many levels below `root` to look.
 * @returns {Promise<Array<{path: string, activity: number}>>} repositories, deepest last.
 */
async function repositoriesUnder(root, limit = 3) {
  const found = []
  const walk = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // `.git` is a directory in a normal checkout and a file in a linked
    // worktree or a submodule; both are repositories.
    if (entries.some((entry) => entry.name === '.git')) {
      const stats = await stat(join(dir, '.git')).catch(() => undefined)
      found.push({ path: dir, activity: stats === undefined ? 0 : stats.mtimeMs })
      return
    }
    if (depth >= limit) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 1)
  return found
}

function registerRoutes(ctx, settings, repoSummary, workspaceRepos, archiveDeps) {
  const routes = [
    {
      path: HEALTH_PATH,
      handler: async () => ({
        ok: true,
        plugin: 'gord-dsh-worktree',
        version: PLUGIN_VERSION,
        node: process.versions.node,
      }),
    },
    {
      path: ROUTES_PATH,
      handler: async (req) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const action = url.searchParams.get('action') ?? 'health'
        if (req.method === 'GET') {
          const dir = url.searchParams.get('dir') ?? undefined
          if (action === 'status') return worktrees.worktreeStatus(dir ?? process.cwd())
          if (action === 'health') {
            return {
              ok: true,
              version: PLUGIN_VERSION,
              host: isDesktopHost() ? 'desktop' : 'web',
              patch: lastPatchReport,
            }
          }
          return { ok: false, error: 'bad-action', message: `unknown GET action ${JSON.stringify(action)}` }
        }
        const port = Number(ctx.webServer?.port ?? 0)
        if (!sameOrigin(req, Number.isFinite(port) ? port : 0)) {
          return { ok: false, error: 'forbidden', message: 'cross-origin request refused' }
        }
        const body = await readJsonBody(req)
        if (body === undefined) return { ok: false, error: 'bad-body', message: 'request body must be a JSON object' }
        const resolved = settings.get()
        const dir = typeof body.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : process.cwd()

        if (action === 'worktreeRows') {
          // Which workspace rows stand for a worktree of another workspace. Asked
          // once per page load: the browser hides those header lines, so the
          // sessions they hold render a level up instead of under a folder.
          const registry = archiveDeps().registry
          const known = typeof registry?.list === 'function' ? registry.list() ?? [] : []
          return { ok: true, rows: worktreeRowIds(known, registry?.archivedSessionIds) }
        }
        if (action === 'repos') {
          // The projects a worktree can be cut from: the caller's own workspace
          // first, so the answer to "which project" is the one the session is
          // in. `body.dir` is read raw here rather than defaulted to the
          // server's cwd — no directory means no preference, not this process.
          return {
            ok: true,
            repos: await workspaceRepos({
              sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
              dir: typeof body.dir === 'string' ? body.dir.trim() : '',
              // The workspace named in the composer's picker, for a session that
              // has no directory and is in no workspace yet.
              title: typeof body.title === 'string' ? body.title.trim() : '',
            }),
          }
        }
        // The branch of the directory a session runs in, for the sidebar's session
        // hover card. Read-only and deliberately small: one `rev-parse` per
        // request, no worktree listing, no diff. The client sends the directory it
        // already knows and the id, so the id is only needed as a fallback — and
        // to refuse an archived session, whose card should not grow a branch.
        if (action === 'branch') {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const registry = archiveDeps().registry
          // Whose workspace the session is, answered with the branch: the card
          // names the workspace above the session, and both facts come from one
          // request so a hover costs one round trip either way.
          const workspaces = typeof registry?.list === 'function' ? registry.list() ?? [] : []
          const workspace = workspaceTitleOf(workspaces, sessionId)
          if (sessionId !== '' && Array.isArray(registry?.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId)) {
            return { ok: true, archived: true, workspace }
          }
          const known = typeof body.dir === 'string' ? body.dir.trim() : ''
          const started = known !== '' ? known : await archive.sessionCwd(archiveDeps(), sessionId)
          if (started === '') return { ok: true, workspace }
          // A session that cut or moved into a worktree works there: the branch
          // it is on is that checkout's, not the one it was started from — which
          // this session never left, because a session's directory is fixed.
          const worked = await archive.sessionWorktree(started, sessionId)
          const target = worked !== '' && existsSync(worked) ? worked : started
          const info = await repoInfo(target).catch(() => undefined)
          if (info === undefined) return { ok: true, workspace }
          return { ok: true, root: info.mainRoot, branch: info.branch, workspace }
        }
        if (action === 'list') {
          // The panel asks for per-row dirtiness, because its removal dialog has
          // to warn before discarding work and offer the acknowledgement that
          // does it. That costs one `git status` per worktree, so the cached
          // summary — which the chip and the pickers share, and which is what
          // keeps a hover cheap — answers every caller that does not ask.
          const summary = body.dirty === true
            ? await worktrees.listWorktrees(dir, undefined, { dirty: true })
            : await repoSummary(dir)
          // Report the parent that will actually be used rather than the
          // built-in one: the panel prints this value, so a configured parent
          // has to show up in it.
          const effective = resolved.defaultParent !== '' ? resolved.defaultParent : summary.defaultParent
          return { ok: true, ...summary, defaultParent: effective, settings: resolved }
        }
        if (action === 'create') {
          const result = await worktrees.createWorktree(
            {
              dir,
              branch: typeof body.branch === 'string' ? body.branch : undefined,
              base: typeof body.base === 'string' ? body.base : undefined,
              path: typeof body.path === 'string' ? body.path : undefined,
              parent: typeof body.parent === 'string' && body.parent.trim() !== ''
                ? body.parent
                : (resolved.defaultParent !== '' ? resolved.defaultParent : undefined),
              force: body.force === true,
            },
            undefined,
          )
          if (!result.ok) return result
          repoSummary.invalidate()
          // Registered as a workspace, because that is the only way a session
          // can run in it. Workspace membership is exact-path equality and
          // `attachSession` rejects any other directory, so a session rooted in
          // the worktree must have a workspace at that path — without one the
          // shell has nowhere to show it and renders "choose a workspace to
          // start" over a session that does exist. This mirrors the core's own
          // "new workspace" flow rather than inventing a second model.
          //
          // Only this route adopts. `worktree_create` deliberately does not: a
          // worktree made mid-conversation leaves the session where it is, so
          // it needs no workspace, and adopting there would add a sidebar entry
          // nobody asked for.
          const adopted = archiveDeps().registry
          let workspace
          if (adopted !== undefined) {
            try {
              // Titled after the project it came from. The sidebar groups by
              // workspace — one group per directory, with no nesting — so a
              // worktree is a group of its own whether or not it looks like
              // one, and a bare `1dda6ec0` reads as an unrelated project that
              // appeared from nowhere. `repo · 1dda6ec0` says what it is.
              const record = await adopted.create(result.path, worktreeTitle(result))
              workspace = { workspaceId: record?.id, title: record?.title, path: record?.path }
            } catch (error) {
              // The worktree exists either way; a registry that refuses must
              // not turn a successful checkout into a failure.
              workspace = { error: String(error?.message ?? error) }
            }
          }
          return { ...result, workspace, settings: resolved }
        }
        if (action === 'remove') {
          const result = await worktrees.removeWorktree(
            {
              dir,
              path: typeof body.path === 'string' ? body.path : '',
              force: body.force === true,
              deleteBranch: body.deleteBranch === true,
            },
            undefined,
          )
          if (result.ok) repoSummary.invalidate()
          return result
        }
        if (action === 'adopt') {
          const registry = archiveDeps().registry
          if (registry === undefined) {
            return { ok: false, error: 'no-workspace-registry', message: 'workspace support is not composed in this profile' }
          }
          if (typeof body.path !== 'string' || body.path.trim() === '') {
            return { ok: false, error: 'bad-path', message: 'path is required' }
          }
          try {
            const entity = await registry.create(body.path.trim())
            return { ok: true, workspace: { workspaceId: entity.id, path: entity.path, title: entity.title } }
          } catch (error) {
            return { ok: false, error: 'adopt-failed', message: String(error?.message ?? error) }
          }
        }
        if (action === 'diff') {
          return worktrees.diffChanges(dir)
        }
        if (action === 'prune') {
          const described = await worktrees.describeRepository(dir)
          if (!described.ok) return described
          const res = await runGit(['worktree', 'prune', '--dry-run'], { cwd: described.root })
          if (!res.ok) return { ok: false, error: 'git-failed', message: res.message }
          repoSummary.invalidate()
          return { ok: true, dryRun: true, output: res.stdout + res.stderr }
        }
        if (action === 'relocate') {
          const result = await worktrees.relocateWorktrees({ dir }, undefined)
          if (result.ok !== true) return result
          if (result.moved.length > 0) repoSummary.invalidate()
          // Whatever moved now, plus any record an earlier run left behind: a
          // run that moved the checkout but could not hand the workspace over
          // is finished by running this again.
          const registry = archiveDeps().registry
          const known = typeof registry?.list === 'function' ? registry.list() ?? [] : []
          const rows = [
            ...result.moved.map((row) => ({ from: row.from, to: row.to })),
            ...unfinishedRelocations(known, result.mainRoot),
          ]
          if (rows.length === 0) return result
          try {
            return { ...result, workspaces: await repointWorkspaces(registry, rows) }
          } catch (error) {
            return { ...result, workspaces: [], error: 'hand-over-failed', message: String(error?.message ?? error) }
          }
        }
        if (action === 'archived') return archive.listArchived(archiveDeps())
        if (action === 'unarchive' || action === 'deleteArchived') {
          const ids = idList(body.ids)
          if (ids === undefined) {
            return { ok: false, error: 'bad-ids', message: 'ids must be a non-empty array of session ids' }
          }
          return action === 'unarchive'
            ? archive.unarchiveSessions(archiveDeps(), ids)
            : archive.deleteSessions(archiveDeps(), ids)
        }
        return { ok: false, error: 'bad-action', message: `unknown POST action ${JSON.stringify(action)}` }
      },
    },
  ]

  const disposers = []
  for (const route of routes) {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: route.path, handler: async (req, res) => {
      try {
        const body = await route.handler(req)
        sendJson(res, body?.ok === false && body.error === 'forbidden' ? 403 : 200, body)
      } catch (error) {
        sendJson(res, 200, { ok: false, error: 'internal', message: String(error?.message ?? error) })
      }
    } }))
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ defaultParent: string }} config - validated composition config.
 */
export function apply(ctx, config) {
  // The install step has no hook (see `ensureBundlePatches`), so the patches are
  // ensured here, once per start. Tests set the flag: they run `apply` against
  // stub contexts and must never write to a real DSH install.
  if (process.env.GORD_WORKTREE_NO_BUNDLE_PATCH !== '1') {
    try {
      lastPatchReport = ensureBundlePatches(ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`gord-dsh-worktree: bundle patch check failed: ${String(error?.message ?? error)}`)
    }
  }
  // Where a new worktree goes: the profile row's `defaultParent`, else
  // `$DSH_HOME/worktree`. The panel shows this value but does not edit it —
  // 0.1.7 dropped per-plugin settings namespaces, so the profile's own file is
  // the only place it can live, and the panel does not write that file.
  let resolved = { defaultParent: config?.defaultParent ?? '' }
  const settings = { get: () => resolved }

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    // 0.1.7 replaced the per-plugin settings namespace with a profile-wide form
    // model: a plugin no longer owns a namespace to register, it exports the
    // Config schema its profile entry already carries and the settings page
    // renders that. Calling `register` there is a TypeError, so the panel default
    // goes back to being read straight from the entry — still live, because the
    // settings page writes the profile patch and the reload re-resolves this
    // entry's config. Older builds keep the namespace, which is what made the
    // default editable from the panel instead of a profile file.
    if (typeof settings.register !== 'function') return
    const scope = settings.register(NS, Config, { base: resolved })
    const adopt = () => {
      resolved = scope.get()
    }
    adopt()
    settingsCtx.effect(() => scope.watch(adopt), 'gord-dsh-worktree: settings observer')
  })

  ctx.effect(() => {
    const disposers = registerTools(ctx, settings)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'gord-dsh-worktree: tools')

  // A one-entry cache keyed by directory: the panel refreshes on focus and
  // after every mutation, and `listWorktrees` is three git calls plus one per
  // worktree for dirty state. Invalidation is explicit, never timed, so a
  // mutation can never be reported against a stale listing.
  let cacheKey
  let cacheValue
  const repoSummary = async (dir) => {
    if (cacheKey === dir && cacheValue !== undefined) return cacheValue
    const value = await worktrees.listWorktrees(dir)
    if (value.ok) {
      cacheKey = dir
      cacheValue = value
    }
    return value
  }
  /** Drop the cached listing after any mutation, so a refresh never shows the pre-mutation state. */
  repoSummary.invalidate = () => {
    cacheKey = undefined
    cacheValue = undefined
  }

  /**
   * The projects a worktree can be cut from.
   *
   * A worktree belongs to a project, multiple worktrees of one project are how
   * branches get isolated — but the session's directory is not a reliable way
   * to name that project: a session is often parked in a container directory or
   * in a workspace that is not a repository at all. The user's workspace list is
   * where their projects actually are, so this is the list both halves pick
   * from, and no path has to be typed anywhere.
   *
   * Nothing here creates anything: worktrees go to `$DSH_HOME/worktree`, which
   * is outside every one of these projects, so a checkout never shows up in its
   * own project's `git status` or diffs.
   *
   * @returns {Promise<Array<{ id: string, title: string, path: string, root: string, branch: string, dirty: boolean }>>}
   *   the repositories among the user's workspaces, most recently used first.
   */
  /**
   * The projects a worktree can be cut from, best candidate first.
   *
   * "Which project" is answered by the workspace the caller is in, because that
   * is what the user means: a new session is started in a workspace, and the
   * project is that workspace — or, when the workspace is a container of
   * projects, the repository inside it that was worked on last.
   *
   * @param {{sessionId?: string, dir?: string}} query - how the caller is situated.
   *   A session id is exact; a directory is matched to the workspace containing
   *   it. Neither given means "no preference", and the list is then simply the
   *   most recently used repositories.
   * @returns {Promise<Array<object>>} projects, the caller's own first.
   */
  const workspaceRepos = async (query = {}) => {
    let list = []
    try {
      list = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
    } catch (_) {
      return []
    }
    const ordered = [...list].sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
    // Which workspace the caller is in, decided before the rows are built: it
    // orders the result, and it decides whether a container workspace may offer
    // the projects inside it. The caller's own workspace first, and within each
    // group the project worked on last, so "the project" without a choice is the
    // one the user means rather than whichever the sidebar lists first.
    const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
    const dir = typeof query.dir === 'string' ? query.dir : ''
    let current = ''
    if (sessionId !== '') {
      const owner = ordered.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId))
      if (owner !== undefined && typeof owner.path === 'string') current = owner.path
    }
    if (current === '' && dir !== '') {
      for (const workspace of ordered) {
        const path = typeof workspace?.path === 'string' ? workspace.path : ''
        if (path !== '' && (dir === path || dir.startsWith(`${path}/`)) && path.length > current.length) current = path
      }
    }
    // The composer's workspace picker names the workspace it is set to, and the
    // plugin is asked for a worktree before the session is filed under it — a
    // blank session has no directory and is in no workspace's sessionIds yet.
    // The name the row shows is then the only answer, so it is taken.
    const wanted = typeof query.title === 'string' ? query.title.trim() : ''
    if (current === '' && wanted !== '') {
      const named = ordered.find((workspace) => typeof workspace?.title === 'string' && workspace.title.trim() === wanted)
      if (named !== undefined && typeof named.path === 'string') current = named.path
    }

    let rows = []
    for (const workspace of ordered) {
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      if (path === '' || !path.startsWith('/')) continue
      const title = typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title.trim() : ''
      const used = Date.parse(workspace?.updatedAt ?? '') || 0
      const info = await worktrees.describeRepository(path).catch(() => undefined)
      if (info !== undefined && info.ok === true) {
        rows.push({
          id: String(workspace.id ?? path),
          // A workspace that *is* a worktree — one an earlier release left
          // behind, registered when worktrees were adopted as workspaces — is
          // the project it was cut from, not a project of its own. Otherwise the
          // page resolves to a directory named after a code, with a branch named
          // after another one.
          title: info.isLinked === true ? basename(info.mainRoot) : title !== '' ? title : basename(info.mainRoot),
          path: info.isLinked === true ? info.mainRoot : path,
          root: info.mainRoot,
          // A leftover worktree workspace must not describe the project: it is a
          // copy, and its branch is whichever branch it happens to hold — often
          // the project's own. Naming either for a project is what put
          // `ec0f573c · 7f607255 worktree/7f607255` on the settings page.
          branch: info.isLinked === true ? undefined : info.branch,
          dirty: info.isLinked === true ? undefined : info.dirty === true,
          // The workspace this project belongs to, which is how a session
          // parked in a container finds the projects that are its own.
          workspace: path,
          // Nor may it set the project's recency: a leftover directory touched
          // minutes ago would otherwise outrank the project in use, and the
          // fallback would keep cutting worktrees from the wrong project.
          activity: info.isLinked === true ? 0 : used,
        })
        continue
      }
      // Not a project, but very likely the home of several. Only the container the
      // caller is in offers them: the sidebar has an entry for a workspace, never
      // for a project merely sitting inside one, and listing those turned the
      // picker into a directory dump of every workspace on the machine.
      if (current === '' || path !== current) continue
      const nested = await repositoriesUnder(path)
      const described = []
      for (const candidate of nested) {
        const nestedInfo = await worktrees.describeRepository(candidate.path).catch(() => undefined)
        if (nestedInfo === undefined || nestedInfo.ok !== true) continue
        described.push({ candidate, nestedInfo })
      }
      described.sort((a, b) => b.candidate.activity - a.candidate.activity)
      for (const { candidate, nestedInfo } of described) {
        rows.push({
          id: `${String(workspace.id ?? path)}:${nestedInfo.mainRoot}`,
          title: basename(nestedInfo.mainRoot),
          path: nestedInfo.mainRoot,
          root: nestedInfo.mainRoot,
          branch: nestedInfo.branch,
          dirty: nestedInfo.dirty === true,
          workspace: path,
          inside: title !== '' ? title : path,
          activity: candidate.activity,
        })
      }
    }
    // One entry per repository. A repository found inside a container workspace
    // can also be a workspace of its own, and a linked worktree of a project is
    // still that project — all of them resolve to the same root, so they are
    // merged rather than listed twice, remembering every workspace that contains
    // them so the caller's own workspace still matches.
    const byRoot = new Map()
    const unique = []
    for (const row of rows) {
      const seen = byRoot.get(row.root)
      if (seen === undefined) {
        row.workspaces = [row.workspace]
        byRoot.set(row.root, row)
        unique.push(row)
        continue
      }
      if (!seen.workspaces.includes(row.workspace)) seen.workspaces.push(row.workspace)
      if (row.activity > seen.activity) seen.activity = row.activity
      // A workspace sitting *at* the project root is the project's own row, so
      // it describes it; a folded leftover only contributed a workspace path.
      if (row.path === row.root && seen.path !== seen.root) {
        seen.title = row.title
        seen.path = row.path
        seen.branch = row.branch
        seen.dirty = row.dirty
      }
    }
    rows = unique

    // The caller's own workspace first, and within each group the project worked
    // on last: "the project" without a choice is then the one the user means,
    // and never whichever the sidebar happens to list first.
    rows.sort((a, b) => b.activity - a.activity)
    if (current === '') return rows
    const mine = (row) => Array.isArray(row.workspaces) && row.workspaces.includes(current)
    return [...rows.filter(mine), ...rows.filter((row) => !mine(row))]
  }

  // The workspace registry is optional: a headless or minimal composition has
  // no sidebar to adopt a worktree into, and that must not stop the plugin.
  // It is resolved on its own injected child context, because a service that
  // is not composed in cannot be read through the plugin's own context at all.
  let registry
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
    registry = workspaceCtx.workspaceRegistry
    workspaceCtx.effect(() => () => {
      registry = undefined
    }, 'gord-dsh-worktree: workspace registry release')
  })

  // The archive view's read-only extras, each optional for the same reason.
  // The archive *set* comes from the registry alone; a missing projection
  // source costs titles and dates, and a missing persistence source costs the
  // dates and the cwd, but never the list itself.
  const extras = { sessions: undefined, agents: undefined, projections: undefined, cache: undefined, persistence: undefined }
  for (const [service, key] of [
    ['sessions', 'sessions'],
    // `agents`, not `sessions`, answers "is this session running". A sessions
    // entry only means this process has loaded that Session, which hydration
    // does on its own and then keeps; the agent's own `status` is what flips
    // between idle and running.
    ['agents', 'agents'],
    ['sessionProjections', 'projections'],
    ['sessionProjectionCache', 'cache'],
    ['sessionPersistence', 'persistence'],
  ]) {
    ctx.inject([service], (serviceCtx) => {
      extras[key] = serviceCtx[service]
      serviceCtx.effect(() => () => {
        extras[key] = undefined
      }, `gord-dsh-worktree: ${service} release`)
    })
  }
  const archiveDeps = () => ({ registry, now: () => Date.now(), ...extras })

  // Stamp an archive time when the archive happens, not when the panel next
  // opens. This is the same event the workspace controller turns into the
  // `archived` frame the sidebar follows, and it fires only after the write is
  // durable, so the set read here is the committed one. Failures are dropped:
  // a record that could not be written costs a timestamp, and the next sync
  // retries it — it must never take down a listener on a core event.
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
    // Establish the baseline before anything can be archived. The ids already
    // archived here were archived by something that was not recording, so they
    // are seeded as unknown exactly once — and because this runs at load, the
    // *first* archive this process witnesses is still stamped with a real time
    // instead of being mistaken for history.
    const baseline = archive.archivedIds(workspaceCtx.workspaceRegistry)
    if (baseline !== undefined) archive.syncArchiveRecord(archiveDeps(), baseline).catch(() => {})

    // Then drop the tombstones of sessions that are already gone, which is the
    // one moment that is safe: the host has just read its sessions off disk and
    // no client has connected yet, so an id with no log cannot reappear as a
    // row. Left alone they accumulate, and 0.1.7's archived filter renders them
    // as an Ungrouped group of rows with nothing left to delete.
    archive.forgetDeletedSessions(archiveDeps()).then((result) => {
      if (result.ok && result.removed > 0) {
        workspaceCtx.logger?.info?.(`gord-dsh-worktree: forgot ${result.removed} deleted session(s)`)
      } else if (!result.ok) {
        workspaceCtx.logger?.warn?.(`gord-dsh-worktree: deleted sessions not forgotten: ${result.message}`)
      }
    }).catch((error) => {
      workspaceCtx.logger?.warn?.(`gord-dsh-worktree: deleted sessions not forgotten: ${String(error?.message ?? error)}`)
    })

    workspaceCtx.on('domain/changed', (change) => {
      if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
      // The payload is the committed state, and it is the only correct source
      // here: the registry assigns its in-memory copy *after* `global.set`
      // resolves, and this event is emitted from inside that call — so reading
      // `archivedSessionIds` through the getter at this moment returns the
      // previous set, one write behind. The getter stays as a fallback for a
      // build whose payload shape differs.
      const ids = Array.isArray(change.value?.archivedSessionIds)
        ? change.value.archivedSessionIds.map(String)
        : archive.archivedIds(workspaceCtx.workspaceRegistry)
      if (ids === undefined) return
      archive.syncArchiveRecord(archiveDeps(), ids).catch((error) => {
        workspaceCtx.logger?.warn?.(`gord-dsh-worktree: archive time not recorded: ${String(error?.message ?? error)}`)
      })
    })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerRoutes(webCtx, settings, repoSummary, workspaceRepos, archiveDeps), 'gord-dsh-worktree: routes')
  })
}

export { worktrees }