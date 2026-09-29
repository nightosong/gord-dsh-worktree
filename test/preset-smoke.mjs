#!/usr/bin/env node
/**
 * gord-dsh-worktree bundle-patch smoke test.
 *
 * Two things in `cordis.patch.yml` are load-bearing and neither fails loudly:
 * the row that mounts this plugin, and the `preset-fast` row that puts Fast mode
 * in the picker. A typo in either one leaves the plugin installed and the
 * feature missing, and the composition loader reports it as a warning at boot
 * rather than as a test failure. So this reads the file the loader reads and
 * checks the shape it needs:
 *
 *   • exactly one mount row for this plugin, under an `insert` list;
 *   • exactly one `@deepseek-ai/dsh-agent-preset` row, id `fast`, with the
 *     fourteen plugins Fast mode is defined by — no more, no fewer;
 *   • nothing personal in it: no absolute home path, no credential, and no
 *     `default:` here, because which preset a session starts in is the user's
 *     choice, not this plugin's;
 *   • the `!!js` expressions the Windows/WSL tool rows need are intact.
 *
 *   node test/preset-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(ROOT, 'cordis.patch.yml')

/** The plugins Fast mode is defined by, in order. */
const PLUGINS = [
  'persona',
  'agent-instructions',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'compaction',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
]

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

const source = readFileSync(PATCH, 'utf8')
const lines = source.split('\n')

// 1. The plugin still mounts itself.
const mounts = lines.filter((line) => line === "      name: 'gord-dsh-worktree'")
check('the bundle mounts this plugin exactly once', mounts.length === 1, `found ${mounts.length}`)
check('the mount sits under an insert list', lines.includes('- insert:'))

// 2. Fast mode is declared once, with the right identity.
const presetRows = lines.filter((line) => line === '    - id: preset-fast')
check('the bundle declares preset-fast exactly once', presetRows.length === 1, `found ${presetRows.length}`)
const start = lines.indexOf('    - id: preset-fast')
const block = start === -1 ? [] : lines.slice(start)
const field = (name) => block.find((line) => line.startsWith(`        ${name}:`))
check('the preset is an agent-preset row', block[1] === "      name: '@deepseek-ai/dsh-agent-preset'", block[1])
check('the preset id is fast', (field('id') ?? '').trim() === 'id: fast', field('id'))
check('the preset is named 快速模式', (field('name') ?? '').includes('快速模式'), field('name'))
check('the preset has a description', (field('description') ?? '').length > 20, field('description'))
check('the preset sorts first in the picker', (field('order') ?? '').trim() === 'order: 0', field('order'))

// 3. Its plugin list is exactly the fourteen rows Fast mode is.
const ids = block.filter((line) => line.startsWith('          - id: ')).map((line) => line.replace('          - id: ', '').trim())
check(`the preset lists ${PLUGINS.length} plugins`, ids.length === PLUGINS.length, `found ${ids.length}: ${ids.join(', ')}`)
check('the plugin list matches', ids.join(' ') === PLUGINS.join(' '), ids.join(' '))
check('the preset keeps compaction', ids.includes('compaction'))
check('the preset carries the model-facing rows', ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-web', 'persona'].every((id) => ids.includes(id)))

// 4. Nothing personal, nothing that would decide for the installing user.
check('no absolute home path', !/\/(Users|home)\//.test(source))
check('no credential-looking value', !/\bsk-[A-Za-z0-9]{8}/.test(source))
check('no default preset choice', !/^\s*default:/m.test(source))
check('no kloop anywhere', !/kloop/i.test(source))
check('the Windows/WSL rows keep their !!js guards', (source.match(/!!js/g) ?? []).length === 2, String((source.match(/!!js/g) ?? []).length))

// 5. Fast mode\'s defining behaviour: one pass, batching, no blocking waits.
check('the persona states the round-trip rule', source.includes('Round trips are the scarce resource'))
check('the persona forbids blocking waits', /Never wait inside the turn/.test(source))
check('the persona asks once, up front', /ask it as your opening move/.test(source))
check('the removed three-beat wording is gone', !/three-beat/.test(source))

// 6. Shape the loader needs: LF, no tabs, and a trailing newline.
check('the file has no tab characters', !source.includes('\t'))
check('the file ends with exactly one newline', source.endsWith('\n') && !source.endsWith('\n\n'))
check('the file is not empty above the rows', lines.slice(0, 20).some((line) => line.startsWith('- insert:')))

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)