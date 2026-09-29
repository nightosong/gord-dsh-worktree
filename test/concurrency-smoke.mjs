#!/usr/bin/env node
/**
 * gord-dsh-worktree concurrency-patch smoke test.
 *
 * The concurrency patch is the second piece of this plugin that edits files it
 * does not own, so it is the second piece that can stop matching after a DSH
 * upgrade — and it fails the same quiet way: the plugin still loads, the tools
 * still work, only the scheduling stops overlapping. So this drives the tool
 * against synthetic packages whose anchors are minimal but real in shape, and
 * then checks the *installed* core is recognizable rather than unknown:
 *
 *   • pending → patched → idempotent → reverted, byte for byte;
 *   • an unrecognizable build fails closed and writes nothing at all;
 *   • the classifier it installs is the one this plugin ships, and it answers
 *     the safety questions correctly (writers and scripts stay exclusive);
 *   • this DSH install is `patched` or `original`, never `unknown`.
 *
 * Nothing here writes to the installed copy: the tool is pointed at packages in
 * a temp directory, and the installed files are only read.
 *
 *   node test/concurrency-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(ROOT, 'tools', 'patch-concurrency.mjs')
const CLASSIFIER = join(ROOT, 'lib', 'read-only-command.js')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`FAIL ${label}${detail === undefined ? '' : `\n     ${detail}`}\n`)
}

const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })

/** A minimal `bash` package carrying the anchors the patch knows. */
const BASH_FIXTURE = `import z from "@deepseek-ai/schemastery";
import { isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
function bashTool() {
\treturn () => {
\t\treturn defineTool({
\t\t\tname: "bash",
\t\t\tdescription: "run a command",
\t\t\tparameters: { command: { type: "string", required: true } }
\t\t});
\t};
}
export default bashTool;
`

/** A minimal search package carrying both anchors. */
const FS_FIXTURE = `import { defineTool } from "@deepseek-ai/dsh-tools";
function globTool() {
\tconst tool = defineTool({
\t\tname: "glob",
\t\tdescription: "find files"
\t});
\treturn tool;
}
function grepTool() {
\tconst tool = defineTool({
\t\tname: "grep",
\t\tdescription: "search contents"
\t});
\treturn tool;
}
export { globTool, grepTool };
`

/** A build that moved on: the anchor is not there in the shape the patch knows. */
const DRIFTED_FIXTURE = BASH_FIXTURE.replace('\t\t\tname: "bash",\n', "\t\t\tname: 'bash',\n")

const directory = mkdtempSync(join(tmpdir(), 'gord-concurrency-'))
const bashPackage = join(directory, 'dsh-tool-bash')
const searchPackage = join(directory, 'dsh-tool-fs-search')
const driftedPackage = join(directory, 'dsh-tool-bash-drifted')
for (const [target, source] of [
  [bashPackage, BASH_FIXTURE],
  [searchPackage, FS_FIXTURE],
  [driftedPackage, DRIFTED_FIXTURE],
]) {
  mkdirSync(join(target, 'lib'), { recursive: true })
  writeFileSync(join(target, 'lib', 'index.js'), source)
}
const targets = ['--tool-bash', bashPackage, '--tool-fs-search', searchPackage]
const bashFile = join(bashPackage, 'lib', 'index.js')
const searchFile = join(searchPackage, 'lib', 'index.js')
const installedClassifier = join(bashPackage, 'lib', 'read-only-command.js')

// 1. Fresh packages read as pending, not as an unrecognizable build.
const pending = run(['--check', ...targets])
check('a fresh package reports its rows as original', pending.status === 2, `exit ${pending.status}\n${pending.stdout}${pending.stderr}`)
check('check names the pending behaviours', /original\s+bash: read-only commands run concurrently/.test(pending.stdout), pending.stdout)
check('check names the missing classifier', /original\s+bash: lib\/read-only-command\.js is installed/.test(pending.stdout), pending.stdout)

// 2. Applying patches both packages and installs the classifier.
const apply = run(targets)
check('applying exits 0', apply.status === 0, `exit ${apply.status}\n${apply.stderr}`)
const bashPatched = readFileSync(bashFile, 'utf8')
const searchPatched = readFileSync(searchFile, 'utf8')
check('bash imports the classifier', bashPatched.includes('import { isReadOnlyCommand } from "./read-only-command.js";'))
check('bash classifies read-only commands', bashPatched.includes('isConcurrencySafe: (args) => isReadOnlyCommand(args?.command),'))
check('bash keeps the anchor it patched', bashPatched.includes('\t\treturn defineTool({\n\t\t\tname: "bash",\n'))
check('glob is concurrent', /name: "glob",\n\t*\/\/ gord-dsh-worktree: a glob only reads\n\t*isConcurrencySafe: \(\) => true,/.test(searchPatched))
check('grep is concurrent', /name: "grep",\n\t*\/\/ gord-dsh-worktree: a grep only reads\n\t*isConcurrencySafe: \(\) => true,/.test(searchPatched))
check('the classifier file is installed', existsSync(installedClassifier))
check('the installed classifier is the shipped one', readFileSync(installedClassifier, 'utf8') === readFileSync(CLASSIFIER, 'utf8'))
check('a backup is kept beside the patched file', existsSync(`${bashFile}.orig`))

// 3. Applying again changes nothing.
const again = run(targets)
check('re-applying exits 0', again.status === 0, `exit ${again.status}\n${again.stderr}`)
check('re-applying says there is nothing to do', /already patched|nothing to do/.test(again.stdout), again.stdout)
check('re-applying leaves bash byte-identical', readFileSync(bashFile, 'utf8') === bashPatched)
check('re-applying leaves search byte-identical', readFileSync(searchFile, 'utf8') === searchPatched)

// 4. A patched install is fully recognizable.
const patched = run(['--check', ...targets])
check('a patched package reports as patched', patched.status === 0, `exit ${patched.status}\n${patched.stdout}${patched.stderr}`)
check('no row stays original', !/^original/m.test(patched.stdout), patched.stdout)

// 5. A build that moved on fails closed and writes nothing.
const before = readFileSync(join(driftedPackage, 'lib', 'index.js'), 'utf8')
const drifted = run(['--tool-bash', driftedPackage, '--tool-fs-search', searchPackage])
check('an unknown build exits 1', drifted.status === 1, `exit ${drifted.status}\n${drifted.stdout}${drifted.stderr}`)
check('an unknown build says the shape differs', /not in the expected shape/.test(drifted.stderr), drifted.stderr)
check('an unknown build writes nothing', readFileSync(join(driftedPackage, 'lib', 'index.js'), 'utf8') === before)
check('an unknown build patches no other package either', readFileSync(searchFile, 'utf8') === searchPatched)

// 6. Reverting restores both files and removes the classifier it installed.
const revert = run(['--revert', ...targets])
check('reverting exits 0', revert.status === 0, `exit ${revert.status}\n${revert.stderr}`)
check('reverting restores bash byte for byte', readFileSync(bashFile, 'utf8') === BASH_FIXTURE)
check('reverting restores search byte for byte', readFileSync(searchFile, 'utf8') === FS_FIXTURE)
check('reverting removes the classifier', !existsSync(installedClassifier))

rmSync(directory, { recursive: true, force: true })

// 7. This install must be recognizable: patched or original, never unknown.
const installed = run(['--check'])
check('the installed core is recognizable', installed.status === 0 || installed.status === 2, `exit ${installed.status}\n${installed.stdout}${installed.stderr}`)
if (installed.status === 2) process.stdout.write('note: this install is not patched yet — run npm run patch:concurrency\n')
else if (installed.status === 0) process.stdout.write('note: this install already carries the concurrency patch\n')

// 8. The classifier answers the questions the scheduler depends on.
const { isReadOnlyCommand } = await import(CLASSIFIER)
const cases = [
  ['ls -la', true],
  ['cat a.txt | grep -n foo | wc -l', true],
  ['cd /x && git status --short', true],
  ['git -C /x status -s', true],
  ['grep -rn "foo" src --include=*.go | head -20', true],
  ['ps aux | grep -i node', true],
  ['curl -sS https://api.example.com/v1/models', true],
  ['jq -r ".a.b" x.json', true],
  ['docker ps --format {{.Names}}', true],
  ['npm ls --depth=0', true],
  ['python3 --version', true],
  ['ls && cat f 2>&1 | head -3', true],
  ['', false],
  ['rm -rf /tmp/x', false],
  ['echo hi > f.txt', false],
  ['sed -i "" "s/a/b/" f', false],
  ['find . -name x -delete', false],
  ['git commit -m x', false],
  ['git config user.name x', false],
  ['git log --output=f.txt', false],
  ['npm install', false],
  ['pnpm add -D x', false],
  ['node test/host-smoke.mjs', false],
  ['python3 scripts/db_read.py --project sr-maas', false],
  ['curl -X POST https://x -d @body.json', false],
  ['curl -o /tmp/out https://x', false],
  ['yq -i ".a=1" f.yaml', false],
  ['sort -o out.txt in.txt', false],
  ['echo $(rm -rf x)', false],
  ['echo `date`', false],
  ['tee /tmp/f', false],
  ['xargs rm', false],
  ['kubectl config set-context x', false],
  ['ip link set en0 down', false],
  ['for i in 1 2 3; do echo $i; done', false],
  ['sleep 100; cd /x && echo hi', false],
]
const wrong = cases.filter(([command, expected]) => isReadOnlyCommand(command) !== expected)
check(`the classifier answers all ${cases.length} cases`, wrong.length === 0, wrong.map(([command, expected]) => `${expected ? 'should be parallel' : 'should be exclusive'}: ${command}`).join('\n     '))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)