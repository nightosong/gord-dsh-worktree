#!/usr/bin/env node
/** Run the suite against an explicitly selected DSH dependency tree. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--modules') {
  process.stderr.write('Usage: npm run test:compat -- --modules /path/to/dsh/node_modules\n')
  process.exit(1)
}
const modules = realpathSync(resolve(args[1]))
const require = createRequire(join(modules, '__compat__.cjs'))
const runtime = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8'))
for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs-search', 'js-yaml', 'semver']) {
  if (!existsSync(join(modules, name, 'package.json'))) throw new Error(`Missing test dependency in selected tree: ${name}`)
}
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'gord-dsh-compat-'))
try {
  for (const name of ['lib', 'test', 'tools', 'package.json', 'cordis.patch.yml']) cpSync(join(root, name), join(scratch, name), { recursive: true })
  symlinkSync(modules, join(scratch, 'node_modules'), 'junction')
  process.stdout.write(`Testing DSH ${runtime.version} from ${modules}\n`)
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
    cwd: scratch,
    env: { ...process.env, GORD_WORKTREE_NO_BUNDLE_PATCH: '1' },
    stdio: 'inherit',
  })
  if (run.error) throw run.error
  process.exitCode = run.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
