/**
 * gord-dsh-worktree host-half smoke test — runs the operation layer against a real
 * throwaway repository. Executed with plain `node` so it can import the same
 * ESM modules the plugin ships; no test framework is required to prove the
 * guards behave.
 *
 *   node test/host-smoke.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as service from '../lib/service.js'
import { defaultBranchName, defaultWorktreeParent, parseWorktreeList, slugifyBranch } from '../lib/worktree.js'

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
  check('defaultBranchName derives worktree/<base>', defaultBranchName('main') === 'worktree/main', defaultBranchName('main'))
  check('defaultBranchName strips origin/', defaultBranchName('origin/feature/x') === 'worktree/feature/x', defaultBranchName('origin/feature/x'))
  check('slugifyBranch flattens slashes', slugifyBranch('worktree/feature/x') === 'worktree-feature-x', slugifyBranch('worktree/feature/x'))
  check('defaultWorktreeParent is a sibling', defaultWorktreeParent(repo) === join(scratch, 'app-worktrees'), defaultWorktreeParent(repo))
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
  check('create used the sibling default parent', created.path === join(scratch, 'app-worktrees', 'worktree-feature-a'), created.path)
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
  plugin.apply(stubCtx, { defaultParent: '', adoptWorkspace: true })
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
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)