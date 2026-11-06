/** Native DSH directory changes must reach tools and branch metadata. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gord-directory-')))
process.env.DSH_HOME = join(scratch, 'home')
process.env.GORD_WORKTREE_NO_BUNDLE_PATCH = '1'
const plugin = await import('../lib/index.js')
const archive = await import('../lib/archive.js')
const root = new Context()
const tools = new Map()
const routes = new Map()
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate) }
let checks = 0
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label)
  checks++
  process.stdout.write(`ok   ${label}\n`)
}
try {
  const repo = join(scratch, 'repo')
  const feature = join(scratch, 'feature')
  git(scratch, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.name', 'compatibility')
  git(repo, 'config', 'user.email', 'compatibility@example.test')
  writeFileSync(join(repo, 'a.txt'), 'main\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'main')
  git(repo, 'worktree', 'add', '-b', 'feature', feature)
  writeFileSync(join(feature, 'a.txt'), 'feature\n')
  git(feature, 'commit', '-am', 'feature')
  let session = { header: { id: 'directory-test', cwd: repo } }
  root.plugin({ apply(ctx) {
    ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
    ctx.provide('sessions', { get: (id) => id === session.header.id ? session : undefined })
    ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => {} } })
  } })
  root.plugin(plugin, { defaultParent: '', allowedOrigins: [] })
  await flush()
  const exec = () => ({ agent: { session, ctx: root, inject() {} }, signal: new AbortController().signal })
  check('a host without workingDirectory uses the original session directory', (await tools.get('worktree_list').execute({}, exec())).branch, 'main')

  let NativeDirectory
  try { NativeDirectory = (await import('@deepseek-ai/dsh-working-directory')).default }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error }
  if (NativeDirectory) {
    const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
    const { Session } = await import('@deepseek-ai/dsh-session')
    root.plugin(Projections)
    root.plugin({ apply(ctx) {
      ctx.provide('fs', {
        resolve: async (path) => path,
        stat: async (path) => { try { return { type: statSync(path).isDirectory() ? 'directory' : 'file' } } catch (error) { if (error.code !== 'ENOENT') throw error } },
        processPath: (path) => path,
      })
      ctx.provide('systemPrompt', { context: () => () => {}, getContextOrder: () => 0 })
    } })
    const mounted = root.plugin(NativeDirectory, { defaultDirectory: repo })
    await flush()
    session = Session.create('directory-test', [], { version: 4, id: 'directory-test', cwd: repo, createdAt: 1, isSeeded: false })
    const directory = root.get('workingDirectory')
    await directory.set(exec().agent, feature)
    check('native directory changes keep the original header intact', session.header.cwd, repo)
    check('tool listing follows the real native directory service', (await tools.get('worktree_list').execute({}, exec())).branch, 'feature')
    check('relative overrides resolve from the effective directory', (await tools.get('worktree_list').execute({ workdir: '.' }, exec())).branch, 'feature')
    check('an absolute override selects the requested checkout', (await tools.get('worktree_list').execute({ repo }, exec())).branch, 'main')
    const ensure = directory.ensure
    try {
      directory.ensure = async () => { throw new Error('directory lookup failed') }
      await assert.rejects(tools.get('worktree_list').execute({}, exec()), /directory lookup failed/)
      check('failed native resolution cannot silently target the original project', (await tools.get('worktree_list').execute({ workdir: repo }, exec())).branch, 'main')
    } finally { directory.ensure = ensure }
    check('status follows the changed checkout', (await tools.get('worktree_status').execute({}, exec())).branch, 'feature')
    const created = await tools.get('worktree_create').execute({ branch: 'from-feature' }, exec())
    check('new checkouts start from the effective directory HEAD', git(created.path, 'rev-parse', 'HEAD'), git(feature, 'rev-parse', 'HEAD'))
    check('live metadata uses the native directory projection', await archive.sessionWorkingDirectory({ sessions: root.get('sessions'), workingDirectory: directory }, session.header.id), feature)
    await archive.rememberSessionWorktree(session.header.id, created.path)
    await directory.set(exec().agent, repo)
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: session.header.id, dir: feature }))])
    Object.assign(req, { method: 'POST', url: '/gord-dsh-worktree/api?action=branch', headers: {}, socket: { remoteAddress: '127.0.0.1' } })
    let response
    await routes.get('/gord-dsh-worktree/api')(req, { writeHead() {}, end(text) { response = JSON.parse(text) } })
    check('returning to the project supersedes old browser and plugin worktree records', response.branch, 'main')
    await directory.set(exec().agent, feature)
    git(repo, 'worktree', 'remove', feature)
    check('a removed current directory uses the native recovery to the original project', (await tools.get('worktree_list').execute({}, exec())).branch, 'main')
    await mounted.dispose()
    await flush()
    check('unloading the optional directory service restores the legacy fallback', (await tools.get('worktree_list').execute({}, exec())).branch, 'main')
  } else {
    process.stdout.write('skip native directory integration: this older DSH has no working-directory package\n')
  }
  const cold = {
    persistence: { list: async () => [{ header: { id: 'cold', cwd: repo } }] },
    cache: { cachedSnapshot(header, keys) { assert.equal(header.id, 'cold'); assert.deepEqual(keys, ['workingDirectory']); return { values: { workingDirectory: feature } } } },
  }
  check('cold metadata reads only the selected cached directory without hydrating a session', await archive.sessionCwd(cold, 'cold'), feature)
  process.stdout.write(`\n${checks}/${checks} directory checks passed\n`)
} finally {
  await root.fiber.dispose()
  rmSync(scratch, { recursive: true, force: true })
}
