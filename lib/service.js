/**
 * gord-dsh-worktree — worktree operations, the single implementation behind the
 * model-facing tools and the browser panel.
 *
 * Both surfaces call these functions so they can never drift: the HTTP routes
 * add workspace adoption on top, and the tools add the model's `workdir`
 * resolution on the bottom; everything in between is one code path.
 *
 * The guards are the point of the module. Creating branches off a dirty tree
 * without telling the user, or deleting a worktree with uncommitted work
 * because a caller "meant" to, are the two ways a worktree helper loses data;
 * both are refused unless the caller explicitly asks for the destructive form.
 *
 * @module gord-dsh-worktree/service
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertBranchName,
  branchExists,
  canonicalSpelling,
  currentBranch,
  defaultWorktreeParent,
  ensureDir,
  isDirty,
  matchWorktree,
  repoInfo,
  remoteBranchRef,
  revisionExists,
  runGit,
  slugifyBranch,
  worktreeCode,
  worktreeList,
} from './worktree.js'

/**
 * Message shown when a directory is not a git repository — a constant so the
 * client can localize it instead of echoing an English sentence.
 */
const NOT_A_REPO = 'not-a-repository'

/**
 * Public projection of one worktree record.
 *
 * `spellings` is match-time data (see `pathSpellings`), not part of the
 * contract: the model-facing output schema rejects undeclared keys, and the
 * browser payload should not carry an implementation detail. Every payload
 * below is projected through here, so the two surfaces cannot drift.
 *
 * @param {object} entry - record from `worktreeList`.
 * @returns {object} the declared public fields.
 */
export function worktreeView(entry) {
  return {
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    detached: entry.detached,
    bare: entry.bare,
    locked: entry.locked,
    pruned: entry.pruned,
    current: entry.current,
  }
}

/**
 * Describe the repository a directory belongs to.
 *
 * @param {string} dir - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} repository summary plus its worktrees.
 */
export async function describeRepository(dir, signal) {
  const info = await repoInfo(dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir }
  const raw = await worktreeList(info.root, signal)
  const worktrees = raw.map(worktreeView)
  const dirty = await isDirty(info.root, signal)
  return {
    ok: true,
    requestedDir: dir,
    root: info.root,
    mainRoot: info.mainRoot,
    commonDir: info.commonDir,
    branch: info.branch,
    dirty,
    /** True when the session already runs inside a linked worktree. */
    isLinked: info.root !== info.mainRoot,
    defaultParent: defaultWorktreeParent(),
    worktrees,
  }
}

/**
 * Worktrees plus the branches available as a base, for the panel's pickers.
 *
 * @param {string} dir - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} list payload, or `{ ok: false, error }`.
 */
export async function listWorktrees(dir, signal) {
  const described = await describeRepository(dir, signal)
  if (!described.ok) return described
  const branches = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: described.root, signal })
  const local = branches.ok ? branches.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : []
  const remoteRes = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/'], { cwd: described.root, signal })
  const remote = remoteRes.ok
    ? remoteRes.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.endsWith('/HEAD'))
    : []
  return { ...described, branches: [...new Set([...local, ...remote])], localBranches: local }
}

/**
 * Create a worktree.
 *
 * The new branch is created with `worktree add -b`, so the operation is a
 * single atomic git subcommand rather than `branch` followed by `add` (which
 * would leave a stray branch behind on failure). An existing branch is checked
 * out without `-b`, and a branch that is checked out in another worktree is
 * rejected by git itself — the message is passed through verbatim, because
 * that error is precise and the user-facing fix is obvious.
 *
 * @param {object} input - create request.
 * @param {string} input.dir - directory inside the repository.
 * @param {string} [input.branch] - branch to create or check out.
 * @param {string} [input.base] - revision the new branch starts from.
 * @param {string} [input.path] - absolute, or relative to the repository root.
 * @param {boolean} [input.force] - reuse a non-empty target directory.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} created worktree summary, or `{ ok: false, error, message? }`.
 */
export async function createWorktree(input, signal) {
  const info = await repoInfo(input.dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir: input.dir }
  const explicitBase = typeof input.base === 'string' && input.base.trim() !== ''
  let base = explicitBase ? input.base.trim() : info.branch
  // Naming no branch is the common case, and it must not need a name invented
  // by the caller: a fresh code is drawn and used for both the branch and the
  // directory, so two worktrees made from the same base never collide. A base
  // is not required either — with none named the current branch is the base,
  // which is what "just give me a checkout to work in" means.
  const named = typeof input.branch === 'string' && input.branch.trim() !== ''
  const code = worktreeCode()
  let branch
  try {
    branch = await assertBranchName(info.root, named ? input.branch : `worktree/${code}`, signal)
  } catch (error) {
    return { ok: false, error: 'invalid-branch', branch: input.branch, message: String(error?.message ?? error) }
  }

  // A branch that exists only on a remote must never be silently re-created:
  // `git worktree add -b <name> <base>` would make an empty branch of the same
  // name and the caller would believe it holds the remote's commits. With no
  // base named, the remote branch is plainly what was meant, so start there and
  // say so. With a base named, honour it but report the shadowed remote — an
  // intentional "new branch from main" has to stay possible, and only stays
  // safe if it is distinguishable from the mistake.
  const exists = await branchExists(info.root, branch, signal)
  let pickedUpRemote
  let shadowedRemote
  if (!exists) {
    const remote = await remoteBranchRef(info.root, branch, signal)
    if (remote !== undefined && remote !== base) {
      if (explicitBase) shadowedRemote = remote
      else {
        base = remote
        pickedUpRemote = remote
      }
    }
  }
  if (!(await revisionExists(info.root, base, signal))) {
    return { ok: false, error: 'unknown-base', base, message: `base revision ${JSON.stringify(base)} does not exist` }
  }
  const parent = input.parent !== undefined && String(input.parent).trim() !== ''
    ? String(input.parent).trim()
    : defaultWorktreeParent()
  // A named branch gets a directory named after it, so the path says what it
  // holds. An unnamed one has no name to use, so it takes the same code as its
  // branch — which is what makes the directory `$DSH_HOME/worktree/<code>`.
  const target = input.path !== undefined && String(input.path).trim() !== ''
    ? String(input.path).trim()
    : join(parent, named ? slugifyBranch(branch) : code)
  const absoluteTarget = target.startsWith('/') ? target : join(info.mainRoot, target)
  const list = await worktreeList(info.root, signal)

  if (existsSync(join(absoluteTarget, '.git'))) {
    return { ok: false, error: 'path-in-use', path: absoluteTarget, message: 'that directory is already a worktree' }
  }
  // An existing worktree whose directory was deleted is still registered, and
  // `git worktree add` refuses that path. Report it here, where the fix
  // (`worktree_prune`) can be named, instead of surfacing a bare git error.
  // Compared canonically, not literally: the record git kept and the path the
  // caller typed can be two spellings of one location (`/var` and
  // `/private/var` on macOS), and the location is by definition missing here —
  // which is why `pathSpellings`, which resolves the path itself, cannot help.
  const canonicalTarget = canonicalSpelling(absoluteTarget)
  if (list.some((entry) => canonicalSpelling(entry.path) === canonicalTarget && !existsSync(entry.path))) {
    return {
      ok: false,
      error: 'stale-record',
      path: absoluteTarget,
      message: 'that path is still registered to a worktree whose directory is gone; run worktree_prune first',
    }
  }
  ensureDir(parent.startsWith('/') ? parent : join(info.mainRoot, parent))

  const args = ['worktree', 'add']
  if (!exists) args.push('-b', branch)
  args.push(absoluteTarget, exists ? branch : base)
  if (input.force === true) args.push('--force')

  const res = await runGit(args, { cwd: info.root, signal, timeoutMs: 120_000 })
  if (!res.ok) {
    return { ok: false, error: 'git-failed', message: res.message, args: args.slice(0, 3).join(' ') }
  }
  const worktrees = await worktreeList(info.root, signal)
  const created = worktrees.find((entry) => entry.path === absoluteTarget || (entry.spellings ?? []).includes(absoluteTarget))
  return {
    ok: true,
    repoRoot: info.root,
    mainRoot: info.mainRoot,
    branch: await currentBranch(absoluteTarget, signal),
    createdBranch: !exists,
    path: absoluteTarget,
    base,
    pickedUpRemote,
    shadowedRemote,
    worktree: created === undefined ? undefined : worktreeView(created),
    worktrees: worktrees.map(worktreeView),
  }
}

/**
 * Remove a worktree, refusing to discard uncommitted work unless forced.
 *
 * @param {object} input - remove request.
 * @param {string} input.dir - directory inside the repository.
 * @param {string} input.path - worktree path, directory name, or branch.
 * @param {boolean} [input.force] - discard a dirty worktree.
 * @param {boolean} [input.deleteBranch] - also delete the branch.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} removal receipt, or `{ ok: false, error, message? }`.
 */
export async function removeWorktree(input, signal) {
  const info = await repoInfo(input.dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir: input.dir }
  const list = await worktreeList(info.root, signal)
  let target
  try {
    target = matchWorktree(list, input.path, info.root)
  } catch (error) {
    return { ok: false, error: 'bad-path', path: input.path, message: String(error?.message ?? error) }
  }
  if (target === undefined) {
    return { ok: false, error: 'unknown-worktree', path: input.path, message: 'no worktree matches that path, directory name, or branch' }
  }
  if (target.path === info.mainRoot) {
    return { ok: false, error: 'main-worktree', path: target.path, message: 'the main worktree cannot be removed' }
  }
  if (target.locked) {
    return { ok: false, error: 'locked', path: target.path, message: 'the worktree is locked; unlock it first (git worktree unlock)' }
  }
  const dirty = existsSync(target.path) ? await isDirty(target.path, signal) : false
  if (dirty && input.force !== true) {
    return {
      ok: false,
      error: 'dirty',
      path: target.path,
      branch: target.branch,
      message: 'the worktree has uncommitted or untracked changes; pass force to discard them',
    }
  }

  const res = await runGit(['worktree', 'remove', ...(input.force === true ? ['--force'] : []), target.path], {
    cwd: info.root,
    signal,
    timeoutMs: 120_000,
  })
  if (!res.ok) return { ok: false, error: 'git-failed', message: res.message }

  let branchDeleted = false
  let branchError
  if (input.deleteBranch === true && target.branch !== '' && !target.detached) {
    const del = await runGit(['branch', '-D', target.branch], { cwd: info.root, signal })
    branchDeleted = del.ok
    if (!del.ok) branchError = del.message
  }
  return {
    ok: true,
    removed: target.path,
    branch: target.branch,
    branchDeleted,
    ...(branchError === undefined ? {} : { branchError }),
    worktrees: (await worktreeList(info.root, signal)).map(worktreeView),
  }
}

/**
 * Git status for one worktree path, for the panel's detail view.
 *
 * @param {string} dir - worktree path.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} status payload.
 */
export async function worktreeStatus(dir, signal) {
  const info = await repoInfo(dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir }
  const status = await runGit(['status', '--porcelain', '--untracked-files=normal', '--branch'], { cwd: dir, signal })
  const lines = status.ok ? status.stdout.split('\n').filter((line) => line.trim() !== '') : []
  const head = lines.find((line) => line.startsWith('## ')) ?? ''
  const changes = lines
    .filter((line) => !line.startsWith('## '))
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3) }))
  return {
    ok: true,
    path: info.root,
    branch: info.branch,
    head,
    dirty: changes.length > 0,
    changes,
  }
}

/**
 * Render a worktree list as compact text for the model.
 *
 * @param {Array<object>} worktrees - records from {@link listWorktrees}.
 * @param {string} [currentPath] - worktree the session itself is in.
 * @returns {string} one line per worktree.
 */
export function formatWorktrees(worktrees, currentPath) {
  if (worktrees.length === 0) return '(no worktrees)'
  return worktrees
    .map((entry) => {
      const marks = [
        entry.path === currentPath ? 'current' : undefined,
        entry.detached ? 'detached' : undefined,
        entry.locked ? 'locked' : undefined,
        entry.pruned ? 'pruned' : undefined,
      ].filter((mark) => mark !== undefined)
      const suffix = marks.length > 0 ? ` [${marks.join(', ')}]` : ''
      return `${entry.path}  ${entry.branch || entry.head.slice(0, 7)}${suffix}`
    })
    .join('\n')
}

export { NOT_A_REPO }