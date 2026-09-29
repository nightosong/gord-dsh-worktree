/**
 * Panel-owned defaults, stored beside the plugin's other state in `$DSH_HOME`.
 *
 * DSH 0.1.7 dropped per-plugin settings namespaces: a plugin's row config is
 * the only supported place for a default, and that row lives in a profile file
 * the panel cannot write. The one value the panel displays — where new
 * worktrees go — is therefore owned here, so the page that shows it can also
 * change it, and changing it does not require a restart.
 *
 * The stored value is a *default*, not a policy: a caller that names a parent
 * explicitly (the tools' `parent` argument, the panel's create form) still wins.
 *
 * @module gord-dsh-worktree/panel-settings
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * Path of the panel's own settings file.
 *
 * `GORD_DSH_WORKTREE_PANEL_SETTINGS` overrides it, which is how the host suites
 * keep a test run from reading — or writing — the real home.
 *
 * @returns {string} absolute path.
 */
export function panelSettingsPath() {
  const override = process.env.GORD_DSH_WORKTREE_PANEL_SETTINGS
  return typeof override === 'string' && override !== '' ? override : dshHomePath('gord-dsh-worktree', 'panel.json')
}

/**
 * Expand `~` and accept only absolute paths.
 *
 * A relative parent is a mistake the user would not see until a worktree landed
 * somewhere unexpected, so it is refused rather than resolved against whatever
 * the host's working directory happens to be. `''` means "no override", which
 * is also how the value is cleared.
 *
 * @param {unknown} value - raw value, possibly with a leading `~`.
 * @returns {string} absolute path, or `''`.
 */
export function normalizeParentPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const home = process.env.HOME ?? ''
  const expanded = text === '~' ? home : text.startsWith('~/') ? join(home, text.slice(2)) : text
  return expanded !== '' && isAbsolute(expanded) ? expanded : ''
}

/**
 * Read the stored defaults. Every failure means "nothing stored": a missing
 * file, unreadable JSON, or a hand-edited value that is not a usable path.
 *
 * @param {string} [file] - path to read; defaults to {@link panelSettingsPath}.
 * @returns {{ defaultParent: string }} resolved defaults.
 */
export function readPanelSettings(file = panelSettingsPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { defaultParent: normalizeParentPath(parsed?.defaultParent) }
  } catch (_) {
    return { defaultParent: '' }
  }
}

/**
 * Store the defaults, creating the directory if needed.
 *
 * @param {unknown} value - new `defaultParent`; `''` clears the override.
 * @param {string} [file] - path to write; defaults to {@link panelSettingsPath}.
 * @returns {{ ok: true, defaultParent: string } | { ok: false, error: string, message: string }}
 *   the stored value, or why it could not be stored.
 */
export function writePanelSettings(value, file = panelSettingsPath()) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const defaultParent = normalizeParentPath(raw)
  if (raw !== '' && defaultParent === '') {
    return { ok: false, error: 'bad-path', message: 'the worktree parent must be an absolute path' }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ defaultParent }, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: 'write-failed', message: String((error && error.message) || error) }
  }
  return { ok: true, defaultParent }
}