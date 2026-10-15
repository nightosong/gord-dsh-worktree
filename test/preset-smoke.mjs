#!/usr/bin/env node
/**
 * Parse the shipped preset and reject broken compositions. Static policy checks
 * are guardrails, not proof of real-model compliance or speed; see the docs for
 * the model comparison. No plugins or host services are started by this suite.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import yaml from 'js-yaml'
import semver from 'semver'

const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

// Preserve !!js until the owning row activates. Compile now, and evaluate only
// the repository's platform guards with the three simulated process.platforms.
class Expression {
  constructor(code) { this.script = new Script(`(${code})`) }
  forPlatform(platform) {
    return this.script.runInNewContext({ process: { platform } }, { timeout: 100 })
  }
}
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (code) => new Expression(code),
}))
let failures = 0
let checks = 0
function check(label, run) {
  checks += 1
  try {
    run()
    process.stdout.write(`ok   ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${label}\n     ${error.message}\n`)
  }
}
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Expression)
const nonempty = (value) => typeof value === 'string' && value.trim() !== ''

/** Validate mountable rows recursively, including isolated child groups. */
function validateRows(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'plugin rows must be a non-empty list')
  const seen = new Set()
  for (const row of rows) {
    assert.ok(record(row) && nonempty(row.id) && nonempty(row.name), 'each plugin needs an id and package name')
    assert.ok(!seen.has(row.id), `duplicate plugin id: ${row.id}`)
    seen.add(row.id)
    assert.ok(row.disabled === undefined || typeof row.disabled === 'boolean' || row.disabled instanceof Expression, 'disabled must be boolean or !!js')
    if (row.name === 'cordis:group') {
      assert.equal(row.group, true, 'a group must declare group: true')
      assert.ok(record(row.isolate), 'a group must declare its isolation scope')
      validateRows(row.config)
    } else {
      assert.ok(row.config === undefined || record(row.config), 'plugin config must be a mapping')
    }
  }
}
function parseBundle(text) {
  const patch = yaml.load(text, { schema })
  assert.ok(Array.isArray(patch) && patch.length > 0, 'bundle patch must be a list')
  const rows = patch.flatMap((operation) => {
    assert.ok(record(operation) && Object.keys(operation).length === 1 && Array.isArray(operation.insert), 'expected an insert operation')
    return operation.insert
  })
  validateRows(rows)
  const mounts = rows.filter((row) => row.name === 'gord-dsh-worktree')
  assert.equal(mounts.length, 1, 'one worktree host mount is required')
  assert.equal(mounts[0].id, 'gord-dsh-worktree')
  const presets = rows.filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
  assert.equal(presets.length, 1, 'one fast preset is required')
  assert.equal(presets[0].id, 'preset-fast')
  const preset = presets[0].config
  assert.ok(record(preset), 'preset config must be a mapping')
  assert.equal(preset.id, 'fast')
  assert.ok(nonempty(preset.name) && nonempty(preset.description), 'preset needs display text')
  assert.ok(Number.isFinite(preset.order), 'preset order must be numeric')
  validateRows(preset.plugins)
  return preset
}

let preset
check('the actual YAML parses as a mountable bundle composition', () => { preset = parseBundle(source) })
if (!preset) process.exit(1)
const plugins = preset.plugins
const plugin = (id) => plugins.find((row) => row.id === id)
const persona = plugin('persona')?.config
const policy = persona?.suffix ?? ''
const normalized = policy.replace(/\s+/g, ' ')
const expected = [
  ['persona', '@deepseek-ai/dsh-persona'],
  ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
  ['tool-bash', '@deepseek-ai/dsh-tool-bash'],
  ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
  ['tool-fs', '@deepseek-ai/dsh-tool-fs'],
  ['tool-fs-search', '@deepseek-ai/dsh-tool-fs-search'],
  ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
  ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['compaction', 'cordis:group'],
  ['tool-ask-user', '@deepseek-ai/dsh-tool-ask-user'],
  ['tool-todo', '@deepseek-ai/dsh-tool-todo'],
  ['tool-web', '@deepseek-ai/dsh-tool-web'],
  ['present', '@deepseek-ai/dsh-tool-present'],
]
check('the fourteen rows use the intended plugin package names', () => {
  assert.deepEqual(plugins.map(({ id, name }) => [id, name]), expected)
})
check('the picker keeps the fast preset name and ordering', () => {
  assert.equal(preset.name, '快速模式')
  assert.equal(preset.order, 0)
})
check('persona strings keep runtime model and directory placeholders', () => {
  assert.ok(nonempty(persona.prefix) && nonempty(policy))
  assert.ok(persona.prefix.includes('{{model}}') && policy.includes('{{cwd}}'))
})
for (const platform of ['darwin', 'linux', 'win32']) {
  check(`${platform} activates exactly its native shell`, () => {
    const bash = plugin('tool-bash').disabled
    const pwsh = plugin('tool-pwsh').disabled
    assert.ok(bash instanceof Expression && pwsh instanceof Expression)
    assert.equal(bash.forPlatform(platform), platform === 'win32')
    assert.equal(pwsh.forPlatform(platform), platform !== 'win32')
  })
}
check('compaction keeps isolated services and a valid pruning budget', () => {
  const group = plugin('compaction')
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.deepEqual(group.config.map((row) => row.name), [
    '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ])
  const { thresholdChars, headChars, tailChars } = group.config[2].config
  assert.ok(Number.isInteger(thresholdChars) && thresholdChars > 0)
  assert.ok(Number.isInteger(headChars) && headChars >= 0 && Number.isInteger(tailChars) && tailChars >= 0)
  assert.ok(headChars + '\n\n[... tool result middle pruned ...]\n\n'.length + tailChars <= thresholdChars)
})
check('the preset does not choose a model or change the default preset', () => {
  assert.ok(!/^\s*(?:default|model):/m.test(source))
  assert.ok(!plugins.some((row) => /(?:llm-|agent-default-model)/.test(row.name)))
})
check('the patch contains no home paths or credential-looking values', () => {
  assert.ok(!/\/(Users|home)\//.test(source) && !/\bsk-[A-Za-z0-9]{8}/.test(source))
})
check('the patch preserves LF formatting and one trailing newline', () => {
  assert.ok(!/[\t\r]/.test(source))
  assert.ok(source.endsWith('\n') && !source.endsWith('\n\n'))
})

// npm's default prerelease rules apply to peers; widening only the stable upper
// bound still excludes 0.2.0-rc.2. Exercise every published DSH constraint without
// includePrerelease so the test matches what package managers actually accept.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const dshRanges = [
  ['engines.dsh', manifest.engines.dsh],
  ...Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')),
]
check('engine and all four DSH peers share a valid compatibility range', () => {
  assert.equal(dshRanges.length, 5)
  for (const [, range] of dshRanges) {
    assert.ok(semver.validRange(range))
    assert.equal(range, manifest.engines.dsh)
  }
})
for (const version of ['0.1.5-rc.1', '0.1.5', '0.1.6-alpha.2', '0.1.6', '0.1.7-rc.2', '0.1.7', '0.1.9', '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1', '0.2.99']) {
  check(`package managers accept supported DSH ${version}`, () => {
    for (const [name, range] of dshRanges) assert.ok(semver.satisfies(version, range), `${name} rejects ${version}`)
  })
}
for (const version of ['0.1.4', '0.1.5-rc.0', '0.2.1-rc.1', '0.3.0-alpha.1', '0.3.0-rc.2', '0.3.0', '1.0.0']) {
  check(`package managers reject unqualified DSH ${version}`, () => {
    for (const [name, range] of dshRanges) assert.ok(!semver.satisfies(version, range), `${name} unexpectedly accepts ${version}`)
  })
}

// Reject actual bad inputs rather than merely finding expected source strings.
check('trailing invalid YAML is rejected instead of falsely passing', () => {
  assert.throws(() => parseBundle(source + 'invalid: [\n'), yaml.YAMLException)
})
check('duplicate YAML mapping keys are rejected', () => {
  assert.throws(() => parseBundle(source.replace('        id: fast', '        id: fast\n        id: other')), /duplicated mapping key/i)
})
check('a missing preset package field is rejected', () => {
  assert.throws(() => parseBundle(source.replace("      name: '@deepseek-ai/dsh-agent-preset'", "      package: '@deepseek-ai/dsh-agent-preset'")), /package name/)
})
check('a duplicate preset mount is rejected', () => {
  const fastInsert = source.slice(source.lastIndexOf('- insert:'))
  assert.throws(() => parseBundle(source + fastInsert), /duplicate plugin id: preset-fast/)
})
check('a scalar plugin list is rejected', () => {
  assert.throws(() => parseBundle(source.replace('        plugins:', '        plugins: false\n        misplacedPlugins:')), /plugin rows must be a non-empty list/)
})
check('invalid JavaScript guard syntax is rejected before activation', () => {
  assert.throws(() => parseBundle(source.replace("process.platform === 'win32'", 'process.platform ===')), SyntaxError)
})

// Static policy contracts inspect only the parsed persona, never comments. These
// cannot substitute for measuring the behavior of the selected model/provider.
const requires = (label, ...patterns) => check(label, () => {
  for (const pattern of patterns) assert.match(normalized, pattern)
})
requires('batching preserves dependency order and result inspection',
  /batching independent reads/, /dependent operations sequential/, /Read every result, including exit codes/)
requires('blocked jobs may wait with a timeout and must be collected',
  /job_output with wait: true and a bounded timeout/, /collect relevant output and final status/, /still-running test is not a passed test/)
requires('new ambiguity can be clarified while dependent actions pause',
  /new ambiguity appears mid-run, ask then/, /pause dependent actions until answered/, /Never guess the target environment/)
requires('typo handling preserves exact resources and destructive intent',
  /IME, dictation and half-converted/, /negation may be missing/, /delete, overwrite, publish or send/, /do not substitute the nearest match/)
requires('defect fixes may add focused regression tests',
  /add or update a focused regression test/, /use existing checks for simple changes/, /Offer unrelated tests, docs and refactors/)
requires('native edits reuse observed versions while external changes require rereading',
  /read tool before its first edit/, /Successful native write\/edit tools update the observed version/,
  /Reread affected content after shell commands, formatters, scripts or external processes change it/, /stale-version error/, /compaction removed needed context/)
requires('answers stand alone and reviews do not trigger unrequested edits',
  /final answer must stand alone/, /informational question or review, answer with evidence without making unrequested changes/)
requires('transient failures allow bounded retries', /retry an unchanged call only for a transient failure, with a bounded retry count/)
requires('authorized boundary evaluations preserve their content and refusal limits',
  /inert category label or an existing fixture/, /Never generate, paraphrase, substitute, vary or reword to get past a filter/,
  /reproduced from its trace id instead of replayed/, /do not refuse the whole task/)
check('the conflicting absolute rules do not return', () => {
  assert.doesNotMatch(normalized, /Never wait inside the turn|Never open a question in the middle|One pass per turn|Unrequested tests, docs, and refactors|never re-read what is already/)
})

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exitCode = failures === 0 ? 0 : 1
