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
 * @module gord-dsh-worktree/archive
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Bumped only when the record's shape changes; an unreadable record is rebuilt. */
export const ARCHIVE_RECORD_VERSION = 1

/**
 * Rows returned to the panel. The archive set is unbounded — it only grows —
 * and every row costs a projection read, so the list is capped rather than
 * rendered at whatever size the history has reached.
 */
export const MAX_ARCHIVE_ROWS = 500

/** Where the archive times live. Plugin-owned, because DSH keeps none. */
export function archiveRecordPath() {
  return dshHomePath('gord-dsh-worktree', 'archived-at.json')
}

/** A record with nothing in it. */
export function emptyArchiveRecord() {
  return { version: ARCHIVE_RECORD_VERSION, archivedAt: {} }
}

/**
 * Parse a record file's text.
 *
 * Returns undefined for anything unusable — absent, truncated by a kill,
 * written by a different version — because the record is a convenience over
 * data DSH owns, and a broken one must degrade to "no times recorded" rather
 * than take the archive list down with it.
 *
 * @param {unknown} text - file contents.
 * @returns {{ version: number, archivedAt: Record<string, number|null> }|undefined}
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
  return { version: ARCHIVE_RECORD_VERSION, archivedAt }
}

/**
 * Bring the record in line with the ids that are actually archived.
 *
 * The map mirrors the current archive set rather than accumulating: an id that
 * is no longer archived is dropped, so archiving it again later records a fresh
 * time instead of resurrecting the old one.
 *
 * @param {{ archivedAt: Record<string, number|null> }|undefined} record - previous record.
 * @param {readonly string[]} ids - the ids currently archived.
 * @param {number} now - epoch ms stamped on ids this call has not seen before.
 * @param {boolean} [seed] - stamp every id as unknown instead. Used once, the
 *   first time this plugin ever sees an archive set: those sessions were
 *   archived by something that was not recording, and dating them `now` would
 *   report the install time as the archive time.
 * @returns {{ version: number, archivedAt: Record<string, number|null> }}
 */
export function reconcileArchiveRecord(record, ids, now, seed) {
  const before = record !== undefined && record !== null && typeof record.archivedAt === 'object' && record.archivedAt !== null
    ? record.archivedAt
    : {}
  const archivedAt = {}
  for (const raw of ids) {
    const id = String(raw)
    if (seed === true) archivedAt[id] = null
    else if (Object.prototype.hasOwnProperty.call(before, id)) archivedAt[id] = before[id]
    else archivedAt[id] = now
  }
  return { version: ARCHIVE_RECORD_VERSION, archivedAt }
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
 * @param {{ archivedAt: Record<string, number|null> }|undefined} record
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
  const rows = archiveRows(live, (id) => {
    const header = headers.get(id)
    return {
      title: projectedTitle(deps, header),
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
    const live = typeof deps.sessions?.get === 'function' ? deps.sessions.get(id) : undefined
    if (live !== undefined) {
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
