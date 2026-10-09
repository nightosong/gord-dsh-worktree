/**
 * gord-dsh-worktree — the session archive: what is in it, and the two ways out.
 *
 * DSH archives a session by adding its id to one array on the workspace
 * registry's global state, and it offers no way back: the remote contract has
 * `archiveSession` and nothing else, no CLI command touches it, and no screen
 * lists what was archived — the whole client carries exactly one archive
 * string, the menu item that does the archiving. A session that is archived
 * therefore disappears from every grouping surface with no record to review
 * and no control to undo it.
 *
 * Both operations this module adds go through that same array, which is what
 * makes them land the way the core's own archive does rather than beside it.
 * The registry writes through the storage domain; the domain emits
 * `domain/changed` once the backend has acknowledged durability; the workspace
 * controller turns that into the `archived` frame the sidebar already follows.
 * So unarchiving is on screen immediately, with no restart, and the sidebar's
 * own ordering is preserved — a session keeps its place in its workspace's
 * `sessionIds` while archived, which is exactly why unarchiving restores it
 * where it was.
 *
 * Deleting is the one thing DSH cannot do at all, in any form. It is
 * irreversible, so it says what it removes — the log directory, the projection
 * cache row and the workspace membership — and it refuses to touch a session
 * that is still live rather than pulling the log out from under a running
 * agent. What it does *not* remove is the archive entry; see
 * {@link deleteSessions} for why that entry has to outlive the log.
 *
 * Archive *times* are not DSH's to give: the archive set is a bare id array
 * with no timestamps anywhere. They are recorded here, in a file this plugin
 * owns, from the moment it starts watching. Sessions that were already
 * archived when it started are kept as "not recorded" rather than dated now —
 * see {@link syncArchiveRecord}.
 *
 * Titles are the same story one step further: the sidebar's title is a
 * projection row, and archiving a session usually takes that row's source away
 * with it, so an archived list that has only ids cannot say which session is
 * which. What the session was about is recorded beside the time, read once from
 * the projection while it lasts and otherwise from the log's own first prompt —
 * see {@link learnArchiveTitles}.
 *
 * @module gord-dsh-worktree/archive
 */

import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { worktreePathsInText } from './worktree.js'

/** Bumped only when the record's shape changes; an unreadable record is rebuilt. */
export const ARCHIVE_RECORD_VERSION = 1

/**
 * Rows returned to the panel. The archive set is unbounded — it only grows —
 * and every row costs a projection read, so the list is capped rather than
 * rendered at whatever size the history has reached.
 */
export const MAX_ARCHIVE_ROWS = 500
/**
 * How many titles one listing may go looking for.
 *
 * A title is read at most once per session and kept, so this only bounds the one
 * listing that meets a whole archive set with nothing recorded — the first one
 * after this version, or after archiving several sessions with the plugin
 * stopped. The rest are picked up by the listings after it.
 */
export const MAX_TITLE_LOOKUPS = 20
/** A title is a label, not a transcript. */
const TITLE_MAX = 120
/** How much of a log is read, how many of its frames are decoded, to find its first prompt. */
const LOG_PREFIX_BYTES = 4 * 1024 * 1024
const LOG_FRAME_LIMIT = 24
/** The zstd frame magic: the only marker a log's appended frames have in common. */
const LOG_FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Session-worktree record version; the parser refuses anything else. */
const SESSION_WORKTREE_VERSION = 1

/** Where the archive times live. Plugin-owned, because DSH keeps none. */
export function archiveRecordPath() {
  return dshHomePath('gord-dsh-worktree', 'archived-at.json')
}

/** Where the worktrees sessions created or moved into are remembered. */
export function sessionWorktreeRecordPath() {
  return dshHomePath('gord-dsh-worktree', 'session-worktrees.json')
}

/** A record with nothing in it: session directory → the worktree it works in. */
export function emptySessionWorktreeRecord() {
  return { version: SESSION_WORKTREE_VERSION, worktrees: {} }
}

/**
 * Parse the session-worktree record's text.
 *
 * Undefined for anything unusable, like the archive record: it is an
 * optimisation over reading a log, and a log can always answer again. An empty
 * string is a real answer — "this session was looked at and works in no
 * worktree" — and is kept, which is what stops the log read from happening on
 * every hover.
 *
 * @param {string} text - the file's contents.
 * @returns {object|undefined} the record, or undefined when unusable.
 */
export function parseSessionWorktreeRecord(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object' || data.version !== SESSION_WORKTREE_VERSION) return undefined
  const source = data.worktrees
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  const worktrees = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') worktrees[key] = value
  }
  return { version: SESSION_WORKTREE_VERSION, worktrees }
}

/** Read the session-worktree record, or an empty one when it is absent or unusable. */
export async function readSessionWorktreeRecord() {
  try {
    return parseSessionWorktreeRecord(await readFile(sessionWorktreeRecordPath(), 'utf8')) ?? emptySessionWorktreeRecord()
  } catch {
    return emptySessionWorktreeRecord()
  }
}

/**
 * Remember which worktree one session directory works in.
 *
 * An empty path is recorded too, because it is the answer "looked, nothing
 * there" — the same marker the archive record keeps for a session whose log had
 * no title. Failing to write costs only a log read later, so it is swallowed:
 * a hover card must never fail a checkout that succeeded.
 *
 * @param {string} sessionDir - the directory the session was started in.
 * @param {string} worktreePath - the worktree it works in, or '' for none.
 */
export async function rememberSessionWorktree(sessionDir, worktreePath) {
  if (typeof sessionDir !== 'string' || sessionDir === '' || typeof worktreePath !== 'string') return
  const path = sessionWorktreeRecordPath()
  const record = await readSessionWorktreeRecord()
  if (record.worktrees[sessionDir] === worktreePath) return
  record.worktrees[sessionDir] = worktreePath
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // The answer is a convenience; the next read can rebuild it from the log.
  }
}

/**
 * The worktree a session works in, or ''.
 *
 * A session's own directory is fixed when it is created, so a worktree cut
 * mid-conversation is never where the session lives — but it is where the
 * session works, and the card follows the branch the session is actually on.
 * The record answers once it has been written (by the tool that made a
 * worktree, or by an earlier read); until then the session's log does, once.
 *
 * @param {string} sessionDir - the directory the session was started in.
 * @param {string} sessionId - the session id, for the first read.
 * @returns {Promise<string>} the worktree path, or ''.
 */
export async function sessionWorktree(sessionDir, sessionId) {
  if (typeof sessionDir !== 'string' || sessionDir === '') return ''
  const record = await readSessionWorktreeRecord()
  if (Object.prototype.hasOwnProperty.call(record.worktrees, sessionDir)) return record.worktrees[sessionDir]
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const found = await workingWorktreeOf(sessionId)
  await rememberSessionWorktree(sessionDir, found)
  return found
}

/** A record with nothing in it. */
export function emptyArchiveRecord() {
  return { version: ARCHIVE_RECORD_VERSION, archivedAt: {}, titles: {} }
}

/**
 * Parse a record file's text.
 *
 * Returns undefined for anything unusable — absent, truncated by a kill,
 * written by a different version — because the record is a convenience over
 * data DSH owns, and a broken one must degrade to "no times recorded" rather
 * than take the archive list down with it.
 *
 * `titles` is additive: a record written before titles were recorded still
 * parses, and its sessions are titled on the next listing instead.
 *
 * @param {unknown} text - file contents.
 * @returns {{ version: number, archivedAt: Record<string, number|null>, titles: Record<string, string> }|undefined}
 */
export function parseArchiveRecord(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (raw.version !== ARCHIVE_RECORD_VERSION) return undefined
  const at = raw.archivedAt
  if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
  const archivedAt = {}
  for (const [id, value] of Object.entries(at)) {
    if (id === '') continue
    archivedAt[id] = Number.isFinite(value) ? Number(value) : null
  }
  const titles = {}
  const rawTitles = raw.titles
  if (rawTitles !== null && typeof rawTitles === 'object' && !Array.isArray(rawTitles)) {
    for (const [id, value] of Object.entries(rawTitles)) {
      // A blank title is kept, not dropped: it is the record of a log that had no
      // prompt to give, and that record is what keeps the read from happening
      // again on every listing.
      if (id === '' || typeof value !== 'string') continue
      titles[id] = value
    }
  }
  return { version: ARCHIVE_RECORD_VERSION, archivedAt, titles }
}

/**
 * Bring the record in line with the ids that are actually archived.
 *
 * The map mirrors the current archive set rather than accumulating: an id that
 * is no longer archived is dropped, so archiving it again later records a fresh
 * time instead of resurrecting the old one.
 *
 * @param {{ archivedAt: Record<string, number|null>, titles?: Record<string, string> }|undefined} record - previous record.
 * @param {readonly string[]} ids - the ids currently archived.
 * @param {number} now - epoch ms stamped on ids this call has not seen before.
 * @param {boolean} [seed] - stamp every id as unknown instead. Used once, the
 *   first time this plugin ever sees an archive set: those sessions were
 *   archived by something that was not recording, and dating them `now` would
 *   report the install time as the archive time.
 * @returns {{ version: number, archivedAt: Record<string, number|null>, titles: Record<string, string> }}
 */
export function reconcileArchiveRecord(record, ids, now, seed) {
  const before = record !== undefined && record !== null && typeof record.archivedAt === 'object' && record.archivedAt !== null
    ? record.archivedAt
    : {}
  const beforeTitles = record !== undefined && record !== null && typeof record.titles === 'object' && record.titles !== null
    ? record.titles
    : {}
  const archivedAt = {}
  const titles = {}
  for (const raw of ids) {
    const id = String(raw)
    if (seed === true) archivedAt[id] = null
    else if (Object.prototype.hasOwnProperty.call(before, id)) archivedAt[id] = before[id]
    else archivedAt[id] = now
    // A title is knowledge about the session, so it survives a sync for as long as
    // the session is archived and is dropped with it, exactly like the time —
    // including the blank that records "looked, nothing there".
    if (typeof beforeTitles[id] === 'string') titles[id] = beforeTitles[id]
  }
  return { version: ARCHIVE_RECORD_VERSION, archivedAt, titles }
}

/** Whether two records would serialize identically, so a no-op sync does not rewrite the file. */
export function sameArchiveRecord(left, right) {
  const a = left?.archivedAt ?? {}
  const b = right?.archivedAt ?? {}
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (a[key] !== b[key]) return false
  }
  const titlesA = left?.titles ?? {}
  const titlesB = right?.titles ?? {}
  const titleKeys = Object.keys(titlesA)
  if (titleKeys.length !== Object.keys(titlesB).length) return false
  for (const key of titleKeys) {
    if (titlesA[key] !== titlesB[key]) return false
  }
  return true
}

/**
 * One row per archived session, newest archive first.
 *
 * Rows with no recorded archive time sort last, ordered among themselves by
 * session age — so the undated tail is still ordered by something real rather
 * than by whatever order the registry happens to hold.
 *
 * @param {readonly string[]} ids - archive order, as the registry keeps it.
 * @param {(id: string) => { title?: string, cwd?: string, createdAt?: number, updatedAt?: number, sizeBytes?: number }} metaOf
 * @param {{ archivedAt: Record<string, number|null>, titles?: Record<string, string> }|undefined} record
 */
export function archiveRows(ids, metaOf, record) {
  const at = record?.archivedAt ?? {}
  const rows = ids.map((raw) => {
    const id = String(raw)
    const meta = metaOf(id) ?? {}
    return {
      id,
      title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : undefined,
      cwd: typeof meta.cwd === 'string' && meta.cwd !== '' ? meta.cwd : undefined,
      createdAt: Number.isFinite(meta.createdAt) ? Number(meta.createdAt) : undefined,
      updatedAt: Number.isFinite(meta.updatedAt) ? Number(meta.updatedAt) : undefined,
      sizeBytes: Number.isFinite(meta.sizeBytes) ? Number(meta.sizeBytes) : undefined,
      archivedAt: Number.isFinite(at[id]) ? Number(at[id]) : null,
    }
  })
  rows.sort((left, right) => {
    const a = left.archivedAt === null ? Number.NEGATIVE_INFINITY : left.archivedAt
    const b = right.archivedAt === null ? Number.NEGATIVE_INFINITY : right.archivedAt
    if (a !== b) return b - a
    return (right.createdAt ?? 0) - (left.createdAt ?? 0)
  })
  return rows
}

/**
 * The archived ids, or undefined when no workspace registry is composed in.
 *
 * `archivedSessionIds` is a public getter on the registry, so reading is
 * supported; only the writes below reach past the remote contract.
 *
 * @param {unknown} registry - the workspace registry, or undefined.
 * @returns {string[]|undefined}
 */
export function archivedIds(registry) {
  if (registry === undefined || registry === null) return undefined
  const ids = registry.archivedSessionIds
  return Array.isArray(ids) ? ids.map(String) : undefined
}

/** Read the record file, or undefined when it is missing or unusable. */
export async function readArchiveRecordFile(path) {
  try {
    return parseArchiveRecord(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write the record file, creating its directory. Throws only on a real failure. */
export async function writeArchiveRecordFile(path, record) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

/**
 * Read the record and bring it in line with `ids`, writing only when something
 * actually changed.
 *
 * Called both from the panel's list and from the `domain/changed` listener, so
 * an archive made while the plugin is loaded is stamped at the moment it
 * happens. An archive made while the plugin is *not* loaded can only be
 * stamped at the next sync, which is the closest this can get without a
 * timestamp DSH does not keep.
 *
 * @returns {Promise<{ record: object, path: string, seeded: boolean }>}
 */
export async function syncArchiveRecord(deps, ids) {
  const path = archiveRecordPath()
  const existing = await readArchiveRecordFile(path)
  const seeded = existing === undefined
  const base = existing ?? emptyArchiveRecord()
  const next = reconcileArchiveRecord(base, ids, deps.now(), seeded)
  if (seeded || !sameArchiveRecord(base, next)) await writeArchiveRecordFile(path, next)
  return { record: next, path, seeded }
}

/**
 * The directory a session runs in, read from the headers DSH keeps.
 *
 * A session's own summary carries it too, but only for a session this process
 * has loaded; the header is written when the session is created and is there for
 * every session that still has a log. Empty when nothing knows, which the
 * callers read as "no directory to talk about" rather than as an error.
 *
 * @param {object} deps - the archive dependencies, as {@link headerIndex} takes them.
 * @param {string} id - the session id.
 * @returns {Promise<string>} the session's cwd, or ''.
 */
export async function sessionCwd(deps, id) {
  if (typeof id !== 'string' || id === '') return ''
  const headers = await headerIndex(deps?.persistence)
  const header = headers.get(id)
  return typeof header?.cwd === 'string' ? header.cwd : ''
}

/**
 * The directory holding one session's log, or undefined when it is gone.
 *
 * Looked up by scanning rather than by rebuilding DSH's directory naming: the
 * log directory is named exactly the session id, one level under a project
 * directory whose name is derived from the cwd. Deriving that name here would
 * be a second copy of a rule this plugin does not own.
 */
export async function sessionDirectory(id) {
  const root = dshHomePath('sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, id)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Not this project; keep looking.
    }
  }
  return undefined
}

/**
 * What a session's log directory weighs, and when it was last written.
 *
 * Both facts come from one scan, because the scan is the only thing here that
 * touches the filesystem per row and doing it twice for two numbers would be
 * silly. `updatedAt` is the newest modification time among the directory's
 * entries, which is when the session last recorded anything — the closest thing
 * to "last active" that is a plain stat.
 *
 * A projection could answer `lastPromptAt` instead, and it is the field the
 * sidebar itself sorts by, but it only exists for a session the projection cache
 * has a row for, and a cold read of the rest costs a whole log per row. The log
 * file's own mtime is always there, needs no parsing, and moves for the same
 * reason the projection does.
 *
 * @returns {Promise<{ sizeBytes?: number, updatedAt?: number }>} empty when the directory is gone.
 */
async function directoryFacts(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    let sizeBytes = 0
    let updatedAt = 0
    for (const entry of entries) {
      try {
        const info = await stat(join(path, entry.name))
        sizeBytes += info.size
        if (info.mtimeMs > updatedAt) updatedAt = info.mtimeMs
      } catch {
        // A file that vanished mid-scan contributes nothing.
      }
    }
    return { sizeBytes, updatedAt: updatedAt > 0 ? updatedAt : undefined }
  } catch {
    return {}
  }
}

/** Headers by session id, from session persistence. One scan for every id. */
async function headerIndex(persistence) {
  const index = new Map()
  if (persistence === undefined || typeof persistence.list !== 'function') return index
  try {
    for (const snapshot of await persistence.list()) {
      const header = snapshot?.header
      if (header !== undefined && header !== null && typeof header.id === 'string') index.set(header.id, header)
    }
  } catch {
    // A listing failure costs titles and dates, not the archive set itself.
  }
  return index
}

/**
 * Ids that are archived but have no log left on disk: the ones this panel has
 * deleted.
 *
 * They stay in the archive set on purpose, and that is the only way the sidebar
 * can be told to hide them. Core's one switch for "do not show this session" is
 * the archive set — `sessionVisible` consults it on every render — and deleting
 * a session is not something core can express at all. Once the log is gone the
 * id would otherwise fall out of its workspace and into the browser's
 * Ungrouped bucket, as a group with nothing in it that survives until the page
 * is reloaded.
 *
 * So the id is kept as a tombstone: the sidebar hides it immediately and after
 * every reload, and this panel drops it from its own list because there is
 * nothing left to show or act on.
 */
export async function tombstonedIds(deps, ids) {
  const gone = new Set()
  await Promise.all(ids.map(async (id) => {
    if ((await sessionDirectory(id)) === undefined) gone.add(id)
  }))
  return gone
}

/**
 * Whether the sessions root can be listed at all.
 *
 * `sessionDirectory` answers undefined both for "this session has no log" and
 * for "the root could not be read", and the two must not be confused where the
 * answer decides to throw a session away: a root that is momentarily
 * unlistable would otherwise read as a machine on which nothing was ever
 * recorded, and every tombstone would be dropped.
 */
async function sessionsRootReadable() {
  try {
    await readdir(dshHomePath('sessions'))
    return true
  } catch {
    return false
  }
}

/**
 * Forget the tombstones whose session is gone for good.
 *
 * A tombstone — an archived id with no log left — is what keeps a deleted
 * session out of the sidebar, and it has to stay for as long as the app runs:
 * the browser holds the deleted row in its session list until the next reload,
 * and the archive set is core's only way to hide a row. Dropping the entry
 * early is exactly what makes a deleted session come back as a stray in
 * Ungrouped.
 *
 * At *load* that has stopped being true. The host has just scanned its
 * sessions off disk, the deleted id is not in that catalog, and every client
 * connecting from here on builds its list from the same scan. The entry can no
 * longer hide anything — and DSH 0.1.7 gave the sidebar an archived filter
 * ("show archived", "only archived"), under which the leftovers render as an
 * Ungrouped group of rows that have no log left to delete, so there is nothing
 * to click either. They are dropped once, here, where it costs nothing.
 *
 * Anything still holding a log is kept, and so is everything when the sessions
 * root cannot be read: only a readable root is evidence of a deletion.
 *
 * @returns {Promise<{ ok: true, removed: number, kept: number }|{ ok: false, error: string, message: string }>}
 */
export async function forgetDeletedSessions(deps) {
  const ids = archivedIds(deps.registry)
  if (ids === undefined) {
    return {
      ok: false,
      error: 'no-registry',
      message: 'no workspace registry in this composition, so nothing records what is archived',
    }
  }
  if (ids.length === 0) return { ok: true, removed: 0, kept: 0 }
  const registry = registryWriter(deps.registry)
  if (registry === undefined) {
    return {
      ok: false,
      error: 'no-registry',
      message: 'this DSH build does not expose the workspace registry shape this needs, so nothing was changed',
    }
  }
  if (!(await sessionsRootReadable())) {
    return {
      ok: false,
      error: 'unreadable-sessions-root',
      message: 'the sessions root could not be listed, which is not evidence that any session is gone',
    }
  }
  const gone = await tombstonedIds(deps, ids)
  if (gone.size === 0) return { ok: true, removed: 0, kept: ids.length }
  let removed = 0
  // The same queue-and-`setState` pair `unarchiveSessions` writes through, for
  // the same reason: the queue keeps a concurrent archive from interleaving,
  // and `setState` is what makes the write durable *and* updates the in-memory
  // state the getter and the frame publisher both read.
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    const kept = state.archivedSessionIds.filter((id) => !gone.has(String(id)))
    removed = state.archivedSessionIds.length - kept.length
    if (removed === 0) return
    await registry.setState({ ...state, archivedSessionIds: kept })
    await syncArchiveRecord(deps, kept)
  })
  return { ok: true, removed, kept: ids.length - removed }
}

/**
 * The title a session's projections can answer without reading its log.
 *
 * This is the core's own resolution order, copied from `dsh-session-reference`
 * rather than invented: a live session answers from the live registry, a cold
 * one from the durable checkpoint the projection cache wrote. A session that
 * neither can answer for — one persisted before the cache existed, or seeded
 * straight to disk — is left without a title, and the panel labels it by id.
 * Folding a title from the log is deliberately not attempted: it costs the
 * whole log per session.
 */
function projectedTitle(deps, header) {
  if (header === undefined) return undefined
  const id = header.id
  const attached = typeof deps.sessions?.get === 'function' ? deps.sessions.get(id) : undefined
  const titleOf = (snapshot) => {
    const value = snapshot?.values?.title
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  if (attached !== undefined && typeof deps.projections?.snapshot === 'function') {
    return titleOf(deps.projections.snapshot(attached, ['title']))
  }
  if (header.isSeeded === true) return undefined
  if (typeof deps.cache?.cachedSnapshot !== 'function') return undefined
  try {
    return titleOf(deps.cache.cachedSnapshot(header, 0, ['title']))
  } catch {
    return undefined
  }
}

/**
 * The title to remember for one session: the projection's if it still has one,
 * otherwise the first thing the user asked, read out of the session's own log.
 *
 * @param {object} deps - the composition, as {@link projectedTitle} takes it.
 * @param {string|undefined} dir - the session's log directory.
 * @returns {Promise<string>} '' when nothing knows — which is worth recording.
 */
async function titleFromLogOrProjection(deps, header, dir) {
  const projected = projectedTitle(deps, header)
  if (projected !== undefined) return projected
  return logPromptTitle(dir)
}

/**
 * Record a title for every archived session the record does not have one for.
 *
 * The sidebar's title comes from a projection row, and a session that has been
 * archived is usually one whose projection is gone — which is why an archived
 * list that only has ids cannot say which session is which. So the title is
 * captured once, from whatever can still answer, and written down; from then on
 * the listing reads the record rather than a log.
 *
 * `''` is written when nothing could answer, and it means "looked at": a session
 * whose log holds no prompt is not read again on every listing.
 *
 * @returns {Promise<object>} the record, with the titles it now has.
 */
async function learnArchiveTitles(deps, ids, record, headers) {
  const titles = { ...(record.titles ?? {}) }
  let looked = 0
  let changed = false
  for (const raw of ids) {
    const id = String(raw)
    if (Object.prototype.hasOwnProperty.call(titles, id)) continue
    if (looked >= MAX_TITLE_LOOKUPS) break
    looked += 1
    titles[id] = await titleFromLogOrProjection(deps, headers.get(id), await sessionDirectory(id))
    changed = true
  }
  if (!changed) return record
  const next = { ...record, titles }
  try {
    await writeArchiveRecordFile(archiveRecordPath(), next)
  } catch {
    // The titles are a convenience over data DSH owns: a listing that cannot
    // write them still answers with them, and the next one writes again.
  }
  return next
}

/**
 * The first prompt of a session, read from its log.
 *
 * A v4 log is a sequence of independent zstd frames, one per append, and
 * `zstdDecompressSync` stops at the first frame — so the frames are decoded one
 * at a time, from the boundaries the magic bytes mark. Only the head of the file
 * is read and only the first frames are decoded, which makes this one small read
 * instead of one whole log per session. A file that is not frames at all (an
 * older log format, a build of node without zstd) simply answers ''.
 *
 * @param {string|undefined} dir - the session's log directory.
 * @returns {Promise<string>} the prompt, or '' when the log has none to give.
 */
async function logPromptTitle(dir) {
  if (dir === undefined || typeof zstdDecompressSync !== 'function') return ''
  const name = await logFileName(dir)
  if (name === undefined) return ''
  const head = await readLogHead(join(dir, name))
  if (head === undefined) return ''
  const text = name.endsWith('.zstd') ? decodeLogFrames(head) : head.toString('utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const prompt = promptOfEvent(event)
    if (prompt !== '') return prompt
  }
  return ''
}

/** Read a log file's head, as much of it as one lookup is allowed. */
async function readLogHead(path) {
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(LOG_PREFIX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, LOG_PREFIX_BYTES, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * A session log's decoded text, from the head of the newest log it has.
 *
 * @param {string} id - the session id.
 * @param {number} [limit] - how many frames to decode.
 * @returns {Promise<string>} the decoded text, or ''.
 */
async function logText(id, limit = LOG_FRAME_LIMIT) {
  const dir = await sessionDirectory(id)
  if (dir === undefined) return ''
  const name = await logFileName(dir)
  if (name === undefined) return ''
  const head = await readLogHead(join(dir, name))
  if (head === undefined) return ''
  return name.endsWith('.zstd') ? decodeLogFrames(head, limit) : head.toString('utf8')
}

/**
 * The worktree a session last moved into, read from its log.
 *
 * `cd <worktree parent>/<name>` is the one thing in a log that says a session
 * moved into a worktree: the tools take a repository as `workdir`, but the
 * command that does the work changes directory first. The last one wins — a
 * session that moved on is in the last place it went — and it only counts if
 * the directory is still there.
 *
 * @param {string} id - the session id.
 * @returns {Promise<string>} the worktree path, or ''.
 */
async function workingWorktreeOf(id) {
  // More frames than a title needs: the worktree can be cut late in a session.
  const text = await logText(id, LOG_FRAME_LIMIT * 16)
  if (text === '') return ''
  const paths = worktreePathsInText(text)
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    if (existsSync(paths[index])) return paths[index]
  }
  return ''
}

/** The log file inside a session directory: the newest jsonl log, compressed or not. */
async function logFileName(dir) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const compressed = entries.filter((name) => name.endsWith('.jsonl.zstd')).sort((a, b) => b.localeCompare(a))
  if (compressed.length > 0) return compressed[0]
  return entries.find((name) => name.endsWith('.jsonl'))
}

/** Decode a log's head frame by frame, up to `limit` of them. */
function decodeLogFrames(head, limit = LOG_FRAME_LIMIT) {
  const offsets = []
  for (let i = 0; i + 3 < head.length && offsets.length < limit; i += 1) {
    if (head[i] === LOG_FRAME_MAGIC[0] && head[i + 1] === LOG_FRAME_MAGIC[1] && head[i + 2] === LOG_FRAME_MAGIC[2] && head[i + 3] === LOG_FRAME_MAGIC[3]) {
      offsets.push(i)
      i += 3
    }
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : head.length
    let out
    try {
      out = zstdDecompressSync(head.subarray(start, end))
    } catch {
      // Magic bytes inside a payload are not a frame: the frame they belong to
      // still decodes from its own start, which is where the next candidate is.
      try {
        out = zstdDecompressSync(head.subarray(start))
      } catch {
        out = undefined
      }
    }
    if (out !== undefined) text += out.toString('utf8')
  }
  return text
}

/** The user's text in one log event, when the event is a prompt at all. */
function promptOfEvent(event) {
  if (event === null || typeof event !== 'object') return ''
  const data = event.data
  if (data === null || typeof data !== 'object') return ''
  let parts
  if (event.type === 'user/message') parts = data.content
  else if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) {
    parts = data.inserted.flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
  }
  if (!Array.isArray(parts)) return ''
  return normalizeTitle(parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join(' '))
}

/** One line, no runs of whitespace, short enough to be a label. */
function normalizeTitle(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat
}

/**
 * Every archived session, newest archive first.
 *
 * @returns {Promise<{ ok: true, records: object[], total: number, truncated: boolean, recordPath: string }|{ ok: false, error: string, message: string }>}
 */
export async function listArchived(deps) {
  const ids = archivedIds(deps.registry)
  if (ids === undefined) {
    return {
      ok: false,
      error: 'no-registry',
      message: 'no workspace registry in this composition, so nothing records what is archived',
    }
  }
  const { record } = await syncArchiveRecord(deps, ids)
  const headers = await headerIndex(deps.persistence)
  // Deleted sessions keep their archive entry as a tombstone, so they are still
  // in `ids` and have to be dropped here — there is nothing left to list.
  const gone = await tombstonedIds(deps, ids)
  const live = ids.filter((id) => !gone.has(id))
  // A title is recorded rather than derived on every listing: the projection that
  // names an active session is usually gone once it is archived, and the log read
  // that replaces it should happen once per session, not once per page view.
  const titled = await learnArchiveTitles(deps, live, record, headers)
  const rows = archiveRows(live, (id) => {
    const header = headers.get(id)
    return {
      title: projectedTitle(deps, header) ?? titled.titles?.[id],
      cwd: header?.cwd,
      createdAt: header?.createdAt,
      sizeBytes: undefined,
    }
  }, record)
  // Sizes and last-write times are filled in after the cap: only the rows that
  // will be shown pay for the directory scan, and a 500-row page is already 500
  // stats deep. One scan answers both.
  const shown = rows.slice(0, MAX_ARCHIVE_ROWS)
  await Promise.all(shown.map(async (row) => {
    const facts = await directoryFacts(await sessionDirectory(row.id))
    row.sizeBytes = facts.sizeBytes
    row.updatedAt = facts.updatedAt
  }))
  return {
    ok: true,
    records: shown,
    total: rows.length,
    truncated: rows.length > shown.length,
    recordPath: archiveRecordPath(),
  }
}

/** Guard the internal registry surface this module writes through. */
function registryWriter(registry) {
  if (registry === undefined || registry === null) return undefined
  for (const name of ['requireState', 'setState', 'enqueueOperation']) {
    if (typeof registry[name] !== 'function') return undefined
  }
  return registry
}

/**
 * Take sessions out of the archive, restoring them to the sidebar.
 *
 * Written through the registry's own serialized operation queue and its
 * `setState`, which is the pair `archiveSession` itself uses: the queue keeps a
 * concurrent archive from interleaving, and `setState` is what makes the write
 * durable *and* updates the in-memory state the getter and the frame publisher
 * both read. Writing the storage file directly would update neither.
 *
 * @returns {Promise<{ ok: true, unarchived: number }|{ ok: false, error: string, message: string }>}
 */
export async function unarchiveSessions(deps, ids) {
  const registry = registryWriter(deps.registry)
  if (registry === undefined) {
    return {
      ok: false,
      error: 'no-registry',
      message: 'this DSH build does not expose the workspace registry shape this needs, so nothing was changed',
    }
  }
  const wanted = new Set(ids.map(String))
  let unarchived = 0
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    const kept = state.archivedSessionIds.filter((id) => !wanted.has(String(id)))
    unarchived = state.archivedSessionIds.length - kept.length
    if (unarchived === 0) return
    await registry.setState({ ...state, archivedSessionIds: kept })
  })
  return { ok: true, unarchived }
}

/**
 * Whether a session still has an agent that is actually running it.
 *
 * This is NOT `sessions.get(id) !== undefined`, which is what it used to ask. A
 * session registry entry means "this process knows about this Session", and core
 * loads sessions into it for reasons that have nothing to do with running one:
 * the query service hydrates a cold session through `sessions.prepare` to read
 * its events, and the entry stays afterwards. So every session that had been
 * opened, previewed or read since the host started looked busy, and deletion was
 * refused for being "in use" while nothing was using it.
 *
 * The status that does mean this is the agent's own: `running` while a driver is
 * draining a turn, `idle` when no driver is active. A composition with no agents
 * service, or a session with no agent, is not running — the same fail-open the
 * market plugin uses, so a host that words this differently stays usable instead
 * of never deleting anything.
 *
 * @param {unknown} agents - the agents inventory, when the composition has one.
 * @param {string} id - the session id.
 * @returns {boolean}
 */
function agentIsRunning(agents, id) {
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return false
  let agent
  try {
    agent = agents.get(id)
  } catch {
    // A half-disposed registry must not block a deletion.
    return false
  }
  return agent !== undefined && agent !== null && agent.status === 'running'
}

/**
 * Delete sessions for good: the log, the cached projections and the workspace
 * membership.
 *
 * The archive entry is deliberately **kept**, which is the one counter-intuitive
 * part of this. Core's only switch for "do not show this Session" is the archive
 * set — `sessionVisible` consults it on every render — and core cannot express
 * "this session is gone" at all. So an id whose log is removed but which is left
 * unarchived falls out of its workspace and into the browser's Ungrouped bucket,
 * as an empty group that survives until the page is reloaded. Keeping the entry
 * makes the session stay hidden, immediately and after every reload, and the
 * panel drops these ids from its own listing because there is nothing left to
 * show.
 *
 * The workspace membership is dropped as well, which is not optional: a
 * membership pointing at a log that no longer exists is worse than a tombstone.
 *
 * Files go last. If a removal fails halfway the archive entry is already there —
 * the state is consistent, the session stays hidden, and the panel no longer
 * lists it — rather than a log that is gone while the sidebar still shows it.
 *
 * @returns {Promise<{ ok: true, deleted: string[], skipped: { id: string, reason: string }[] }|{ ok: false, error: string, message: string }>}
 */
export async function deleteSessions(deps, ids) {
  const registry = registryWriter(deps.registry)
  if (registry === undefined) {
    return {
      ok: false,
      error: 'no-registry',
      message: 'this DSH build does not expose the workspace registry shape this needs, so nothing was changed',
    }
  }
  const deleted = []
  const skipped = []
  for (const raw of ids) {
    const id = String(raw)
    if (agentIsRunning(deps.agents, id)) {
      skipped.push({ id, reason: 'live' })
      continue
    }
    deleted.push(id)
  }
  if (deleted.length === 0) return { ok: true, deleted, skipped }

  for (const id of deleted) {
    const directory = await sessionDirectory(id)
    if (directory !== undefined) {
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (error) {
        skipped.push({ id, reason: `log: ${String(error?.message ?? error)}` })
      }
    }
    // The cache row goes through its own table so the in-memory table and the
    // file agree; deleting the file alone would leave the service answering
    // from a row it still holds. A title that outlives its log is harmless, but
    // an orphan file per deleted session is not.
    try {
      const table = deps.cache?.requireTable?.()
      if (table !== undefined && typeof table.delete === 'function') table.delete(id)
    } catch {
      // A cache that refuses the delete costs an orphan file, not the log.
    }
    try {
      const owner = registry.list().find((workspace) => workspace.sessionIds.includes(id))
      if (owner !== undefined && typeof owner.detachSession === 'function') await owner.detachSession(id)
    } catch {
      // Detaching is tidiness; the tombstone is what keeps it hidden.
    }
  }
  return { ok: true, deleted, skipped }
}
