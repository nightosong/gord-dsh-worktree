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

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as worktrees from './service.js'
import { resolveProjectDir, positional, runGit } from './worktree.js'

/** Bumped with the package version; surfaced by `GET /gord-dsh-worktree/health`. */
export const PLUGIN_VERSION = '0.1.0'

/** Services whose activation this plugin waits for. */
export const inject = ['tools']

/**
 * Panel defaults. `defaultParent` empty means `$DSH_HOME/worktree`, the shared
 * home for every project's worktrees.
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
        'appears in `git status` and needs no ignore rule. Omit `branch` and a random `worktree/<code>` branch ' +
        'is made from the current branch, with the directory named by the same code; name a branch and the ' +
        'directory is named after it instead. ' +
        '\n\n' +
        'A request to "work on this in a new worktree" mid-conversation: create it here, then do the work by passing ' +
        'the returned `path` as `workdir` to worktree_status and to later commands. A running session cannot be moved ' +
        'into a worktree — its directory is fixed when the session is created — so switching the conversation itself ' +
        'is the user\'s move, either from the New Session worktree dropdown or by opening the path as a workspace. ' +
        'Say which path you are working in rather than assuming the session moved.',
      parameters: {
        branch: {
          type: 'string',
          description: 'Branch to create or check out. Defaults to `worktree/<base-branch>`.',
        },
        base: {
          type: 'string',
          description: 'Revision the new branch starts from (branch, tag, or commit). Defaults to the repository\'s current branch.',
        },
        path: {
          type: 'string',
          description: 'Absolute target directory, or a path relative to the repository root. Defaults to a sibling directory named after the branch.',
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

  return [list, create, status, remove, prune]
}

/**
 * Register the browser-facing HTTP surface.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ get: () => { defaultParent: string } }} settings - resolved panel settings.
 * @param {(dir: string) => Promise<object | undefined>} repoSummary - per-directory cache of {@link worktrees.listWorktrees}.
 */
function registerRoutes(ctx, settings, repoSummary, registryOf) {
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
          if (action === 'health') return { ok: true, version: PLUGIN_VERSION }
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

        if (action === 'list') {
          const summary = await repoSummary(dir)
          return { ok: true, ...summary, settings: resolved }
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
          // No workspace is registered here, and that is the point: a worktree
          // is a second checkout of the project the session already belongs to,
          // not a second project. Registering one put a new entry in the
          // sidebar and — because a workspace is created with a blank session —
          // moved the user's next message into it. Registering is still
          // possible, but only as the explicit `adopt` action below.
          return { ...result, settings: resolved }
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
          const registry = registryOf()
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
        if (action === 'prune') {
          const described = await worktrees.describeRepository(dir)
          if (!described.ok) return described
          const res = await runGit(['worktree', 'prune', '--dry-run'], { cwd: described.root })
          if (!res.ok) return { ok: false, error: 'git-failed', message: res.message }
          repoSummary.invalidate()
          return { ok: true, dryRun: true, output: res.stdout + res.stderr }
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
  let resolved = { defaultParent: config?.defaultParent ?? '' }
  const settings = { get: () => resolved }

  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NS, Config, { base: resolved })
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

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerRoutes(webCtx, settings, repoSummary, () => registry), 'gord-dsh-worktree: routes')
  })
}

export { worktrees }