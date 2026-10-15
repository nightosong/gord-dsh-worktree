/** Regression coverage for data-loss, isolation and stale-state findings. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { createServer, request } from 'node:http'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gord-regressions-')))
process.env.DSH_HOME = join(scratch, 'home')
process.env.GORD_WORKTREE_NO_BUNDLE_PATCH = '1'
const service = await import('../lib/service.js')
const archive = await import('../lib/archive.js')
const plugin = await import('../lib/index.js')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let server
let groups = 0
const passed = (name) => { groups += 1; process.stdout.write(`ok   ${name}\n`) }

try {
  const repo = join(scratch, 'app')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'regression')
  git(repo, 'config', 'user.email', 'regression@example.test')
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')

  const routes = new Map()
  const tools = new Map()
  let state = { initialized: true, workspaceIds: [], archivedSessionIds: [] }
  let queue = Promise.resolve()
  const workspaceRows = []
  let workspaceDeleteFailure = ''
  const registry = {
    get archivedSessionIds() { return state.archivedSessionIds },
    requireState: () => state,
    async setState(next) { state = next },
    enqueueOperation(operation) {
      const pending = queue.then(operation)
      queue = pending.catch(() => {})
      return pending
    },
    list: () => workspaceRows,
    async delete(id) {
      if (workspaceDeleteFailure) throw new Error(workspaceDeleteFailure)
      const index = workspaceRows.findIndex((row) => row.id === id)
      if (index >= 0) workspaceRows.splice(index, 1)
    },
    async create(path) {
      return workspaceRows.find((row) => row.path === path)
    },
  }
  // Inject the registry into the route, without starting unrelated load-time
  // archive maintenance while these fixtures are being created.
  let registryInjections = 0
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    effect: (callback) => callback(), get: () => undefined, on: () => {},
    workspaceRegistry: registry,
    webServer: { port: 0, register(route) { routes.set(route.path, route.handler); return () => {} } },
    inject(names, callback) {
      if (names.includes('workspaceRegistry') && ++registryInjections > 1) return
      if (names.every((name) => ctx[name] !== undefined)) callback(ctx)
    },
  }
  plugin.apply(ctx, { defaultParent: '', allowedOrigins: ['https://proxy.example.test', 'http://dsh.example.test'] })
  const handler = routes.get('/gord-dsh-worktree/api')
  async function api(action, body, headers = {}, address = '127.0.0.1') {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.url = `/gord-dsh-worktree/api?action=${action}`
    req.headers = headers
    req.socket = { remoteAddress: address }
    let response
    await handler(req, { writeHead() {}, end(text) { response = JSON.parse(text) } })
    return response
  }
  const exec = (id) => ({ agent: { session: { header: { id, cwd: repo } } } })

  // Commit in both checkouts. Neither HEAD nor index may move with the other.
  const original = git(repo, 'rev-parse', 'HEAD')
  const copy = await tools.get('worktree_create').execute({}, exec('session-A'))
  assert.match(copy.branch, /^worktree\/[0-9a-f]{8}$/)
  assert.equal(copy.createdBranch, true)
  writeFileSync(join(copy.path, 'a.txt'), 'child\n')
  git(copy.path, 'add', 'a.txt')
  git(copy.path, 'commit', '-m', 'child change')
  const childHead = git(copy.path, 'rev-parse', 'HEAD')
  assert.equal(git(repo, 'rev-parse', 'HEAD'), original)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  writeFileSync(join(repo, 'other.txt'), 'other\n')
  git(repo, 'add', 'other.txt')
  git(repo, 'commit', '-m', 'unrelated main change')
  assert.equal(git(copy.path, 'rev-parse', 'HEAD'), childHead)
  assert.equal(git(copy.path, 'show', 'HEAD:a.txt'), 'child')
  assert.equal(git(copy.path, 'status', '--porcelain'), '')
  assert.equal((await service.createWorktree({ dir: repo, branch: 'main', force: true })).ok, false)
  passed('default worktrees isolate commits; force cannot duplicate a checked-out branch')

  git(repo, 'checkout', '--detach')
  const detachedHead = git(repo, 'rev-parse', 'HEAD')
  const detached = await service.createWorktree({ dir: repo })
  assert.equal(detached.ok, true)
  assert.equal(git(detached.path, 'rev-parse', 'HEAD'), detachedHead)
  assert.match(detached.branch, /^worktree\//)
  git(repo, 'checkout', 'main')
  passed('detached HEAD creates an independent branch from the correct commit')

  const ignored = await service.createWorktree({ dir: repo, branch: 'ignored-check' })
  const secret = join(ignored.path, 'secret.env')
  writeFileSync(secret, 'scratch only\n')
  const dirtyRows = await service.describeRepository(repo, undefined, { dirty: true })
  assert.equal(dirtyRows.worktrees.find((row) => row.path === ignored.path).dirty, true)
  assert.equal((await service.removeWorktree({ dir: repo, path: ignored.path })).error, 'dirty')
  assert.equal(readFileSync(secret, 'utf8'), 'scratch only\n')
  assert.equal((await service.removeWorktree({ dir: repo, path: ignored.path, force: true })).ok, true)
  assert.equal(existsSync(secret), false)
  passed('ignored files require explicit force and appear in deletion warnings')

  writeFileSync(join(copy.path, 'pending.txt'), 'pending\n')
  for (const selector of [copy.branch, basename(copy.path), relative(repo, copy.path), copy.path]) {
    const result = await tools.get('worktree_status').execute({ path: selector }, exec('session-A'))
    assert.equal(result.path, copy.path)
    assert.equal(result.dirty, true)
  }
  await assert.rejects(tools.get('worktree_status').execute({ path: 'no-such-worktree' }, exec('session-A')), /no worktree matches/)
  passed('status resolves branch, directory, relative and absolute selectors; unknown selectors fail')

  const before = await api('list', { dir: repo })
  const another = await tools.get('worktree_create').execute({}, exec('session-C'))
  git(repo, 'branch', 'external-branch')
  writeFileSync(join(repo, 'pending-main.txt'), 'pending\n')
  const after = await api('list', { dir: repo })
  assert.equal(after.worktrees.length, before.worktrees.length + 1)
  assert.equal(after.branches.includes('external-branch'), true)
  assert.equal(after.dirty, true)
  assert.equal(after.worktrees.some((row) => row.path === another.path), true)
  passed('list refresh sees Agent-created worktrees and external git/filesystem changes')

  assert.equal(await archive.sessionWorktree(repo, 'session-A'), copy.path)
  assert.equal(await archive.sessionWorktree(repo, 'session-B'), '')
  await Promise.all([
    archive.rememberSessionWorktree('session-A', copy.path),
    archive.rememberSessionWorktree('session-B', detached.path),
  ])
  assert.equal(await archive.sessionWorktree(repo, 'session-A'), copy.path)
  assert.equal(await archive.sessionWorktree(repo, 'session-B'), detached.path)
  await Promise.all([
    archive.sessionWorktree(repo, 'session-race'),
    archive.rememberSessionWorktree('session-race', copy.path),
  ])
  assert.equal(await archive.sessionWorktree(repo, 'session-race'), copy.path)
  assert.equal(archive.parseSessionWorktreeRecord(JSON.stringify({ version: 1, worktrees: { [repo]: copy.path } })), undefined)
  passed('same-directory sessions keep distinct records, including concurrent writes and legacy-cache invalidation')

  // Removing a Git checkout must retire every registration of that exact
  // checkout, including a legacy symlink, while leaving session logs intact.
  const removable = await service.createWorktree({ dir: repo, branch: 'sidebar-removal' })
  const alias = join(scratch, 'legacy-alias')
  symlinkSync(removable.path, alias)
  const log = join(process.env.DSH_HOME, 'sessions', 'project', 'prior-session', 'log')
  mkdirSync(join(log, '..'), { recursive: true })
  writeFileSync(log, 'history remains\n')
  workspaceRows.push(
    { id: 'main-workspace', path: repo, sessionIds: [] },
    { id: 'checkout-workspace', path: removable.path, sessionIds: ['prior-session'] },
    { id: 'legacy-workspace', path: alias, sessionIds: ['prior-session'] },
  )
  const adoptedWorkspace = await api('adopt', { path: removable.path })
  assert.deepEqual(adoptedWorkspace.workspace.sessionIds, ['prior-session'])
  writeFileSync(join(removable.path, 'pending.txt'), 'pending\n')
  assert.equal((await api('remove', { dir: repo, path: removable.path })).error, 'dirty')
  assert.equal(workspaceRows.length, 3)
  const removedCheckout = await api('remove', { dir: repo, path: removable.path, force: true })
  assert.equal(removedCheckout.ok, true)
  assert.deepEqual(removedCheckout.workspaceCleanup.removed.map((row) => row.workspaceId), ['checkout-workspace', 'legacy-workspace'])
  assert.deepEqual(removedCheckout.workspaceCleanup.failed, [])
  assert.deepEqual(workspaceRows.map((row) => row.id), ['main-workspace'])
  assert.equal(readFileSync(log, 'utf8'), 'history remains\n')
  assert.equal(existsSync(repo), true)

  const toolCheckout = await service.createWorktree({ dir: repo, branch: 'tool-sidebar-removal' })
  workspaceRows.push({ id: 'tool-workspace', path: toolCheckout.path, sessionIds: [] })
  await tools.get('worktree_remove').execute({ path: toolCheckout.path }, exec('session-A'))
  assert.equal(workspaceRows.some((row) => row.id === 'tool-workspace'), false)

  const partial = await service.createWorktree({ dir: repo, branch: 'sidebar-partial-removal' })
  workspaceRows.push({ id: 'partial-workspace', path: partial.path, sessionIds: [] })
  workspaceDeleteFailure = 'registry unavailable'
  const partialRemoval = await api('remove', { dir: repo, path: partial.path })
  assert.equal(partialRemoval.ok, true)
  assert.equal(existsSync(partial.path), false)
  assert.equal(partialRemoval.workspaceCleanup.failed[0].message, 'registry unavailable')
  assert.equal(workspaceRows.some((row) => row.id === 'partial-workspace'), true)
  workspaceDeleteFailure = ''
  await registry.delete('partial-workspace')
  passed('HTTP and Agent removal retire exact/aliased workspace records, retain history and report cleanup failures')

  // Reproduce registrations left by the old deletion path before it knew
  // about workspace cleanup. The parent container is intentionally retained.
  const staleEmpty = await service.createWorktree({ dir: repo, branch: 'old-empty-registration' })
  const staleHistory = await service.createWorktree({ dir: repo, branch: 'old-history-registration' })
  const validCheckout = await service.createWorktree({ dir: repo, branch: 'valid-registration' })
  const missingButTracked = await service.createWorktree({ dir: repo, branch: 'tracked-missing-registration' })
  await service.removeWorktree({ dir: repo, path: staleEmpty.path })
  await service.removeWorktree({ dir: repo, path: staleHistory.path })
  rmSync(missingButTracked.path, { recursive: true, force: true })
  const mainRecord = workspaceRows.find((row) => row.id === 'main-workspace')
  mainRecord.title = 'app · app'
  mainRecord.setTitle = async (title) => { mainRecord.title = title }
  const offlineRoot = join(scratch, 'offline-project')
  workspaceRows.push(
    { id: 'old-empty', path: staleEmpty.path, sessionIds: [] },
    { id: 'old-history', path: staleHistory.path, sessionIds: ['prior-session'] },
    { id: 'valid-checkout', path: validCheckout.path, sessionIds: [] },
    { id: 'missing-but-tracked', path: missingButTracked.path, sessionIds: [] },
    { id: 'offline-project', path: join(offlineRoot, '.dsh/worktrees/aaaabbbb'), sessionIds: [] },
    { id: 'custom-location', path: join(scratch, 'custom/aaaabbbb'), sessionIds: [] },
    { id: 'custom-name', path: join(repo, '.dsh/worktrees/custom-name'), sessionIds: [] },
  )
  const migration = await plugin.reconcileWorktreeWorkspaces(registry)
  assert.deepEqual(migration.removed.map((row) => row.workspaceId), ['old-empty', 'old-history'])
  assert.deepEqual(migration.renamed, [{ workspaceId: 'main-workspace', title: 'app' }])
  assert.deepEqual(migration.failed, [])
  assert.equal(readFileSync(log, 'utf8'), 'history remains\n')
  assert.equal(existsSync(join(repo, '.dsh/worktrees')), true)
  for (const id of ['valid-checkout', 'missing-but-tracked', 'offline-project', 'custom-location', 'custom-name']) {
    assert.equal(workspaceRows.some((row) => row.id === id), true)
  }
  const again = await plugin.reconcileWorktreeWorkspaces(registry)
  assert.deepEqual(again, { removed: [], renamed: [], failed: [] })
  mainRecord.title = 'my custom title'
  await plugin.reconcileWorktreeWorkspaces(registry)
  assert.equal(mainRecord.title, 'my custom title')

  workspaceRows.push({ id: 'retry-migration', path: staleEmpty.path, sessionIds: [] })
  workspaceDeleteFailure = 'registry unavailable'
  const refusedMigration = await plugin.reconcileWorktreeWorkspaces(registry)
  assert.equal(refusedMigration.failed[0].workspaceId, 'retry-migration')
  assert.equal(workspaceRows.some((row) => row.id === 'retry-migration'), true)
  workspaceDeleteFailure = ''
  const cancelled = new AbortController()
  cancelled.abort()
  await plugin.reconcileWorktreeWorkspaces(registry, cancelled.signal)
  assert.equal(workspaceRows.some((row) => row.id === 'retry-migration'), true)
  assert.equal((await plugin.reconcileWorktreeWorkspaces(registry)).removed[0].workspaceId, 'retry-migration')

  // Prove that a restart actually invokes the migration, without writing the
  // storage file behind a running registry's in-memory state.
  workspaceRows.push({ id: 'startup-migration', path: staleHistory.path, sessionIds: ['prior-session'] })
  let migratedAtLoad
  const loaded = new Promise((resolve) => { migratedAtLoad = resolve })
  const deleteWorkspace = registry.delete.bind(registry)
  registry.delete = async (id) => { await deleteWorkspace(id); if (id === 'startup-migration') migratedAtLoad() }
  const loadCtx = { ...ctx, inject(names, callback) { if (names.every((name) => loadCtx[name] !== undefined)) callback(loadCtx) } }
  plugin.apply(loadCtx, { defaultParent: '' })
  let timeout
  try {
    await Promise.race([loaded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('startup migration did not run')), 3000) })])
  } finally { clearTimeout(timeout) }
  assert.equal(workspaceRows.some((row) => row.id === 'startup-migration'), false)
  assert.equal(readFileSync(log, 'utf8'), 'history remains\n')
  registry.delete = deleteWorkspace
  passed('restart migration retires historical orphan registrations and duplicate titles while preserving live/tracked/offline/custom workspaces and all logs')

  const sessions = join(process.env.DSH_HOME, 'sessions', 'project')
  const active = join(sessions, 'active-session')
  const archived = join(sessions, 'archived-session')
  const restored = join(sessions, 'restored-session')
  const outside = join(process.env.DSH_HOME, 'outside-sessions')
  for (const path of [active, archived, restored, outside]) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'sentinel'), 'scratch only\n')
  }
  state.archivedSessionIds = ['archived-session', 'restored-session']
  for (const id of ['../../outside-sessions', '..', '../project', '/tmp', 'bad\\path']) {
    assert.equal((await api('deleteArchived', { ids: [id] })).error, 'bad-ids')
    assert.equal(await archive.sessionDirectory(id), undefined)
  }
  // Defend direct service callers too, including malformed ids already on disk.
  state.archivedSessionIds.push('../../outside-sessions')
  assert.equal((await archive.deleteSessions({ registry }, ['../../outside-sessions'])).skipped[0].reason, 'bad-id')
  assert.equal((await api('deleteArchived', { ids: ['active-session'] })).skipped[0].reason, 'not-archived')
  const unarchive = archive.unarchiveSessions({ registry }, ['restored-session'])
  const staleDelete = archive.deleteSessions({ registry }, ['restored-session'])
  await unarchive
  assert.equal((await staleDelete).skipped[0].reason, 'not-archived')
  assert.equal(existsSync(restored), true)
  symlinkSync(outside, join(sessions, 'linked-session'))
  state.archivedSessionIds.push('linked-session')
  assert.equal(await archive.sessionDirectory('linked-session'), undefined)
  await api('deleteArchived', { ids: ['linked-session'] })
  assert.equal(existsSync(outside), true)
  const receipt = await api('deleteArchived', { ids: ['archived-session', 'archived-session'] })
  assert.deepEqual(receipt.deleted, ['archived-session'])
  assert.equal(existsSync(archived), false)
  assert.equal(existsSync(active), true)
  assert.equal(existsSync(outside), true)
  passed('archive deletion rejects traversal, active/restored sessions and symlink escapes; valid archived deletion works')

  assert.equal((await api('worktreeRows', {}, { origin: 'http://localhost:3456', host: 'localhost:3456' })).ok, true)
  assert.equal((await api('worktreeRows', {}, { origin: 'http://localhost', host: 'localhost:3456' })).error, 'forbidden')
  assert.equal((await api('worktreeRows', {}, { origin: 'http://other.test', host: 'localhost:3456' })).error, 'forbidden')
  assert.equal((await api('worktreeRows', {}, { origin: 'http://rebind.test:3456', host: 'rebind.test:3456' })).error, 'forbidden')
  assert.equal((await api('worktreeRows', {}, { origin: 'null', host: 'localhost:3456' })).error, 'forbidden')
  assert.equal((await api('worktreeRows', {}, {}, '203.0.113.10')).error, 'forbidden')
  assert.equal((await api('worktreeRows', {}, {}, '::ffff:127.0.0.1')).ok, true)
  assert.equal((await api('worktreeRows', {}, { origin: 'https://proxy.example.test', host: 'localhost:3456' })).ok, true)
  passed('origin checks enforce host/port, reject remote originless calls and allow configured proxies')

  // Exercise the actual HTTP boundary as well as the injected request fixtures.
  server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  async function httpCall(headers) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/gord-dsh-worktree/api?action=worktreeRows', method: 'POST', headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end('{}')
    })
  }
  assert.equal((await httpCall({})).body.ok, true)
  assert.equal((await httpCall({ host: 'dsh.example.test', origin: 'http://dsh.example.test' })).body.ok, true)
  assert.equal((await httpCall({ origin: 'http://localhost' })).status, 403)
  assert.equal((await httpCall({ origin: 'https://proxy.example.test' })).body.ok, true)
  passed('real HTTP requests support local CLI, remote same-origin and explicit reverse proxies')

  process.stdout.write(`\n${groups}/${groups} regression groups passed\n`)
} finally {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(scratch, { recursive: true, force: true })
}
