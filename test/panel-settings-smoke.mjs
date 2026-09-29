/**
 * gord-dsh-worktree panel-settings smoke test — the store behind the panel's
 * "where new worktrees go" field.
 *
 * Pure filesystem module, so this suite is the cheapest place to pin the
 * behaviour the page depends on: an empty or hand-broken file reads as "no
 * override", `~` is expanded, a relative path is refused rather than silently
 * resolved, and a refused write leaves the stored value alone.
 *
 *   node test/panel-settings-smoke.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeParentPath, panelSettingsPath, readPanelSettings, writePanelSettings } from '../lib/panel-settings.js'

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

const root = mkdtempSync(join(tmpdir(), 'gord-panel-settings-'))
const file = join(root, 'nested', 'panel.json')
const previousSeam = process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS

process.stdout.write('\nread: nothing stored\n')
check('a missing file reads as no override', readPanelSettings(file).defaultParent === '', JSON.stringify(readPanelSettings(file)))
writeFileSync(join(root, 'broken.json'), '{ not json')
check('unreadable JSON reads as no override', readPanelSettings(join(root, 'broken.json')).defaultParent === '')
writeFileSync(join(root, 'wrong.json'), JSON.stringify({ defaultParent: 42 }))
check('a value of the wrong type reads as no override', readPanelSettings(join(root, 'wrong.json')).defaultParent === '')
writeFileSync(join(root, 'relative.json'), JSON.stringify({ defaultParent: 'worktrees' }))
check('a stored relative path reads as no override', readPanelSettings(join(root, 'relative.json')).defaultParent === '')

process.stdout.write('\nwrite: round trip\n')
const saved = writePanelSettings('/tmp/gord-worktrees', file)
check('an absolute path is stored', saved.ok === true && saved.defaultParent === '/tmp/gord-worktrees', JSON.stringify(saved))
check('the directory is created for it', readPanelSettings(file).defaultParent === '/tmp/gord-worktrees', JSON.stringify(readPanelSettings(file)))
const refused = writePanelSettings('worktrees', file)
check('a relative path is refused', refused.ok === false && refused.error === 'bad-path', JSON.stringify(refused))
check('a refused write leaves the stored value alone', readPanelSettings(file).defaultParent === '/tmp/gord-worktrees', JSON.stringify(readPanelSettings(file)))
check('an empty value clears the override', writePanelSettings('   ', file).ok === true && readPanelSettings(file).defaultParent === '')

process.stdout.write('\nnormalize\n')
const home = process.env.HOME ?? ''
check('~ expands to the home directory', normalizeParentPath('~/Worktrees') === join(home, 'Worktrees'), normalizeParentPath('~/Worktrees'))
check('a bare ~ expands to the home directory', normalizeParentPath('~') === home, normalizeParentPath('~'))
check('surrounding whitespace is trimmed', normalizeParentPath('  /tmp/a  ') === '/tmp/a', JSON.stringify(normalizeParentPath('  /tmp/a  ')))
check('a non-string is no override', normalizeParentPath(undefined) === '' && normalizeParentPath(null) === '')
check('an empty string is no override', normalizeParentPath('') === '')

process.stdout.write('\nthe store can be pointed elsewhere\n')
// The host suites rely on this seam to keep a test run out of the real home.
const seam = join(root, 'seamed.json')
process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS = seam
check('the seam is the path that is used', panelSettingsPath() === seam, panelSettingsPath())
check('a write follows the seam', writePanelSettings('/tmp/seamed', seam).ok === true && readPanelSettings().defaultParent === '/tmp/seamed', JSON.stringify(readPanelSettings()))
if (previousSeam === undefined) delete process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS
else process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS = previousSeam
check('the seam is the only thing that moved it', panelSettingsPath() !== seam || process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS !== undefined)

rmSync(root, { recursive: true, force: true })
process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)