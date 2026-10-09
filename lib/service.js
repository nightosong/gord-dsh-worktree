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

import { existsSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  assertBranchName,
  branchExists,
  canonicalSpelling,
  currentBranch,
  defaultWorktreeParent,
  ensureDir,
  ensureWorktreeExclude,
  isDirty,
  legacyWorktreeParent,
  matchWorktree,
  repoInfo,
  remoteBranchRef,
  revisionExists,
  runGit,
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
 * @param {object} [options] - caller choices.
 * @param {boolean} [options.dirty] - ask per row whether it holds uncommitted or
 *   untracked changes. One `git status` per worktree, so only the callers whose
 *   surface needs it — the panel's removal dialog — ask for it.
 * @returns {Promise<object>} repository summary plus its worktrees.
 */
export async function describeRepository(dir, signal, options = {}) {
  const info = await repoInfo(dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir }
  const raw = await worktreeList(info.root, signal)
  // A branch held by more than one checkout is held by the project, once a copy
  // of it exists. The row is told, because removing that copy cannot delete the
  // branch — it is the project's own line of work — and the panel must not offer
  // to do what the host will refuse.
  const holders = new Map()
  for (const entry of raw) {
    if (entry.branch !== '') holders.set(entry.branch, (holders.get(entry.branch) ?? 0) + 1)
  }
  // When each checkout last moved, which is the one thing a row cannot read off
  // its own path or branch. A worktree whose directory was deleted has no time to
  // report rather than a misleading zero.
  const headTimes = await Promise.all(
    raw.map(async (entry) => {
      if (!existsSync(entry.path)) return undefined
      const res = await runGit(['log', '-1', '--format=%ct'], { cwd: entry.path, signal })
      if (!res.ok) return undefined
      const seconds = Number(res.stdout.trim())
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
    }),
  )
  const worktrees = raw.map((entry, index) => ({
    ...worktreeView(entry),
    branchShared: entry.branch !== '' && (holders.get(entry.branch) ?? 0) > 1,
    headTime: headTimes[index],
  }))
  // Asked for, and only then: the panel keys its removal dialog on this — the
  // warning, and the acknowledgement that discards the changes — and it cannot
  // read dirtiness off a path the way it reads a branch. A directory that is
  // already gone is reported clean, which is what the removal guard assumes too.
  if (options.dirty === true) {
    const dirt = await Promise.all(
      worktrees.map(async (row) => (existsSync(row.path) ? await isDirty(row.path, signal) : false)),
    )
    worktrees.forEach((row, index) => {
      row.dirty = dirt[index]
    })
  }
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
    defaultParent: defaultWorktreeParent(info.mainRoot),
    worktrees,
  }
}

/**
 * Worktrees plus the branches available as a base, for the panel's pickers.
 *
 * @param {string} dir - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @param {object} [options] - forwarded to {@link describeRepository}.
 * @returns {Promise<object>} list payload, or `{ ok: false, error }`.
 */
export async function listWorktrees(dir, signal, options) {
  const described = await describeRepository(dir, signal, options)
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
  const named = typeof input.branch === 'string' && input.branch.trim() !== ''
  // Naming no branch is the common case, and it means a second checkout of what
  // the project is already on rather than a new line of work: the worktree holds
  // the branch the project itself has checked out, so `origin/test` upstream and
  // all, the copy tracks whatever `test` does. Nothing is invented for it, and
  // the fresh code names only the directory — one code per checkout is what
  // keeps two copies of the same branch from colliding on disk.
  //
  // A detached project has no branch to share, so there a name is invented after
  // all: the checkout gets `worktree/<code>` and is a line of work of its own.
  const sharesCurrent = !named && info.branch !== '' && info.branch !== 'HEAD'
  const code = worktreeCode()
  let branch
  try {
    branch = await assertBranchName(info.root, named ? input.branch : sharesCurrent ? info.branch : `worktree/${code}`, signal)
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
    : defaultWorktreeParent(info.mainRoot)
  // The directory is the code, never the branch. One branch can be checked out
  // in more than one worktree — the copy of the current branch exists for exactly
  // that — so a directory named after the branch would have to be numbered to
  // stay unique, which is the code with extra steps. `path` still overrides the
  // location outright.
  const target = input.path !== undefined && String(input.path).trim() !== ''
    ? String(input.path).trim()
    : join(parent, code)
  const absoluteTarget = target.startsWith('/') ? target : join(info.mainRoot, target)
  // A worktree inside its own repository is not isolation: the checkout would
  // show up in that project's `git status`, in its diffs, and in anything that
  // walks the project tree. The one exception is this plugin's own directory
  // (`<project>/.dsh/worktrees`): the sidebar only nests a worktree under its
  // project when the directory really is inside it, and the directory is kept
  // out of `git status` through the repository's local `info/exclude`. Any
  // other in-project path is refused rather than silently relocated, because a
  // caller who named a path meant that path.
  const managedRoot = defaultWorktreeParent(info.mainRoot)
  const managed = absoluteTarget === managedRoot || absoluteTarget.startsWith(`${managedRoot}/`)
  if (!managed && (absoluteTarget === info.mainRoot || absoluteTarget.startsWith(`${info.mainRoot}/`))) {
    return {
      ok: false,
      error: 'inside-repository',
      path: absoluteTarget,
      root: info.mainRoot,
      message: `a worktree must be created outside the repository: ${absoluteTarget} is inside ${info.mainRoot}`,
    }
  }
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
  // A branch the project is on is checked out by definition, and git refuses a
  // second checkout of one branch without `--force`. Sharing it is the point
  // here, so the refusal is overridden — but only for a branch that really is
  // held by another worktree, never to paper over an unrelated failure.
  const heldElsewhere = list.some((entry) => entry.branch !== '' && entry.branch === branch)
  if (input.force === true || (sharesCurrent && heldElsewhere)) args.push('--force')

  const res = await runGit(args, { cwd: info.root, signal, timeoutMs: 120_000 })
  if (!res.ok) {
    return { ok: false, error: 'git-failed', message: res.message, args: args.slice(0, 3).join(' ') }
  }
  const worktrees = await worktreeList(info.root, signal)
  const created = worktrees.find((entry) => entry.path === absoluteTarget || (entry.spellings ?? []).includes(absoluteTarget))
  // Written before reporting success: the panel's list refresh reads `git
  // status` again, and an unexcluded in-project worktree would show up there.
  const excluded = managed ? await ensureWorktreeExclude(info.mainRoot, signal) : false
  return {
    ok: true,
    repoRoot: info.root,
    mainRoot: info.mainRoot,
    excluded,
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
 * Move every worktree of a repository that lives outside it into the project's
 * own worktree directory.
 *
 * Folding needs the checkout to be inside its project, and a worktree made by an
 * earlier release sits in the shared `$DSH_HOME/worktree`. `git worktree move`
 * relocates the checkout, its index and its branch together, and the old path is
 * left as a symlink: a session header records the directory it was made in, and
 * the workspace registry validates a session against the canonical form of that
 * recorded path — so the symlink is what keeps an old session attached to its
 * worktree once the worktree is somewhere else.
 *
 * @param {{dir?: string}} input - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} what moved, what was already in place, what failed.
 */
export async function relocateWorktrees(input, signal) {
  const info = await repoInfo(input.dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir: input.dir }
  const managedRoot = defaultWorktreeParent(info.mainRoot)
  const legacyRoot = legacyWorktreeParent()
  const list = await worktreeList(info.root, signal)
  const movable = list.filter(
    (entry) =>
      entry.path !== info.mainRoot &&
      entry.path !== info.root &&
      !entry.path.startsWith(`${managedRoot}/`) &&
      entry.path.startsWith(`${legacyRoot}/`) &&
      existsSync(entry.path),
  )
  if (movable.length > 0) ensureDir(managedRoot)
  const moved = []
  const skipped = []
  const failed = []
  for (const entry of list) {
    if (entry.path === info.mainRoot || entry.path === info.root) continue
    if (entry.path.startsWith(`${managedRoot}/`)) {
      skipped.push({ path: entry.path, reason: 'already-inside' })
      continue
    }
    // Only this plugin's own legacy home is relocated: a checkout the user made
    // elsewhere — a hand-made sibling copy, a scratch directory — is theirs to
    // place, and moving it would be a surprise.
    if (!entry.path.startsWith(`${legacyRoot}/`)) {
      skipped.push({ path: entry.path, reason: 'elsewhere' })
      continue
    }
    if (!existsSync(entry.path)) {
      skipped.push({ path: entry.path, reason: 'missing' })
      continue
    }
    // Named after the directory it already has — the code is that name by
    // construction — and re-coded only when the name is already taken.
    let target = join(managedRoot, basename(entry.path))
    if (existsSync(target)) target = join(managedRoot, worktreeCode())
    const res = await runGit(['worktree', 'move', entry.path, target], { cwd: info.root, signal, timeoutMs: 120_000 })
    if (!res.ok) {
      failed.push({ path: entry.path, message: res.message })
      continue
    }
    let linked = true
    try {
      symlinkSync(target, entry.path)
    } catch {
      linked = false
    }
    moved.push({ from: entry.path, to: target, branch: entry.branch, linked })
  }
  // Written before reporting success: the panel refreshes right after, and an
  // unexcluded in-project worktree would show up in the project's status.
  const excluded = moved.length > 0 ? await ensureWorktreeExclude(info.mainRoot, signal) : false
  return { ok: true, repoRoot: info.root, mainRoot: info.mainRoot, managedRoot, excluded, moved, skipped, failed }
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
  // A worktree cut from the project's own branch shares that branch with the
  // project, and the branch outlives any one checkout of it: deleting it here
  // would delete the project's line of work. It is only ever deleted when
  // nothing else holds it.
  const branchShared = target.branch !== '' && list.some((entry) => entry.path !== target.path && entry.branch === target.branch)
  if (input.deleteBranch === true && target.branch !== '' && !target.detached && !branchShared) {
    const del = await runGit(['branch', '-D', target.branch], { cwd: info.root, signal })
    branchDeleted = del.ok
    if (!del.ok) branchError = del.message
  }
  return {
    ok: true,
    removed: target.path,
    branch: target.branch,
    branchDeleted,
    branchShared,
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
/** Files whose patch the diff view will carry before it stops asking. */
const DIFF_MAX_FILES = 60
/** Bytes of one file's patch past which the rest is dropped. */
const DIFF_MAX_FILE_BYTES = 240_000
/** Bytes of the whole answer past which later files are listed but not patched. */
const DIFF_MAX_TOTAL_BYTES = 1_200_000

/**
 * One changed file's status letters, as `git status --porcelain` spells them.
 *
 * The two columns are the index and the worktree, and both are meaningful: a
 * file can be staged *and* modified again, and collapsing that to one letter
 * would hide half of what is about to be committed.
 *
 * @param {string} code - the two-letter status code.
 * @returns {string} the code, with `.` for a space so it survives a payload.
 */
function statusCode(code) {
  return code.replace(/ /g, '.')
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * NUL-separated rather than line-separated, because that is the only form git
 * will not quote: a path with a space, a quote or a non-ASCII character comes
 * back quoted under the default `core.quotePath`, and unquoting it correctly is
 * a parser nobody wants to own. `-z` also puts a rename's original path in its
 * own field, which is where the `R`/`C` cases read it from.
 *
 * @param {string} text - raw `-z` output.
 * @returns {Array<{ code: string, path: string, from?: string }>}
 */
export function parseStatus(text) {
  const fields = text.split('\0')
  const entries = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field === '') continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    const renamed = code.startsWith('R') || code.startsWith('C')
    const from = renamed ? fields[(i += 1)] : undefined
    entries.push(from === undefined ? { code, path } : { code, path, from })
  }
  return entries
}

/**
 * Count the added and removed lines of one file's patch.
 *
 * The `+++`/`---` file headers are not lines of the file and are excluded;
 * everything else that starts with a sign is. A hunk header starts with `@`,
 * so it is not counted either.
 *
 * @param {string} patch - one file's unified diff.
 * @returns {{ additions: number, deletions: number }}
 */
export function patchCounts(patch) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/**
 * The uncommitted changes of the repository a directory belongs to.
 *
 * This is the diff the browser's Changes tab shows, and it is deliberately the
 * working tree against `HEAD` rather than the session's own edits: what a
 * person wants to review before committing is what is on disk, whichever of the
 * agent's tools put it there — and a `bash` edit, a formatter, or their own
 * editor in the next window all land in the same answer. The session's edits
 * are already diffed inline in the conversation, from the tools' own reports.
 *
 * A worktree is an ordinary repository here: `git -C <worktree> diff HEAD`
 * answers for that worktree alone, so the tab follows a session into one
 * without being told it did.
 *
 * @param {string} dir - any directory inside the repository.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the declared payload, or `{ ok: false, error }`.
 */
export async function diffChanges(dir, signal) {
  const info = await repoInfo(dir, signal)
  if (info === undefined) return { ok: false, error: NOT_A_REPO, dir }
  const root = info.root
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, signal })
  if (!status.ok) return { ok: false, error: 'git-failed', message: status.message }
  const entries = parseStatus(status.stdout)
  const files = []
  let total = 0
  let truncated = false
  for (const entry of entries) {
    if (files.length >= DIFF_MAX_FILES) {
      truncated = true
      break
    }
    const untracked = entry.code === '??'
    // `--no-index` is how an untracked file gets a patch at all, and it reports
    // "differences" with exit code 1 — the same code a failure would use, so
    // the text is what decides, not the code.
    // A rename needs both of its paths in the pathspec: with only the new one
    // git cannot pair it, and reports the file as freshly added instead of
    // moved — right content, wrong claim.
    const paths = entry.from === undefined ? [entry.path] : [entry.path, entry.from]
    const args = untracked
      ? ['diff', '--no-index', '--no-color', '-U3', '--', '/dev/null', entry.path]
      : ['diff', 'HEAD', '--no-color', '-U3', '--', ...paths]
    const result = await runGit(args, { cwd: root, signal })
    const patch = result.stdout
    if (!result.ok && patch === '') {
      files.push({ path: entry.path, code: statusCode(entry.code), from: entry.from, patch: '', additions: 0, deletions: 0, error: 'git-failed' })
      continue
    }
    const kept = total >= DIFF_MAX_TOTAL_BYTES
      ? ''
      : patch.slice(0, DIFF_MAX_FILE_BYTES)
    if (kept.length < patch.length) truncated = true
    total += kept.length
    const counts = patchCounts(kept)
    const record = {
      path: entry.path,
      code: statusCode(entry.code),
      patch: kept,
      additions: counts.additions,
      deletions: counts.deletions,
      binary: /^Binary files /m.test(kept) || /^GIT binary patch$/m.test(kept),
    }
    if (entry.from !== undefined) record.from = entry.from
    files.push(record)
  }
  return {
    ok: true,
    root,
    branch: await currentBranch(root, signal),
    files,
    changed: entries.length,
    truncated,
  }
}
