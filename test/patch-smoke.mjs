/**
 * gord-dsh-worktree sidebar-patch smoke test.
 *
 * The sidebar patch is the one piece of this plugin that edits a file it does
 * not own, which makes it the one piece that can stop matching after a DSH
 * upgrade — silently, since the plugin still loads and only the nesting goes
 * missing. So this drives the tool against the workspace bundle that is
 * actually installed:
 *
 *   • every behaviour must be recognized as patched, original, or native —
 *     never as an unknown build;
 *   • applying must be idempotent, keep the bundle parseable, and be reversible;
 *   • the patched ownership rule must answer the way the sidebar needs it to.
 *
 * Nothing here writes to the installed copy: the tool is pointed at a copy in a
 * temp directory, and the installed file is compared before and after to prove
 * it.
 *
 *   node test/patch-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const tool = fileURLToPath(new URL('../tools/patch-sidebar.mjs', import.meta.url))

/** Run the patch tool and hand back its result without throwing on a non-zero exit. */
function run(args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
}

/** The status word each behaviour line starts with. */
const statusesOf = (stdout) =>
  stdout
    .split('\n')
    .filter((line) => /^(patched|original|native|unknown)\s/.test(line))
    .map((line) => line.split(/\s+/)[0])

const targetOf = (stdout) => stdout.trim().split('\n').at(-1)

process.stdout.write('patch tool: the installed bundle\n')

const located = run(['--check'])
if (located.status === 1 && located.stderr.includes('could not find')) {
  process.stdout.write('  skip no installed dsh workspace bundle was found\n')
  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
  process.exit(0)
}

const installed = targetOf(located.stdout)
check('the tool finds the installed bundle', existsSync(installed), `${installed} :: ${located.stderr.trim()}`)
const installedStatuses = statusesOf(located.stdout)
check('every behaviour is recognized', installedStatuses.length >= 2 && !installedStatuses.includes('unknown'), JSON.stringify(installedStatuses))
check('--check does not write', located.status === 0 || located.status === 2, `exit ${located.status}`)

const original = readFileSync(installed, 'utf8')
const work = mkdtempSync(join(tmpdir(), 'gord-worktree-patch-'))
const copy = join(work, 'client.js')
copyFileSync(installed, copy)

try {
  process.stdout.write('\npatch tool: patching a copy\n')

  const applied = run(['--target', copy])
  check('applying succeeds', applied.status === 0, `${applied.status} ${applied.stderr.trim()}`)
  const patched = readFileSync(copy, 'utf8')
  check('applying changes the file', patched !== original)
  check('applying leaves a backup', existsSync(`${copy}.orig`))

  const syntax = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  check('the patched bundle still parses', syntax.status === 0, syntax.stderr.trim())

  const recheck = run(['--check', '--target', copy])
  check('a patched file checks clean', recheck.status === 0, `exit ${recheck.status} ${recheck.stdout.trim()}`)
  check(
    'nothing is left unpatched in it',
    statusesOf(recheck.stdout).every((status) => status === 'patched' || status === 'native'),
    JSON.stringify(statusesOf(recheck.stdout)),
  )

  const again = run(['--target', copy])
  check('applying twice is a no-op', again.status === 0 && readFileSync(copy, 'utf8') === patched, again.stdout.trim())

  const reverted = run(['--revert', '--target', copy])
  check('reverting succeeds', reverted.status === 0, reverted.stderr.trim())
  check('reverting restores the shipped file', readFileSync(copy, 'utf8') === original)

  process.stdout.write('\npatch tool: a build it does not know\n')
  const stranger = join(work, 'stranger.js')
  writeFileSync(stranger, '// a browser bundle from some other build\nvar x = 1\n')
  const strangerCheck = run(['--check', '--target', stranger])
  check('an unknown bundle is refused by --check', strangerCheck.status === 1, `exit ${strangerCheck.status}`)
  check('the refusal says it needs updating', strangerCheck.stderr.includes('needs updating'), strangerCheck.stderr.trim())
  const strangerApply = run(['--target', stranger])
  check('an unknown bundle is refused by apply', strangerApply.status === 1, `exit ${strangerApply.status}`)
  check('an unknown bundle is left untouched', readFileSync(stranger, 'utf8') === '// a browser bundle from some other build\nvar x = 1\n')
  check('a refused patch writes no backup', !existsSync(`${stranger}.orig`))

  // The patched copy again, for the behavioural half.
  run(['--target', copy])
  const treePatched = readFileSync(copy, 'utf8').includes('gord-dsh-worktree: nested worktree grouping (workspace tree)')
  if (treePatched) {
    process.stdout.write('\npatch tool: the patched ownership rule\n')

    // The function is standalone apart from `folderPath`, so it can be lifted
    // out of the bundle and driven directly.
    const start = readFileSync(copy, 'utf8').indexOf('function owningParentFolder(path, parents) {')
    const body = readFileSync(copy, 'utf8').slice(start)
    let depth = 0
    let end = 0
    for (let index = body.indexOf('{'); index < body.length; index++) {
      if (body[index] === '{') depth++
      else if (body[index] === '}') {
        depth--
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }
    const source = body.slice(0, end)
    // eslint-disable-next-line no-new-func -- lifting one pure function out of a bundle
    const owningParentFolder = new Function('folderPath', `${source}\nreturn owningParentFolder`)((value) => value.replace(/\/+$/, ''))

    const withParents = (map, parents, path, run) => {
      const previous = globalThis.localStorage
      globalThis.localStorage = { getItem: (key) => (key === 'gord-worktree:parents' ? map : null) }
      try {
        return run()
      } finally {
        if (previous === undefined) delete globalThis.localStorage
        else globalThis.localStorage = previous
      }
    }

    const worktree = '/Users/me/.dsh/worktree/ab12'
    const project = '/Users/me/code/app'
    const other = '/Users/me/code/other'
    const declared = JSON.stringify({ [worktree]: project })

    check(
      'a worktree inside its project folds by path, with no map at all',
      withParents(null, [project, other], `${project}/layer/one`, () => owningParentFolder(`${project}/layer/one`, [project, other])) === project,
    )
    check(
      'the nearest ancestor wins over a farther one',
      withParents(null, [project, `${project}/layer`], `${project}/layer/one`, () => owningParentFolder(`${project}/layer/one`, [project, `${project}/layer`])) === `${project}/layer`,
    )
    check(
      'a worktree kept outside its project folds by the published map',
      withParents(declared, [project, other], worktree, () => owningParentFolder(worktree, [project, other])) === project,
    )
    check(
      'a map entry that is not a registered workspace is ignored',
      withParents(declared, [other], worktree, () => owningParentFolder(worktree, [other])) === undefined,
    )
    check(
      'an unmapped outside worktree stays its own group',
      withParents(JSON.stringify({}), [project, other], worktree, () => owningParentFolder(worktree, [project, other])) === undefined,
    )
    check(
      'a broken map folds nothing rather than throwing',
      withParents('not json', [project, other], worktree, () => owningParentFolder(worktree, [project, other])) === undefined,
    )
    check(
      'a session with no localStorage at all still resolves',
      withParents(null, [project, other], worktree, () => {
        delete globalThis.localStorage
        return owningParentFolder(worktree, [project, other])
      }) === undefined,
    )
    check(
      'a project never folds into itself',
      withParents(JSON.stringify({ [project]: project }), [project], project, () => owningParentFolder(project, [project])) === undefined,
    )
  } else {
    process.stdout.write('\npatch tool: this build keeps its own grouping\n')
    check('the legacy grouping patch is what was applied instead', readFileSync(copy, 'utf8').includes('gord-dsh-worktree: nested worktree grouping'))
  }

  check('the installed bundle was never written', readFileSync(installed, 'utf8') === original)
} finally {
  rmSync(work, { recursive: true, force: true })
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
