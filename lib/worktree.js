/**
 * gord-dsh-worktree — git worktree primitives.
 *
 * Every operation is a thin, promise-wrapped `git` invocation with a fixed
 * argument vector (never a shell string), so a branch name or path can never
 * be interpreted as a flag or a command. Results are normalized into plain
 * JSON so the host tool output, the HTTP surface, and the client panel all
 * read the same shape.
 *
 * @module gord-dsh-worktree/worktree
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Hard ceiling for one git invocation; keeps a wedged fetch/checkout from hanging the tool. */
const GIT_TIMEOUT_MS = 30_000
/** Generous cap: `worktree list --porcelain` on a busy repo is small, but status can be large. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Run one git command.
 *
 * The environment is sanitized rather than inherited wholesale: no terminal
 * prompt (a credential prompt would hang a non-interactive tool), no optional
 * locks (so a background poll never blocks a concurrent user command), and a
 * stable locale (so parsing `porcelain` output never depends on the caller's
 * language).
 *
 * @param {string[]} args - git arguments, already split.
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, message: string }>}
 */
export function runGit(args, options = {}) {
  const { cwd, signal, timeoutMs = GIT_TIMEOUT_MS } = options
  return new Promise((settle) => {
    execFile(
      'git',
      args,
      {
        cwd,
        signal,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (error === null || error === undefined) {
          settle({ ok: true, code: 0, stdout: out, stderr: err, message: '' })
          return
        }
        const code = typeof error.code === 'number' ? error.code : -1
        const message = (err.trim() || String(error.message ?? error)).trim()
        settle({ ok: false, code, stdout: out, stderr: err, message })
      },
    )
  })
}

/**
 * Reject an argument that would be read as an option by git.
 *
 * Tool arguments reach `git` positionally, so a leading `-` (or an empty
 * string) is a silent argument-injection vector rather than a typo we can
 * shrug off.
 *
 * @param {string} value - one positional argument.
 * @param {string} label - parameter name for the error message.
 * @returns {string} the same value when it is safe.
 */
export function positional(value, label) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${label} must not be empty`)
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-" (received ${JSON.stringify(text)})`)
  if (text.includes('\0')) throw new Error(`${label} must not contain a NUL byte`)
  return text
}

/**
 * Resolve a repository's identity from any directory inside it.
 *
 * `root` is the *current* worktree's root, while `commonDir` is the shared
 * `.git` — they differ exactly when the session already runs inside a linked
 * worktree, which the create path reports so the user never wonders why new
 * worktrees appear next to a different checkout.
 *
 * @param {string} dir - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{ root: string, gitDir: string, commonDir: string, mainRoot: string, branch: string } | undefined>}
 */
export async function repoInfo(dir, signal) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir, signal })
  if (!inside.ok || inside.stdout.trim() !== 'true') return undefined
  const root = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, signal })
  if (!root.ok) return undefined
  const gitDirRaw = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: dir, signal })
  // `--path-format=absolute` needs git >= 2.31; fall back to resolving by hand.
  let commonDirRaw = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, signal })
  if (!commonDirRaw.ok) commonDirRaw = await runGit(['rev-parse', '--git-common-dir'], { cwd: dir, signal })
  const rootPath = resolve(root.stdout.trim())
  const gitDir = gitDirRaw.ok ? resolve(gitDirRaw.stdout.trim()) : join(rootPath, '.git')
  const commonDir = commonDirRaw.ok
    ? resolve(dirname(gitDir), commonDirRaw.stdout.trim())
    : gitDir
  return {
    root: rootPath,
    gitDir,
    commonDir,
    mainRoot: dirname(commonDir),
    branch: await currentBranch(rootPath, signal),
  }
}

/**
 * Read the checked-out branch, degrading to a short-commit marker when HEAD is
 * detached so the surface never shows the useless literal `HEAD`.
 *
 * @param {string} dir - repository directory.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} branch name, or `detached@<sha>`.
 */
export async function currentBranch(dir, signal) {
  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, signal })
  const name = head.ok ? head.stdout.trim() : ''
  if (name !== '' && name !== 'HEAD') return name
  const short = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir, signal })
  return short.ok ? `detached@${short.stdout.trim()}` : 'unknown'
}

/**
 * Parse `git worktree list --porcelain` into records.
 *
 * @param {string} text - porcelain output.
 * @returns {Array<{ path: string, head: string, branch: string, detached: boolean, bare: boolean, locked: boolean, pruned: boolean, current: boolean }>}
 */
export function parseWorktreeList(text) {
  const records = []
  let current = null
  const flush = () => {
    if (current !== null) records.push(current)
    current = null
  }
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') {
      flush()
      continue
    }
    const index = line.indexOf(' ')
    const key = index < 0 ? line : line.slice(0, index)
    const value = index < 0 ? '' : line.slice(index + 1)
    if (key === 'worktree') {
      flush()
      current = {
        path: resolve(value.trim()),
        head: '',
        branch: '',
        detached: false,
        bare: false,
        locked: false,
        pruned: false,
        current: false,
      }
      continue
    }
    if (current === null) continue
    if (key === 'HEAD') current.head = value.trim()
    else if (key === 'branch') current.branch = value.trim().replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') current.locked = true
    else if (key === 'pruned') current.pruned = true
  }
  flush()
  return records
}

/**
 * Lexical path spelling plus, when the path exists, its canonical spelling.
 *
 * Both are needed and neither is an optimization. Git reports canonical paths
 * (`/private/var/...`), while a caller may hold the symlinked spelling
 * (`/var/...`) it typed; comparing only one of them makes a worktree look
 * unknown. Registration uses the lexical spelling so the directory the user
 * chose is the one recorded, and matching accepts either.
 *
 * @param {string} path - candidate path.
 * @returns {string[]} candidate spellings, de-duplicated.
 */
export function pathSpellings(path) {
  const lexical = resolve(path)
  const spellings = [lexical]
  try {
    const canonical = realpathSync.native(lexical)
    if (canonical !== lexical) spellings.push(canonical)
  } catch {
    // A path that does not exist has exactly one spelling; matching falls back to lexical.
  }
  return spellings
}

/**
 * `git worktree list --porcelain` records plus the session's own checkout
 * flagged.
 *
 * @param {string} dir - directory inside the repository.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Array<ReturnType<typeof parseWorktreeList>[number]>>}
 */
export async function worktreeList(dir, signal) {
  const res = await runGit(['worktree', 'list', '--porcelain'], { cwd: dir, signal })
  if (!res.ok) throw new Error(`git worktree list failed: ${res.message}`)
  const root = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, signal })
  const here = root.ok ? pathSpellings(root.stdout.trim()) : []
  return parseWorktreeList(res.stdout).map((entry) => {
    const spellings = pathSpellings(entry.path)
    return { ...entry, spellings, current: spellings.some((candidate) => here.includes(candidate)) }
  })
}

/**
 * Whether a worktree has uncommitted or untracked changes.
 *
 * `--untracked-files=normal` is deliberate: an untracked scratch file would be
 * destroyed by `worktree remove --force`, so it must count as dirty. Ignored
 * files stay out of the count because removal never touches them.
 *
 * @param {string} dir - worktree path.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<boolean>} true when the tree is not clean.
 */
export async function isDirty(dir, signal) {
  const res = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: dir, signal })
  if (!res.ok) return true // unreadable status must never be read as "safe to delete"
  return res.stdout.trim() !== ''
}

/**
 * Validate one branch name through git itself, so we inherit the real ref rules
 * instead of approximating them.
 *
 * @param {string} dir - repository directory.
 * @param {string} name - candidate branch name.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the validated name.
 */
export async function assertBranchName(dir, name, signal) {
  const candidate = positional(name, 'branch')
  const res = await runGit(['check-ref-format', '--branch', candidate], { cwd: dir, signal })
  if (!res.ok) throw new Error(`invalid branch name ${JSON.stringify(candidate)}: ${res.message}`)
  return candidate
}

/** Whether a local branch already exists. */
export async function branchExists(dir, name, signal) {
  const res = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: dir, signal })
  return res.ok
}

/** Whether the base revision resolves to a commit. */
export async function revisionExists(dir, revision, signal) {
  const res = await runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: dir, signal })
  return res.ok
}

/**
 * Turn a base branch into a worktree branch name (`main` → `worktree/main`).
 *
 * @param {string} base - base branch or revision.
 * @returns {string} a candidate branch name.
 */
export function defaultBranchName(base) {
  const cleaned = String(base ?? '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .replace(/[^A-Za-z0-9._\-/]+/g, '-')
    .replace(/^[-/.]+/, '')
  return `worktree/${cleaned === '' || cleaned === 'HEAD' ? 'new' : cleaned}`
}

/** Filesystem-safe directory name for a branch (`worktree/feat-x` → `worktree-feat-x`). */
export function slugifyBranch(branch) {
  return String(branch ?? '')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120) || 'worktree'
}

/**
 * Default parent directory for new worktrees: a sibling of the repository
 * (`/src/app` → `/src/app-worktrees`), so a worktree never lands inside the
 * repository it is checked out from.
 *
 * @param {string} repoRoot - main repository root.
 * @returns {string} absolute parent directory.
 */
export function defaultWorktreeParent(repoRoot) {
  const name = basename(repoRoot.replace(/[/\\]+$/, ''))
  return join(dirname(repoRoot), `${name}-worktrees`)
}

/**
 * Resolve the project directory one operation applies to.
 *
 * Precedence: an explicit `workdir` argument (absolute, or relative to the
 * session cwd), then a selected `repo` path, then the session's own cwd. The
 * session cwd comes from the session header — the same anchor the bash tool
 * uses — so the tool does not need a separate notion of "current directory".
 *
 * @param {{ workdir?: string, dir?: string }} args - tool/HTTP arguments.
 * @param {string | undefined} sessionCwd - `exec.agent.session.header.cwd`.
 * @returns {string} absolute directory to run git in.
 */
export function resolveProjectDir(args, sessionCwd) {
  const explicit = [args?.workdir, args?.dir].find((value) => typeof value === 'string' && value.trim() !== '')
  const base = typeof sessionCwd === 'string' && sessionCwd.trim() !== '' ? resolve(sessionCwd) : process.cwd()
  if (explicit === undefined) return base
  const text = explicit.trim()
  return isAbsolute(text) ? resolve(text) : resolve(base, text)
}

/**
 * Match one worktree from a list by path, directory name, or branch name.
 *
 * @param {Array<{ path: string, branch: string, spellings?: string[] }>} list - worktree records.
 * @param {string} ref - user-supplied selector.
 * @param {string} cwd - directory relative selectors resolve against.
 * @returns {object | undefined} the matched record.
 */
export function matchWorktree(list, ref, cwd) {
  const text = positional(ref, 'path')
  const wanted = pathSpellings(isAbsolute(text) ? text : resolve(cwd, text))
  return (
    list.find((entry) => (entry.spellings ?? [entry.path]).some((spelling) => wanted.includes(spelling))) ??
    list.find((entry) => entry.branch === text) ??
    list.find((entry) => basename(entry.path) === text) ??
    list.find((entry) => basename(entry.path) === slugifyBranch(text)) ??
    // A branch selector that git reports under a different spelling, e.g.
    // `worktree/x` selected while the branch carries another prefix.
    list.find((entry) => (entry.spellings ?? [entry.path]).some((spelling) => basename(spelling) === slugifyBranch(text)))
  )
}

/** Ensure a directory exists (mkdir -p). */
export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

/**
 * Whether a path exists and holds at least one entry.
 *
 * @param {string} path - candidate directory.
 * @returns {boolean} true when a non-empty directory is already there.
 */
export function isNonEmptyDir(path) {
  if (!existsSync(path)) return false
  try {
    if (!statSync(path).isDirectory()) return true
  } catch {
    return true
  }
  return readdirSync(path).length > 0
}