#!/usr/bin/env node
/**
 * One behaviour two core tool packages need from a core this plugin does not own:
 * their read-only calls run concurrently with the rest of a step.
 *
 * `dsh-agent-loop` schedules a step's tool calls in parallel only when every
 * call is classified concurrency-safe, and `dsh-tools` treats a tool with no
 * `isConcurrencySafe` as exclusive — which is what `bash`, `glob` and `grep`
 * are in the installed core. Measured on real sessions, `bash` is 81–94% of all
 * tool calls and the model already batches two of them in roughly a third of
 * the steps that call tools; as exclusive calls they still run one after the
 * other, and a batched `read` next to a `bash` waits too. So this adds:
 *
 *   • a read-only classifier for `bash` — `lib/read-only-command.js`, shipped by
 *     this plugin and copied in — that is fail-closed: only a line whose every
 *     `|`/`&&`/`;` segment starts with a command from a small read-only
 *     allowlist, carrying no `>` and no command substitution, is parallel.
 *     Writers, scripts and anything unknown stay exclusive, exactly as before.
 *   • `isConcurrencySafe: () => true` for `glob` and `grep`, which only read.
 *
 * Both packages are needed together to be useful: a step that batches a
 * read-only `bash` command next to a `glob` only overlaps when both sides say
 * yes.
 *
 * Like tools/patch-sidebar.mjs, this edits files it does not own — so it is
 * idempotent, recognizable through `--check`, reversible through `--revert`,
 * and a DSH upgrade (which restores those files) means re-running it. No file
 * is written before every anchor of that file has matched exactly once.
 *
 * Usage:
 *   node tools/patch-concurrency.mjs [--check] [--revert]
 *   node tools/patch-concurrency.mjs --tool-bash <pkg dir> --tool-fs-search <pkg dir>
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLASSIFIER = join(HERE, '..', 'lib', 'read-only-command.js')

const MARK = 'gord-dsh-worktree'

const rows = {
  import: {
    what: 'import the read-only classifier',
    marker: 'from "./read-only-command.js"',
    original: 'import z from "@deepseek-ai/schemastery";\n',
    patched: 'import z from "@deepseek-ai/schemastery";\nimport { isReadOnlyCommand } from "./read-only-command.js";\n',
    already: /from "\.\/read-only-command\.js"/,
  },
  classify: {
    what: 'bash: read-only commands run concurrently',
    marker: `// ${MARK}: read-only commands may run concurrently`,
    original: '\t\treturn defineTool({\n\t\t\tname: "bash",\n',
    patched: `\t\treturn defineTool({\n\t\t\tname: "bash",\n\t\t\t// ${MARK}: read-only commands may run concurrently\n\t\t\tisConcurrencySafe: (args) => isReadOnlyCommand(args?.command),\n`,
    already: /isConcurrencySafe: \(args\) => isReadOnlyCommand\(args\?\.command\)/,
  },
  glob: {
    what: 'glob runs concurrently (a pure read)',
    marker: `// ${MARK}: a glob only reads`,
    original: '\tconst tool = defineTool({\n\t\tname: "glob",\n',
    patched: `\tconst tool = defineTool({\n\t\tname: "glob",\n\t\t// ${MARK}: a glob only reads\n\t\tisConcurrencySafe: () => true,\n`,
    already: /name: "glob",\n\t*isConcurrencySafe: \(\) => true,/,
  },
  grep: {
    what: 'grep runs concurrently (a pure read)',
    marker: `// ${MARK}: a grep only reads`,
    original: '\tconst tool = defineTool({\n\t\tname: "grep",\n',
    patched: `\tconst tool = defineTool({\n\t\tname: "grep",\n\t\t// ${MARK}: a grep only reads\n\t\tisConcurrencySafe: () => true,\n`,
    already: /name: "grep",\n\t*isConcurrencySafe: \(\) => true,/,
  },
}

const TOOLS = [
  {
    key: 'tool-bash',
    package: '@deepseek-ai/dsh-tool-bash',
    file: ['lib', 'index.js'],
    rows: [rows.import, rows.classify],
    classifier: ['lib', 'read-only-command.js'],
  },
  {
    key: 'tool-fs-search',
    package: '@deepseek-ai/dsh-tool-fs-search',
    file: ['lib', 'index.js'],
    rows: [rows.glob, rows.grep],
    classifier: undefined,
  },
]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/**
 * Locate one installed core package.
 *
 * The `dsh` binary is the reliable anchor, exactly as in patch-sidebar.mjs:
 * this plugin lives in a profile, so resolving from here would look in the
 * profile's own node_modules and find nothing. `dsh` is a symlink into the
 * install, and walking up from its real path reaches the core packages.
 *
 * @param tool - the tool descriptor, for its package name and `--<key>` override.
 * @returns the package directory, or undefined when it cannot be found.
 */
function resolvePackage(tool) {
  const explicit = value(`--${tool.key}`)
  if (explicit !== undefined) return explicit
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve(`${tool.package}/package.json`))
  } catch {
    // Not a dependency of this plugin; fall through to the install.
  }
  let bin
  try {
    bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  if (bin === '') return undefined
  const parts = ['node_modules', tool.package]
  let directory = dirname(realpathSync(bin))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, ...parts)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Classify every row of one package without writing anything.
 *
 * `patched` means this patch put the row there; `patched-unmarked` means the
 * effect is present but without this patch's marker — an install that patched
 * the file by hand, or one patched by an earlier version of this tool. Both
 * count as done, so applying stays idempotent either way; only `original` is
 * still to do, and `unknown` means the build moved on and nothing is written.
 *
 * @param tool - the tool descriptor.
 * @returns the inspection, or undefined when the package is missing.
 */
function inspect(tool) {
  const directory = resolvePackage(tool)
  if (directory === undefined) return undefined
  const file = join(directory, ...tool.file)
  if (!existsSync(file)) return undefined
  const source = readFileSync(file, 'utf8')
  const classified = tool.rows.map((row) => ({
    row,
    status: source.includes(row.marker) ? 'patched' : row.already.test(source) ? 'patched-unmarked' : source.includes(row.original) ? 'original' : 'unknown',
  }))
  const classifierTarget = tool.classifier === undefined ? undefined : join(directory, ...tool.classifier)
  const classifier = tool.classifier === undefined ? undefined : { target: classifierTarget, present: existsSync(classifierTarget) }
  return { tool, directory, file, source, rows: classified, classifier, backup: `${file}.orig` }
}

const inspections = TOOLS.map(inspect)
const missing = inspections.filter((entry) => entry === undefined)
if (missing.length > 0) {
  for (const [index, entry] of inspections.entries()) {
    if (entry === undefined) {
      process.stderr.write(`could not find the installed ${TOOLS[index].package}\n`)
      process.stderr.write(`pass --${TOOLS[index].key} <path to the ${TOOLS[index].package} package>\n`)
    }
  }
  process.exit(1)
}

const describe = (entry) => {
  if (entry.status === 'patched') return ' (patched)'
  if (entry.status === 'patched-unmarked') return ' (already present, unmarked)'
  return ''
}

if (flag('--check')) {
  let pending = 0
  let unknown = 0
  for (const entry of inspections) {
    for (const row of entry.rows) {
      if (row.status === 'original') pending += 1
      if (row.status === 'unknown') unknown += 1
      process.stdout.write(`${row.status.padEnd(17)} ${row.row.what}${describe(row)}\n`)
    }
    if (entry.classifier !== undefined) {
      const status = entry.classifier.present ? 'patched' : 'original'
      if (status === 'original') pending += 1
      process.stdout.write(`${status.padEnd(17)} bash: lib/read-only-command.js is installed\n`)
    }
    process.stdout.write(`${entry.file}\n`)
  }
  if (unknown > 0) {
    process.stderr.write('not in the expected shape: this DSH build differs; the patch needs updating rather than forcing\n')
    process.exit(1)
  }
  process.exit(pending === 0 ? 0 : 2)
}

if (flag('--revert')) {
  let reverted = 0
  for (const entry of inspections) {
    const patched = entry.rows.some((row) => row.status !== 'original') || entry.classifier?.present === true
    if (!patched) continue
    if (!existsSync(entry.backup)) {
      process.stderr.write(`no backup at ${entry.backup}; reinstall ${entry.tool.package} to restore it\n`)
      process.exit(1)
    }
    copyFileSync(entry.backup, entry.file)
    if (entry.classifier !== undefined && existsSync(entry.classifier.target)) rmSync(entry.classifier.target)
    process.stdout.write(`reverted ${entry.file}\n`)
    reverted += 1
  }
  if (reverted === 0) process.stdout.write('nothing to revert: neither package carries this patch\n')
  process.exit(0)
}

const unknown = inspections.flatMap((entry) => entry.rows.filter((row) => row.status === 'unknown').map((row) => ({ entry, row })))
if (unknown.length > 0) {
  for (const { entry, row } of unknown) process.stderr.write(`not in the expected shape: ${row.row.what} at ${entry.file}\n`)
  process.stderr.write('this DSH build differs; the patch needs updating rather than forcing\n')
  process.exit(1)
}

/**
 * Replace one anchor, refusing anything but a single match.
 *
 * A build that moved on, or an anchor that became ambiguous, must leave the
 * file untouched rather than half patched — so the count is checked before the
 * write, not after.
 *
 * @param source - the file's current text.
 * @param original - the anchor this patch knows.
 * @param patched - the anchor's patched form.
 * @param what - the behaviour, for the failure message.
 * @returns the text with the anchor replaced.
 */
function replaceOnce(source, original, patched, what) {
  const first = source.indexOf(original)
  if (first === -1) throw new Error(`${what}: anchor not found`)
  if (source.indexOf(original, first + original.length) !== -1) throw new Error(`${what}: anchor is ambiguous`)
  return source.slice(0, first) + patched + source.slice(first + original.length)
}

let changed = 0
for (const entry of inspections) {
  const pending = entry.rows.filter((row) => row.status === 'original')
  const installClassifier = entry.classifier !== undefined && !entry.classifier.present
  if (pending.length === 0 && !installClassifier) {
    process.stdout.write(`already patched: ${entry.file}\n`)
    continue
  }
  let next = entry.source
  for (const { row } of pending) next = replaceOnce(next, row.original, row.patched, row.what)
  if (!existsSync(entry.backup)) copyFileSync(entry.file, entry.backup)
  writeFileSync(entry.file, next)
  for (const { row } of pending) process.stdout.write(`patched ${row.what}\n`)
  if (installClassifier) {
    if (!existsSync(CLASSIFIER)) {
      process.stderr.write(`the classifier this patch installs is missing: ${CLASSIFIER}\n`)
      process.exit(1)
    }
    copyFileSync(CLASSIFIER, entry.classifier.target)
    process.stdout.write(`installed ${entry.classifier.target}\n`)
  }
  changed += 1
}

if (changed === 0) {
  process.stdout.write('nothing to do: both packages are already patched\n')
} else {
  process.stdout.write('restart dsh web for the concurrency change to take effect\n')
}
process.stdout.write('a DSH upgrade restores these files; re-run npm run patch:concurrency afterwards\n')