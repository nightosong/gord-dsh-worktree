/**
 * gord-dsh-worktree host-half smoke test — runs the operation layer against a real
 * throwaway repository. Executed with plain `node` so it can import the same
 * ESM modules the plugin ships; no test framework is required to prove the
 * guards behave.
 *
 *   node test/host-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { basename } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as archive from '../lib/archive.js'
import * as service from '../lib/service.js'
import { canonicalSpelling, defaultWorktreeParent, parseWorktreeList, slugifyBranch, worktreeCode } from '../lib/worktree.js'

let failures = 0
let checks = 0

/** Assert one condition, printing a compact pass/fail line. */
function check(label, condition, detail) {
  checks++
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures++
  process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/** Run git in the scratch repository, inheriting its identity config. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gord-dsh-worktree-test-')))
// The default worktree parent is `$DSH_HOME/worktree`, so the home is pointed
// at the scratch directory: the default is then exercised for real without
// writing into the user's own `~/.dsh`.
process.env.DSH_HOME = scratch
const repo = join(scratch, 'app')
process.stdout.write(`scratch repository: ${repo}\n`)

try {
  execFileSync('git', ['init', '--initial-branch=main', repo], { encoding: 'utf8' })
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'README.md'), '# scratch\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')

  process.stdout.write('\npure helpers\n')
  // Worktrees live outside every repository: no ignore rule to add and forget,
  // and nothing extra for a build or search to walk.
  check('default parent is the harness home', defaultWorktreeParent() === join(dshHomePath('worktree')), defaultWorktreeParent())
  check('default parent is outside the repository', !defaultWorktreeParent().startsWith(process.cwd()), defaultWorktreeParent())
  check('worktree codes are eight hex characters', /^[0-9a-f]{8}$/.test(worktreeCode()), worktreeCode())
  check('worktree codes do not repeat', worktreeCode() !== worktreeCode())
  // Regression: a path that does not exist has no canonical form of its own, so
  // the deepest existing ancestor decides. Without this the two spellings of one
  // deleted directory never compare equal.
  check('canonicalSpelling resolves an existing path', canonicalSpelling(scratch) === scratch, canonicalSpelling(scratch))
  check(
    'canonicalSpelling canonicalizes through a missing leaf',
    canonicalSpelling(join(scratch, 'absent')) === join(scratch, 'absent'),
    canonicalSpelling(join(scratch, 'absent')),
  )
  check(
    'canonicalSpelling unifies two spellings of one missing path',
    canonicalSpelling('/tmp/gord-absent') === canonicalSpelling('/private/tmp/gord-absent'),
    `${canonicalSpelling('/tmp/gord-absent')} vs ${canonicalSpelling('/private/tmp/gord-absent')}`,
  )
  check('slugifyBranch flattens slashes', slugifyBranch('worktree/feature/x') === 'worktree-feature-x', slugifyBranch('worktree/feature/x'))
  check('the default parent ignores the repository', defaultWorktreeParent() === join(scratch, 'worktree'), defaultWorktreeParent())
  const parsed = parseWorktreeList(git(repo, 'worktree', 'list', '--porcelain'))
  check('parseWorktreeList reads the main worktree', parsed.length === 1 && parsed[0].branch === 'main', JSON.stringify(parsed))

  process.stdout.write('\ndescribe + list\n')
  const described = await service.describeRepository(repo)
  check('describe ok', described.ok === true, JSON.stringify(described))
  check('describe finds the main root', described.mainRoot === repo, described.mainRoot)
  check('describe reports the current branch', described.branch === 'main', described.branch)
  check('describe reports a clean tree', described.dirty === false)
  const notRepo = await service.describeRepository(tmpdir())
  check('describe rejects a non-repository', notRepo.ok === false && notRepo.error === service.NOT_A_REPO, JSON.stringify(notRepo))

  process.stdout.write('\ncreate\n')
  const created = await service.createWorktree({ dir: repo, branch: 'worktree/feature-a', base: 'main' })
  check('create ok', created.ok === true, JSON.stringify(created))
  check('create reports a new branch', created.createdBranch === true)
  check('create used the default parent', created.path === join(scratch, 'worktree', 'worktree-feature-a'), created.path)
  check('create checked out the branch', created.branch === 'worktree/feature-a', created.branch)
  check('main worktree is untouched', git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main')

  const relative = await service.createWorktree({ dir: repo, branch: 'worktree/feature-b', base: 'main', path: 'app-worktrees/custom-dir' })
  check('create accepts a repo-relative path', relative.ok === true && relative.path === join(repo, 'app-worktrees/custom-dir'), JSON.stringify(relative.path))

  const rejectedBase = await service.createWorktree({ dir: repo, branch: 'worktree/nope', base: 'no-such-rev' })
  check('create refuses an unknown base', rejectedBase.ok === false && rejectedBase.error === 'unknown-base', JSON.stringify(rejectedBase))

  const badBranch = await service.createWorktree({ dir: repo, branch: '-evil', base: 'main' })
  check('create refuses a leading-dash branch', badBranch.ok === false && badBranch.error === 'invalid-branch', JSON.stringify(badBranch))

  const reused = await service.createWorktree({ dir: repo, branch: 'worktree/feature-a', base: 'main' })
  check('create refuses an occupied target directory', reused.ok === false && reused.error === 'path-in-use', JSON.stringify(reused))

  const doubleCheckout = await service.createWorktree({ dir: repo, branch: 'worktree/feature-a', base: 'main', path: 'app-worktrees/other' })
  check('create refuses a branch checked out elsewhere', doubleCheckout.ok === false && doubleCheckout.error === 'git-failed', JSON.stringify(doubleCheckout))

  const described2 = await service.listWorktrees(repo)
  check('list reports three worktrees', described2.worktrees.length === 3, String(described2.worktrees.length))
  check('list offers branches', Array.isArray(described2.branches) && described2.branches.includes('main'), JSON.stringify(described2.branches))
  const current = described2.worktrees.filter((entry) => entry.current)
  check('exactly one worktree is flagged current', current.length === 1 && current[0].path === repo, JSON.stringify(current.map((e) => e.path)))

  process.stdout.write('\nstatus\n')
  const status = await service.worktreeStatus(created.path)
  check('status ok', status.ok === true && status.dirty === false, JSON.stringify(status))
  writeFileSync(join(created.path, 'untracked.txt'), 'x\n')
  const dirtyStatus = await service.worktreeStatus(created.path)
  check('status sees an untracked file', dirtyStatus.dirty === true && dirtyStatus.changes.length === 1, JSON.stringify(dirtyStatus.changes))

  process.stdout.write('\nremove guards\n')
  const blocked = await service.removeWorktree({ dir: repo, path: created.path })
  check('remove refuses a dirty worktree', blocked.ok === false && blocked.error === 'dirty', JSON.stringify(blocked))
  check('refused removal kept the directory', existsSync(created.path))

  const mainGuard = await service.removeWorktree({ dir: repo, path: repo })
  check('remove refuses the main worktree', mainGuard.ok === false && mainGuard.error === 'main-worktree', JSON.stringify(mainGuard))

  const unknown = await service.removeWorktree({ dir: repo, path: 'not-a-worktree' })
  check('remove reports an unknown worktree', unknown.ok === false && unknown.error === 'unknown-worktree', JSON.stringify(unknown))

  const byBranch = await service.removeWorktree({ dir: repo, path: 'worktree/feature-a', force: true, deleteBranch: true })
  check('remove accepts a branch selector with force', byBranch.ok === true, JSON.stringify(byBranch))
  check('remove deleted the directory', !existsSync(created.path))
  check('remove deleted the branch', byBranch.branchDeleted === true)
  check('branch is gone', !git(repo, 'branch', '--list', 'worktree/feature-a').includes('feature-a'))

  const byDirName = await service.removeWorktree({ dir: repo, path: 'custom-dir' })
  check('remove accepts a directory name', byDirName.ok === true && byDirName.removed === relative.path, JSON.stringify(byDirName))

  // Regression: macOS reports /var through the /private/var symlink, so a path
  // the user typed and the path git reports are different spellings of one
  // worktree. Matching must accept either.
  process.stdout.write('\nsymlinked path spellings\n')
  const viaCanonical = await service.createWorktree({ dir: repo, branch: 'worktree/spelled', base: 'main' })
  check('create ok for the spelling case', viaCanonical.ok === true, JSON.stringify(viaCanonical))
  const viaSymlink = viaCanonical.path.replace('/private/var/', '/var/')
  check('the symlinked spelling really differs', viaSymlink !== viaCanonical.path)
  const matched = await service.removeWorktree({ dir: repo, path: viaSymlink })
  check('remove matches a worktree by symlinked spelling', matched.ok === true && matched.removed === viaCanonical.path, JSON.stringify(matched))

  // Regression: a worktree whose directory was deleted by hand stays in git's
  // registry; recreating it must name the fix rather than leaking a git error.
  process.stdout.write('\nstale record\n')
  const stale = await service.createWorktree({ dir: repo, branch: 'worktree/stale', base: 'main' })
  rmSync(stale.path, { recursive: true, force: true })
  const staleAgain = await service.createWorktree({ dir: repo, branch: 'worktree/stale', base: 'main' })
  check('create reports a stale registration', staleAgain.ok === false && staleAgain.error === 'stale-record', JSON.stringify(staleAgain))

  const finalList = await service.listWorktrees(repo)
  check('list still shows the stale record', finalList.worktrees.some((entry) => entry.branch === 'worktree/stale'), JSON.stringify(finalList.worktrees.map((e) => e.branch)))

  process.stdout.write('\nformatWorktrees\n')
  check(
    'formatWorktrees renders one row per worktree',
    service.formatWorktrees(finalList.worktrees, repo).split('\n').length === finalList.worktrees.length,
    service.formatWorktrees(finalList.worktrees, repo),
  )
  check(
    'formatWorktrees marks the current worktree',
    service.formatWorktrees(finalList.worktrees, repo).includes('[current]'),
  )

  process.stdout.write('\ntool registration (the model-facing path)\n')
  const registered = new Map()
  const plugin = await import('../lib/index.js')
  const stubCtx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    inject: () => {},
    effect: (callback) => callback(),
    get: () => undefined,
    on: () => {},
  }
  plugin.apply(stubCtx, { defaultParent: '' })
  const expected = ['worktree_list', 'worktree_create', 'worktree_status', 'worktree_remove', 'worktree_prune']
  check('all five tools register', expected.every((name) => registered.has(name)), [...registered.keys()].join(', '))
  check('no unexpected tool names', registered.size === expected.length, String(registered.size))

  // The tool resolves the repository from the session cwd, exactly as the bash
  // tool does — that shared anchor is what lets the model call a worktree tool
  // without restating which repository it means.
  const exec = { signal: undefined, agent: { session: { header: { cwd: repo } } } }
  const listed = await registered.get('worktree_list').execute({}, exec)
  check('worktree_list resolves from the session cwd', listed.mainRoot === repo, listed.mainRoot)
  check('worktree_list returns the registered records', listed.worktrees.some((entry) => entry.branch === 'worktree/stale'))
  check(
    'worktree_list output carries no internal fields',
    listed.worktrees.every((entry) => !('spellings' in entry)),
    JSON.stringify(listed.worktrees[0]),
  )
  const rendered = registered.get('worktree_list').output.render({}, listed)
  check('worktree_list renders text for the model', typeof rendered[0].text === 'string' && rendered[0].text.includes('Repository'))
  check('worktree_list presents a call card', registered.get('worktree_list').presentCall({}).card === 'generic')

  const statusTool = await registered.get('worktree_status').execute({ workdir: repo }, exec)
  check('worktree_status accepts an explicit workdir', statusTool.path === repo, statusTool.path)

  let refused
  try {
    await registered.get('worktree_remove').execute({ path: repo, workdir: repo }, exec)
  } catch (error) {
    refused = String(error.message)
  }
  check('worktree_remove surfaces the main-worktree refusal', refused !== undefined && refused.includes('main worktree'), refused)

  const pruned = await registered.get('worktree_prune').execute({ dryRun: true, workdir: repo }, exec)
  check('worktree_prune supports a dry run', pruned.dryRun === true && typeof pruned.output === 'string')

  // The stale-record guard has to survive the other spelling of the same path.
  // macOS reaches `/var/folders/…` through `/private/var/folders/…`, and a guard
  // comparing canonical paths literally misses exactly here — the recorded path
  // is canonical, the caller's is not, and both name a directory that is gone.
  // The user then gets git's raw refusal instead of being told to prune.
  process.stdout.write('\nstale record under a symlinked spelling\n')
  const staleSym = await service.createWorktree({ dir: repo, branch: 'worktree/stale-sym', base: 'main' })
  check('create ok for the stale-spelling case', staleSym.ok === true, JSON.stringify(staleSym))
  rmSync(staleSym.path, { recursive: true, force: true })
  const staleRetry = await service.createWorktree({
    dir: repo,
    branch: 'worktree/stale-sym',
    base: 'main',
    path: staleSym.path.replace('/private/var/', '/var/'),
  })
  check(
    'the stale guard fires through the symlinked spelling',
    staleRetry.ok === false && staleRetry.error === 'stale-record',
    JSON.stringify(staleRetry),
  )
  check(
    'the stale guard names the fix',
    String(staleRetry.message).includes('worktree_prune'),
    String(staleRetry.message),
  )

  // The panel's create route must not register a workspace. It used to, and the
  // damage was invisible to the unit tests and to the client tests: the route
  // adopted the new directory on its own, so a client that had stopped asking
  // for adoption still produced a new sidebar entry — and, because a workspace
  // is created with a blank session, silently moved the user's next message
  // into the worktree. Asserting it at the route is the only place that catches
  // a second adoption site.
  process.stdout.write('\npanel API routes\n')
  const routes = new Map()
  const adopted = []
  const adoptedTitles = []
  const routeCtx = {
    tools: stubCtx.tools,
    effect: (callback) => callback(),
    get: () => undefined,
    on: () => {},
    webServer: {
      port: 0,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    workspaceRegistry: {
      async create(path, title) {
        adopted.push(path)
        adoptedTitles.push(title)
        return { id: 'w-adopted', title: 'adopted' }
      },
    },
    inject(names, callback) {
      // The settings and workspace injections only run where those services
      // exist; this stub supplies the two the route needs.
      if (names.every((name) => routeCtx[name] !== undefined)) callback(routeCtx)
    },
  }
  plugin.apply(routeCtx, { defaultParent: '' })
  const apiHandler = routes.get('/gord-dsh-worktree/api')
  check('the panel API registers its route', typeof apiHandler === 'function')

  /** Call one panel action and return the JSON body the route wrote. */
  const callApi = async (action, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.url = `/gord-dsh-worktree/api?action=${action}`
    req.method = 'POST'
    req.headers = {}
    let parsed
    const res = { writeHead() {}, end(text) { parsed = JSON.parse(text) } }
    await apiHandler(req, res)
    return parsed
  }

  const routed = await callApi('create', { dir: repo, branch: 'worktree/route-check', base: 'main' })
  check('panel create succeeds over the route', routed.ok === true, JSON.stringify(routed))
  // The route adopts, and it has to: workspace membership is exact-path
  // equality, so a session rooted in the worktree needs a workspace at that
  // path. Without one the shell has nowhere to draw the session and shows
  // "choose a workspace to start" over a session that exists.
  check('panel create registers a workspace', routed.workspace?.workspaceId === 'w-adopted', JSON.stringify(routed.workspace))
  // Titled after the project, because the sidebar cannot nest a worktree under
  // it: a bare code reads as an unrelated project.
  check(
    'the worktree workspace is titled after its project',
    adoptedTitles.length === 1 && adoptedTitles[0] === `${basename(repo)} · worktree-route-check`,
    JSON.stringify(adoptedTitles),
  )
  check('panel create adopts the worktree path', adopted.length === 1 && adopted[0] === routed.path, JSON.stringify({ adopted, path: routed.path }))
  // The tool must not: a worktree made mid-conversation leaves the session
  // where it is, so adopting there would add a sidebar entry nobody asked for.
  check('the tool path adopts nothing', adopted.length === 1, JSON.stringify(adopted))
  check('panel create reports the path it made', routed.path === join(scratch, 'worktree', 'worktree-route-check'), routed.path)

  // A branch that exists only on a remote is the case that used to be silently
  // wrong: naming it created a fresh branch of the same name off the local base,
  // so the caller believed they held the remote's commits when they did not.
  // Each probe needs its own clone, because an earlier probe's new local branch
  // would push a later probe down the "already exists, just check it out" path.
  process.stdout.write('\nremote-only branches\n')
  const origin = join(scratch, 'origin.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8' })
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')

  const author = join(scratch, 'author')
  execFileSync('git', ['clone', '-q', origin, author], { encoding: 'utf8' })
  git(author, 'config', 'user.email', 'author@example.com')
  git(author, 'config', 'user.name', 'author')
  git(author, 'checkout', '-q', '-b', 'colleague/feature')
  writeFileSync(join(author, 'colleague.txt'), 'their work\n')
  git(author, 'add', '.')
  git(author, 'commit', '-m', 'colleague work')
  git(author, 'push', '-q', 'origin', 'colleague/feature')
  const remoteCommit = git(author, 'rev-parse', 'HEAD')

  /** A fresh clone tracking `origin`, so probes cannot contaminate each other. */
  const freshClone = (name) => {
    const dir = join(scratch, name)
    execFileSync('git', ['clone', '-q', origin, dir], { encoding: 'utf8' })
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'test')
    return dir
  }

  const picked = await service.createWorktree({ dir: freshClone('picked'), branch: 'colleague/feature', path: join(scratch, 'wt-picked') })
  check('remote-only branch is created', picked.ok === true, JSON.stringify(picked))
  check('remote-only branch reports the pickup', picked.pickedUpRemote === 'origin/colleague/feature', picked.pickedUpRemote)
  check('remote-only branch starts at the remote commit', git(picked.path, 'rev-parse', 'HEAD') === remoteCommit)
  check(
    'remote-only branch tracks the remote',
    git(picked.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') === 'origin/colleague/feature',
  )

  const shadowed = await service.createWorktree({
    dir: freshClone('shadowed'),
    branch: 'colleague/feature',
    base: 'main',
    path: join(scratch, 'wt-shadowed'),
  })
  check('an explicit base is still honoured', shadowed.ok === true && shadowed.base === 'main', JSON.stringify(shadowed))
  check('shadowed remote is reported', shadowed.shadowedRemote === 'origin/colleague/feature', shadowed.shadowedRemote)
  check('pickedUpRemote stays unset when a base was named', shadowed.pickedUpRemote === undefined)

  const plain = await service.createWorktree({ dir: freshClone('plain'), branch: 'feat/mine', base: 'main', path: join(scratch, 'wt-plain') })
  check('a normal new branch reports no remote noise', plain.pickedUpRemote === undefined && plain.shadowedRemote === undefined)

  const branchesList = await service.listWorktrees(freshClone('branches'))
  check('list exposes remote-tracking branches', branchesList.branches.includes('origin/colleague/feature'), JSON.stringify(branchesList.branches))
  check('list keeps local branches separate', branchesList.localBranches.includes('main') && !branchesList.localBranches.includes('origin/colleague/feature'))

  const listTool = await registered.get('worktree_list').execute({ workdir: freshClone('listtool') }, exec)
  check('worktree_list tool surfaces branches', Array.isArray(listTool.branches) && listTool.branches.length > 0, JSON.stringify(listTool.branches))
  check('worktree_list tool surfaces localBranches', Array.isArray(listTool.localBranches))
  const listRendered = registered.get('worktree_list').output.render({}, listTool)
  check('worktree_list text names the branches', listRendered[0].text.includes('Branches:'), listRendered[0].text.slice(0, 120))

  // Asked to "work on this in a new worktree" mid-conversation, the model has
  // to know the session itself cannot move — otherwise it claims to have
  // switched directories it never left.
  const createTool = registered.get('worktree_create')
  check('worktree_create explains the mid-session flow', createTool.description.includes('workdir'), createTool.description.slice(-200))
  check('worktree_create says the session cannot be moved', createTool.description.includes('cannot be moved'), createTool.description.slice(-200))

  // The Changes tab answers with the working tree against HEAD, so these probes
  // are about the shapes a real working tree can be in — a rename is not an
  // addition, a binary file has no hunks, a clean tree is empty — rather than
  // about the route's plumbing.
  process.stdout.write('\ndiff of uncommitted changes\n')
  const changes = join(scratch, 'changes')
  execFileSync('git', ['init', '--initial-branch=main', changes], { encoding: 'utf8' })
  git(changes, 'config', 'user.email', 'test@example.com')
  git(changes, 'config', 'user.name', 'test')
  writeFileSync(join(changes, 'modify.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(changes, 'delete.txt'), 'gone\n')
  writeFileSync(join(changes, 'rename-old.txt'), 'moved\n')
  writeFileSync(join(changes, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
  mkdirSync(join(changes, 'sub'))
  writeFileSync(join(changes, 'sub', 'nested.txt'), 'nested\n')
  execFileSync('git', ['-C', changes, 'add', '.'], { encoding: 'utf8' })
  git(changes, 'commit', '-m', 'init')

  const cleanDiff = await service.diffChanges(changes)
  check('a clean tree reports no files', cleanDiff.ok === true && cleanDiff.files.length === 0, JSON.stringify(cleanDiff))
  check('a clean tree still names its branch', cleanDiff.branch === 'main', cleanDiff.branch)

  writeFileSync(join(changes, 'modify.txt'), 'one\nTWO\nthree\nfour\n')
  writeFileSync(join(changes, 'fresh.txt'), 'brand new\n')
  rmSync(join(changes, 'delete.txt'))
  git(changes, 'mv', 'rename-old.txt', 'rename-new.txt')
  writeFileSync(join(changes, 'bin.dat'), Buffer.from([0, 9, 9, 0, 3]))

  const dirty = await service.diffChanges(changes)
  const byPath = Object.fromEntries(dirty.files.map((file) => [file.path, file]))
  check('every changed file is listed', dirty.changed === 5, JSON.stringify(dirty.files.map((file) => file.path)))
  check('a modification carries both counts', byPath['modify.txt'].additions === 2 && byPath['modify.txt'].deletions === 1, JSON.stringify(byPath['modify.txt']))
  check('an untracked file reads as an addition', byPath['fresh.txt'].code === '??' && byPath['fresh.txt'].additions === 1, JSON.stringify(byPath['fresh.txt']))
  check('a deletion keeps its removed line', byPath['delete.txt'].code === '.D' && byPath['delete.txt'].deletions === 1, JSON.stringify(byPath['delete.txt']))
  check('a rename says where it came from', byPath['rename-new.txt'].from === 'rename-old.txt', JSON.stringify(byPath['rename-new.txt']))
  // Passing only the new path to `git diff` would report the moved file as
  // freshly added — right content, wrong claim.
  check('a pure rename is not counted as content', byPath['rename-new.txt'].additions === 0 && byPath['rename-new.txt'].deletions === 0, JSON.stringify(byPath['rename-new.txt']))
  check('a binary file is flagged rather than diffed', byPath['bin.dat'].binary === true, JSON.stringify(byPath['bin.dat']))
  check('the patch is a real unified diff', byPath['modify.txt'].patch.includes('@@ -1,3 +1,4 @@'), byPath['modify.txt'].patch.slice(0, 80))
  check('the answer names the repository root', dirty.root === realpathSync(changes), dirty.root)
  check('nothing was truncated at this size', dirty.truncated === false)

  // A session's directory can be a subdirectory of the repository, and the
  // answer has to be the whole repository's changes either way.
  const nestedDiff = await service.diffChanges(join(changes, 'sub'))
  check('a subdirectory resolves to the same root', nestedDiff.root === realpathSync(changes), nestedDiff.root)
  check('a subdirectory sees the same changes', nestedDiff.changed === 5, nestedDiff.changed)

  const outside = await service.diffChanges(scratch)
  check('a directory outside any repository is reported', outside.ok === false && outside.error === 'not-a-repository', JSON.stringify(outside))

  const routedDiff = await callApi('diff', { dir: changes })
  check('the diff action answers over the route', routedDiff.ok === true && routedDiff.files.length === 5, JSON.stringify(routedDiff).slice(0, 160))
  check('the routed diff carries patches', typeof routedDiff.files[0].patch === 'string' && routedDiff.files[0].patch.length > 0)

  process.stdout.write('\ndiff helpers\n')
  const statusEntries = service.parseStatus(' M a.txt\0R  new.txt\0old.txt\0?? fresh.txt\0')
  check('status codes and paths are paired', statusEntries.length === 3, JSON.stringify(statusEntries))
  check('a rename keeps its original path', statusEntries[1].from === 'old.txt' && statusEntries[1].path === 'new.txt', JSON.stringify(statusEntries[1]))
  check('an untracked file is its own code', statusEntries[2].code === '??' && statusEntries[2].path === 'fresh.txt', JSON.stringify(statusEntries[2]))
  const counted = service.patchCounts('--- a\n+++ b\n@@ -1 +1,2 @@\n-gone\n+kept\n+added\n')
  check('counts ignore the file headers', counted.additions === 2 && counted.deletions === 1, JSON.stringify(counted))
  check('an empty patch counts nothing', JSON.stringify(service.patchCounts('')) === '{"additions":0,"deletions":0}')

  process.stdout.write('\narchive record\n')
  check('an unreadable record is not a record', archive.parseArchiveRecord('{oops') === undefined)
  check('a record from another version is ignored', archive.parseArchiveRecord('{"version":99,"archivedAt":{}}') === undefined)
  check('a record without a map is ignored', archive.parseArchiveRecord('{"version":1}') === undefined)
  check('an empty file is not a record', archive.parseArchiveRecord('   ') === undefined)
  const parsedRecord = archive.parseArchiveRecord('{"version":1,"archivedAt":{"session-a":123,"session-b":null,"session-c":"nope"}}')
  check('a record parses its times', parsedRecord.archivedAt['session-a'] === 123, JSON.stringify(parsedRecord))
  check('a null time survives parsing as null', parsedRecord.archivedAt['session-b'] === null)
  check('a non-numeric time becomes unknown', parsedRecord.archivedAt['session-c'] === null, JSON.stringify(parsedRecord))

  // The first sync ever is the one that must not lie: those sessions were
  // archived before anything was recording, so dating them `now` would report
  // the install time as the archive time.
  const seeded = archive.reconcileArchiveRecord(undefined, ['session-a', 'session-b'], 5000, true)
  check('the first sync records ids as unknown, not as now', seeded.archivedAt['session-a'] === null && seeded.archivedAt['session-b'] === null, JSON.stringify(seeded))
  const stamped = archive.reconcileArchiveRecord(seeded, ['session-a', 'session-c'], 6000, false)
  check('an id archived after the first sync is stamped', stamped.archivedAt['session-c'] === 6000, JSON.stringify(stamped))
  check('a seeded id keeps its unknown time', stamped.archivedAt['session-a'] === null, JSON.stringify(stamped))
  check('an id no longer archived is dropped', !('session-b' in stamped.archivedAt), JSON.stringify(stamped))
  const restored = archive.reconcileArchiveRecord(stamped, ['session-c', 'session-b'], 7000, false)
  check('re-archiving records a fresh time, not the old one', restored.archivedAt['session-b'] === 7000, JSON.stringify(restored))
  check('an unchanged record compares equal', archive.sameArchiveRecord(stamped, archive.reconcileArchiveRecord(stamped, ['session-a', 'session-c'], 9000, false)))
  check('a changed record compares unequal', !archive.sameArchiveRecord(stamped, restored))

  const rows = archive.archiveRows(
    ['session-a', 'session-b', 'session-c'],
    (id) => ({
      'session-a': { title: 'newer', cwd: '/tmp/app', createdAt: 10, sizeBytes: 1 },
      'session-b': { title: '', cwd: '/tmp/app', createdAt: 20, sizeBytes: 2 },
      'session-c': { title: 'older', cwd: '/tmp/app', createdAt: 30, sizeBytes: 3 },
    })[id],
    { archivedAt: { 'session-a': 200, 'session-b': null, 'session-c': 100 } },
  )
  check('rows sort newest archive first', rows.map((row) => row.id).join() === 'session-a,session-c,session-b', JSON.stringify(rows.map((r) => r.id)))
  check('an empty title is no title', rows[2].title === undefined, JSON.stringify(rows[2]))
  check('an unrecorded archive time is null, not zero', rows[2].archivedAt === null, JSON.stringify(rows[2]))
  check('rows carry the session date', rows[0].createdAt === 10, JSON.stringify(rows[0]))
  check('rows carry the log size', rows[0].sizeBytes === 1, JSON.stringify(rows[0]))

  check('archived ids come from the registry', archive.archivedIds({ archivedSessionIds: ['session-a'] }).join() === 'session-a')
  check('no registry means no ids', archive.archivedIds(undefined) === undefined)

  process.stdout.write('\narchive operations\n')
  // A stand-in for the workspace registry: only the surface archive.js writes
  // through, so these pin the calls it makes rather than reimplementing them.
  const fakeRegistry = (archived, workspaces = []) => {
    let state = { initialized: true, workspaceIds: workspaces.map((w) => w.id), archivedSessionIds: [...archived] }
    const detached = []
    return {
      get archivedSessionIds() { return state.archivedSessionIds },
      get state() { return state },
      get detached() { return detached },
      requireState() { return state },
      async setState(next) { state = next },
      async enqueueOperation(operation) { return operation() },
      list() {
        return workspaces.map((workspace) => ({
          id: workspace.id,
          sessionIds: workspace.sessionIds.filter((id) => !detached.includes(id)),
          async detachSession(id) { detached.push(id) },
        }))
      },
    }
  }

  const recordPath = archive.archiveRecordPath()
  check('the record lives under the harness home', recordPath.startsWith(scratch), recordPath)
  const firstSync = await archive.syncArchiveRecord({ now: () => 5000 }, ['session-old'])
  check('the first sync seeds the file', firstSync.seeded === true)
  check('the seeded file reads back', (await archive.readArchiveRecordFile(recordPath)).archivedAt['session-old'] === null)
  const laterSync = await archive.syncArchiveRecord({ now: () => 6000 }, ['session-old', 'session-new'])
  check('a later sync stamps only what is new', laterSync.record.archivedAt['session-new'] === 6000 && laterSync.record.archivedAt['session-old'] === null, JSON.stringify(laterSync.record))

  // A real log directory in the harness home, so the delete path runs against
  // the filesystem rather than a mock of it.
  const sessionDir = join(dshHomePath('sessions'), '--tmp-project--', 'session-gone')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'log')
  check('a session directory is found by id', (await archive.sessionDirectory('session-gone')) === sessionDir)
  check('a missing session has no directory', (await archive.sessionDirectory('session-nope')) === undefined)

  const unarchiveRegistry = fakeRegistry(['session-gone', 'session-kept'])
  const unarchived = await archive.unarchiveSessions({ registry: unarchiveRegistry }, ['session-gone'])
  check('unarchive reports what it removed', unarchived.unarchived === 1, JSON.stringify(unarchived))
  check('unarchive removes only the named id', unarchiveRegistry.archivedSessionIds.join() === 'session-kept', JSON.stringify(unarchiveRegistry.state))
  const noop = await archive.unarchiveSessions({ registry: unarchiveRegistry }, ['session-absent'])
  check('unarchiving an id that is not archived changes nothing', noop.unarchived === 0 && unarchiveRegistry.archivedSessionIds.join() === 'session-kept')
  const noRegistry = await archive.unarchiveSessions({ registry: undefined }, ['session-gone'])
  check('unarchive without a registry refuses rather than guessing', noRegistry.ok === false && noRegistry.error === 'no-registry', JSON.stringify(noRegistry))
  const wrongShape = await archive.unarchiveSessions({ registry: { archivedSessionIds: [] } }, ['session-gone'])
  check('a registry without the write surface refuses', wrongShape.ok === false, JSON.stringify(wrongShape))

  // The delete path: a live session must be left alone, and everything else
  // must actually go.
  const cacheDeletes = []
  const deleteRegistry = fakeRegistry(['session-gone', 'session-live'], [{ id: 'w1', sessionIds: ['session-gone'] }])
  const deletion = await archive.deleteSessions({
    registry: deleteRegistry,
    now: () => 1,
    // `session-live` differs from `session-gone` only in that its agent is
    // actually running. Both are `idle`-capable Sessions the process knows
    // about, which is why the status — not the mere presence of a registry
    // entry — is what decides.
    agents: { get: (id) => (id === 'session-live' ? { id, status: 'running' } : { id, status: 'idle' }) },
    cache: { requireTable: () => ({ delete: (id) => cacheDeletes.push(id) }) },
  }, ['session-gone', 'session-live'])
  check('a running session is skipped, not deleted', JSON.stringify(deletion.skipped) === JSON.stringify([{ id: 'session-live', reason: 'live' }]), JSON.stringify(deletion))
  // The bug this replaced: an idle agent's session was refused because
  // `sessions.get` had an entry for it — which hydration alone creates.
  const idleDeletion = await archive.deleteSessions({
    registry: fakeRegistry(['session-idle'], [{ id: 'w1', sessionIds: ['session-idle'] }]),
    now: () => 1,
    agents: { get: () => ({ id: 'session-idle', status: 'idle' }) },
  }, ['session-idle'])
  check('an idle agent does not block a delete', idleDeletion.deleted.join() === 'session-idle' && idleDeletion.skipped.length === 0, JSON.stringify(idleDeletion))
  const noAgents = await archive.deleteSessions({
    registry: fakeRegistry(['session-x'], []),
    now: () => 1,
    agents: undefined,
  }, ['session-x'])
  check('a composition with no agents service still deletes', noAgents.deleted.join() === 'session-x', JSON.stringify(noAgents))
  const halfDisposed = await archive.deleteSessions({
    registry: fakeRegistry(['session-y'], []),
    now: () => 1,
    agents: { get: () => { throw new Error('disposed') } },
  }, ['session-y'])
  check('a throwing agents registry fails open, not closed', halfDisposed.deleted.join() === 'session-y', JSON.stringify(halfDisposed))
  check('a skipped session stays archived', deleteRegistry.archivedSessionIds.includes('session-live'), JSON.stringify(deleteRegistry.state))
  check('the log directory is removed', !existsSync(sessionDir))
  check('the cache row is dropped', cacheDeletes.includes('session-gone'), JSON.stringify(cacheDeletes))
  check('the workspace membership is dropped', deleteRegistry.detached.includes('session-gone'), JSON.stringify(deleteRegistry.detached))
  check('the deletion is reported', deletion.deleted.join() === 'session-gone', JSON.stringify(deletion))
  // The tombstone: core cannot say "this Session is gone", so the only way to
  // keep it out of the browser's Ungrouped bucket is to leave it archived.
  check('a deleted session keeps its archive entry', deleteRegistry.archivedSessionIds.includes('session-gone'), JSON.stringify(deleteRegistry.state))
  // A second session that still has a log, so the listing has something to show
  // and the tombstone has something to be told apart from.
  const keptDir = join(dshHomePath('sessions'), '--tmp-project--', 'session-kept')
  mkdirSync(keptDir, { recursive: true })
  writeFileSync(join(keptDir, 'session.v3.jsonl.zstd'), 'log')
  const goneSet = await archive.tombstonedIds({}, ['session-gone', 'session-kept'])
  check('a log-less id is tombstoned', goneSet.has('session-gone'), JSON.stringify([...goneSet]))
  check('an id with a log is not tombstoned', !goneSet.has('session-kept'), JSON.stringify([...goneSet]))
  const listingDeps = (ids) => ({
    registry: fakeRegistry(ids),
    now: () => 1,
    persistence: { list: async () => [{ header: { id: 'session-kept', cwd: '/tmp/project', createdAt: 42 } }] },
    cache: { cachedSnapshot: () => ({ values: { title: 'a title from the cache' } }) },
  })
  const archivedList = await archive.listArchived(listingDeps(['session-kept', 'session-gone']))
  check('the listing reports the archived session', archivedList.ok === true && archivedList.records.length === 1, JSON.stringify(archivedList))
  check('a session that still has a log is listed', archivedList.records.some((row) => row.id === 'session-kept'), JSON.stringify(archivedList.records.map((r) => r.id)))
  check('a deleted session is tombstoned out of the listing', !archivedList.records.some((row) => row.id === 'session-gone'), JSON.stringify(archivedList.records.map((r) => r.id)))
  check('the tombstone is not counted in the total either', archivedList.total === 1, String(archivedList.total))
  check('the listing carries the cached title', archivedList.records[0].title === 'a title from the cache', JSON.stringify(archivedList.records[0]))
  check('the listing carries the header date and cwd', archivedList.records[0].createdAt === 42 && archivedList.records[0].cwd === '/tmp/project', JSON.stringify(archivedList.records[0]))
  // The last write is read off the log directory, not off a projection: the
  // directory's newest mtime, which is the same scan that answers the size.
  check('the listing dates the row by its newest log write', typeof archivedList.records[0].updatedAt === 'number' && archivedList.records[0].updatedAt > 0, JSON.stringify(archivedList.records[0]))
  check('the last write is the newest entry, not the directory itself', archivedList.records[0].updatedAt === statSync(join(keptDir, 'session.v3.jsonl.zstd')).mtimeMs, String(archivedList.records[0].updatedAt))
  const untitled = await archive.listArchived({
    registry: fakeRegistry(['session-kept']),
    now: () => 1,
    persistence: { list: async () => [{ header: { id: 'session-kept', cwd: '/tmp/project', createdAt: 42 } }] },
  })
  check('a session with no projection source still lists, without a title', untitled.records[0].title === undefined, JSON.stringify(untitled.records[0]))
  const noRegistryList = await archive.listArchived({ registry: undefined, now: () => 1 })
  check('listing without a registry is explained', noRegistryList.ok === false && noRegistryList.error === 'no-registry', JSON.stringify(noRegistryList))

} finally {
  rmSync(scratch, { recursive: true, force: true })
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)