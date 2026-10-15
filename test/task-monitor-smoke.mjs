/** Task tray lifecycle and UI tests. No host requests or Session hydration. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'

let checks = 0
let failures = 0
async function check(label, run) {
  checks++
  try { await run(); process.stdout.write(`ok   ${label}\n`) }
  catch (error) { failures++; process.stdout.write(`FAIL ${label}\n${error.stack}\n`) }
}
function source(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: (next) => { value = next; for (const fn of [...listeners]) fn() },
    listeners,
  }
}
let now = 0
let nextTimer = 0
const timers = new Map()
const schedule = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id }
function advance(ms) {
  now += ms
  let count = 0
  for (;;) {
    const due = [...timers].find(([, timer]) => timer.at <= now)
    if (!due) return
    assert.ok(++count < 100, 'timer loop')
    timers.delete(due[0]); due[1].fn()
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const storage = new Map()
const eventListeners = new Map()
function addEventListener(type, fn) {
  if (!eventListeners.has(type)) eventListeners.set(type, new Set())
  eventListeners.get(type).add(fn)
}
function removeEventListener(type, fn) { eventListeners.get(type)?.delete(fn) }
const observers = []
class Observer {
  constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
  observe() { this.disconnected = false }
  disconnect() { this.disconnected = true }
}
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top })
let chatRect = rect(250, 50, 1100, 800)
let railRect = rect(1060, 150, 1088, 300)
let composerRect = rect(250, 650, 1100, 800)
const composer = { getBoundingClientRect: () => composerRect }
const rail = { getBoundingClientRect: () => railRect, querySelector: () => ({}) }
const chat = {
  getBoundingClientRect: () => chatRect,
  querySelector: () => composer,
  querySelectorAll: () => [rail],
}
const browser = {
  innerWidth: 1400, innerHeight: 850,
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener, removeEventListener,
  requestAnimationFrame: (fn) => schedule(fn, 16), cancelAnimationFrame: (id) => timers.delete(id),
}
const document = { body: {}, querySelector: () => chat, addEventListener, removeEventListener,
  createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }

let hooks = [], cursor = 0, effects = [], dirty = false
const cleanups = new Map()
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter((child) => child !== null && child !== false && child !== undefined) }),
  useState(initial) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      const next = typeof value === 'function' ? value(hooks[index]) : value
      if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true }
    }]
  },
  useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial } },
  useEffect(fn, deps) {
    const index = cursor++
    const changed = !hooks[index] || deps.some((value, i) => !Object.is(value, hooks[index][i]))
    if (changed) {
      cleanups.get(index)?.(); cleanups.delete(index)
      hooks[index] = deps
      effects.push(() => { const stop = fn(); if (stop) cleanups.set(index, stop) })
    }
  },
}
let registration
browser.__ModuleLoader__ = { load: (value) => { registration = value } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: browser, document, navigator: { language: 'zh' }, ResizeObserver: Observer, MutationObserver: Observer,
  setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
})
const bundle = registration.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(name)
})
const list = source({ phase: 'ready', byId: {
  run: { title: 'Run task', running: true, cwd: '/repo/project' },
  done: { title: 'Ended task', running: false, cwd: '/repo/project' },
  wait: { title: 'Approval task', running: false },
  idle: { title: 'Old history', running: false, updatedAt: 999999 },
  blank: { blank: true, running: true },
  child: { running: true, parentId: 'run', origin: 'subagent' },
  archived: { running: true },
} })
const statuses = source(new Map([
  ['run', { running: true }], ['done', { running: false, completionUnread: true }],
  ['wait', { pendingInteraction: { key: 'approval-1', kind: 'approval' } }],
]))
const current = source({ key: 'other' })
const workspaces = source({ phase: 'ready', archivedSessionIds: ['archived'], items: [{ path: '/repo/project', title: 'My project' }] })
let navigation = (id) => current.set({ key: id })
let navigated = []
const sessions = { list, retain() { throw new Error('must not retain Session content') } }
const uiSession = { sessionStatus: statuses, adapter: { current } }
const store = bundle.createTaskMonitorStore(sessions, uiSession, { openSession: (id) => { navigated.push(id); return navigation(id) } })
store.start(); store.start(); store.setWorkspaces({ list: workspaces })
const rows = () => store.getSnapshot().rows
const find = (id) => rows().find((row) => row.id === id)
function status(id, value) { const next = new Map(statuses.getSnapshot()); next.set(id, value); statuses.set(next) }

await check('projects, priority and filters use only existing summaries', () => {
  assert.equal(rows().map((row) => row.id).join(','), 'wait,done,run')
  assert.equal(find('run').project, 'My project')
  assert.equal(find('done').phase, 'done')
})
await check('manual forks remain visible as independent tasks despite their lineage', () => {
  const before = list.getSnapshot()
  list.set({ ...before, byId: { ...before.byId, fork: { parentId: 'run', running: true, title: 'Manual fork' } } })
  assert.equal(find('fork').phase, 'running')
  list.set(before)
})
await check('one subscription per source, with no timer polling', () => {
  for (const src of [list, statuses, current, workspaces]) assert.equal(src.listeners.size, 1)
  assert.equal(timers.size, 0)
})
await check('an optional workspace service without a catalog cannot disable task navigation', () => {
  store.setWorkspaces({})
  assert.equal(store.getSnapshot().unavailable, false)
  assert.equal(find('run').project, 'project')
  store.setWorkspaces({ list: workspaces })
  assert.equal(find('run').project, 'My project')
})
await check('token-stream timestamp changes do not publish new tray snapshots', () => {
  const before = store.getSnapshot()
  list.set({ ...list.getSnapshot(), byId: { ...list.getSnapshot().byId, run: { ...list.getSnapshot().byId.run, updatedAt: 12345 } } })
  assert.equal(store.getSnapshot(), before)
})
await check('a failed open keeps the notification and never creates a chat', async () => {
  navigation = () => { throw new Error('writer unavailable') }
  const row = find('done')
  await assert.rejects(store.open(row.id, row.token), /writer unavailable/)
  assert.ok(find('done'))
})
await check('clicking a running chat dismisses this run even after switching away', async () => {
  navigation = (id) => current.set({ key: id })
  const row = find('run')
  await store.open(row.id, row.token)
  assert.equal(navigated.at(-1), 'run')
  current.set({ key: 'other' })
  assert.equal(find('run'), undefined)
})
await check('a dismissed run ending in the background reappears as unseen', () => {
  status('run', { running: false, completionUnread: true })
  assert.equal(find('run').phase, 'done')
})
await check('new work in the same chat is eligible again', () => {
  status('run', { running: true, completionUnread: false })
  assert.equal(find('run').phase, 'running')
})
await check('opening through the ordinary sidebar also acknowledges a reminder', () => {
  current.set({ key: 'done' }); current.set({ key: 'other' })
  assert.equal(find('done'), undefined)
})
await check('a replacement approval gets a new attention identity', async () => {
  const old = find('wait')
  await store.open(old.id, old.token)
  current.set({ key: 'other' })
  assert.equal(find('wait'), undefined)
  status('wait', { pendingInteraction: { key: 'approval-2', kind: 'approval' } })
  assert.ok(find('wait'))
  const before = navigated.length
  await assert.rejects(store.open(old.id, old.token), /changed/)
  assert.equal(navigated.length, before)
})
await check('titles refresh without loading conversation content', () => {
  list.set({ ...list.getSnapshot(), byId: { ...list.getSnapshot().byId, run: { ...list.getSnapshot().byId.run, title: 'Renamed task' } } })
  assert.equal(find('run').title, 'Renamed task')
})
await check('archived sessions disappear immediately', () => {
  workspaces.set({ ...workspaces.getSnapshot(), archivedSessionIds: ['archived', 'run'] })
  assert.equal(find('run'), undefined)
})
await check('catalog errors keep stale results visible but prevent navigation', async () => {
  list.set({ ...list.getSnapshot(), phase: 'error' })
  assert.equal(store.getSnapshot().unavailable, true)
  const row = find('wait')
  await assert.rejects(store.open(row.id, row.token), /changed/)
  list.set({ ...list.getSnapshot(), phase: 'ready' })
})
await check('navigation must actually select the target before resolving', async () => {
  navigation = () => undefined
  const row = find('wait')
  let completed = false
  const pending = store.open(row.id, row.token).then(() => { completed = true })
  await flush()
  assert.equal(completed, false)
  assert.ok(find('wait'))
  current.set({ key: 'wait' })
  await pending
  assert.equal(completed, true)
  assert.equal(timers.size, 0)
  current.set({ key: 'other' })
})
await check('a navigation that selects nothing times out without dismissing', async () => {
  status('wait', { pendingInteraction: { key: 'approval-3', kind: 'approval' } })
  const row = find('wait')
  const pending = store.open(row.id, row.token)
  const rejected = assert.rejects(pending, /did not select/)
  await flush(); advance(5000); await rejected
  assert.ok(find('wait'))
})

await check('default position is twelve pixels below the native turn index', () => {
  const p = bundle.taskMonitorPosition({ width: 1400, height: 850 }, chatRect, railRect, composerRect, null)
  assert.equal(p.y, railRect.bottom + 12)
  assert.ok(p.x + 38 < chatRect.right)
  assert.ok(p.y + 38 < composerRect.top)
})
await check('a long rail falls back beside the index instead of covering it', () => {
  const longRail = rect(1060, 80, 1088, 630)
  const p = bundle.taskMonitorPosition({ width: 1400, height: 850 }, chatRect, longRail, composerRect, null)
  assert.ok(p.x + 38 < longRail.left)
  assert.ok(p.y + 38 < composerRect.top)
})
await check('saved ratios stay inside the resized chat area and above the composer', () => {
  const p = bundle.taskMonitorPosition({ width: 700, height: 500 }, rect(80, 40, 650, 480), null, rect(80, 350, 650, 480), { x: 1, y: 1 })
  assert.ok(p.x + 38 < 650 && p.y + 38 < 350)
})

const uiData = source({ rows: Array.from({ length: 25 }, (_, i) => ({ id: 'ui-' + i, title: 'Task ' + i, phase: i % 2 ? 'running' : 'done', token: 't-' + i, project: 'Project' })), unavailable: false })
let uiFailure = false
const uiStore = { ...uiData, open: async () => { if (uiFailure) throw new Error('open denied') } }
const props = { store: uiStore }
function render() {
  let tree
  for (let i = 0; i < 20; i++) {
    dirty = false; cursor = 0; effects = []
    tree = bundle.TaskMonitor(props)
    for (const run of effects) run()
    if (!dirty) return tree
  }
  throw new Error('render loop')
}
const all = (node, predicate) => !node || typeof node !== 'object' ? [] : [
  ...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => all(child, predicate)),
]
const part = (tree, key) => all(tree, (node) => node.props[key])[0]
let tree = render()
await check('collapsed UI has only a trigger and no task row DOM', () => {
  assert.ok(part(tree, 'data-task-monitor-trigger'))
  assert.equal(all(tree, (node) => node.props['data-task-row']).length, 0)
})
await check('hover opens a bounded page of tasks to the left of the button', () => {
  tree.props.onPointerEnter(); tree = render()
  assert.equal(all(tree, (node) => node.props['data-task-row']).length, 20)
  assert.ok(part(tree, 'data-task-panel').props.style.left < tree.props.style.left)
  const panel = part(tree, 'data-task-panel').props.style
  assert.ok(panel.top + panel.maxHeight < composerRect.top)
})
await check('pagination makes later tasks reachable without mounting every row', () => {
  const text = (node) => typeof node === 'string' ? node : (node.children || []).map(text).join('')
  all(tree, (node) => node.type === 'button' && text(node) === '下一页')[0].props.onClick()
  tree = render()
  assert.equal(all(tree, (node) => node.props['data-task-row']).length, 5)
  assert.equal(part(tree, 'data-task-row').props['data-task-row'], 'ui-20')
  all(tree, (node) => node.type === 'button' && text(node) === '上一页')[0].props.onClick()
  tree = render()
})
await check('moving between trigger and panel cancels the delayed close', () => {
  tree.props.onPointerLeave(); advance(100); tree.props.onPointerEnter(); advance(200); tree = render()
  assert.ok(part(tree, 'data-task-panel'))
})
await check('leaving the combined area closes after 200ms', () => {
  tree.props.onPointerLeave(); advance(199); tree = render(); assert.ok(part(tree, 'data-task-panel'))
  advance(1); tree = render(); assert.equal(part(tree, 'data-task-panel'), undefined)
})
await check('keyboard focus opens and Escape closes the panel', () => {
  tree.props.onFocus(); tree = render(); assert.ok(part(tree, 'data-task-panel'))
  tree.props.onKeyDown({ key: 'Escape', stopPropagation() {} }); tree = render()
  assert.equal(part(tree, 'data-task-panel'), undefined)
})
await check('failed row navigation stays visible with an error', async () => {
  tree.props.onPointerEnter(); tree = render(); uiFailure = true
  part(tree, 'data-task-row').props.onClick(); await flush(); tree = render()
  assert.ok(part(tree, 'data-task-panel'))
  assert.equal(all(tree, (node) => node.props.role === 'alert').length, 1)
})
await check('successful row navigation closes the details', async () => {
  uiFailure = false
  part(tree, 'data-task-row').props.onClick(); await flush(); tree = render()
  assert.equal(part(tree, 'data-task-panel'), undefined)
})
await check('dragging saves ratios without opening the tray on release', () => {
  const trigger = part(tree, 'data-task-monitor-trigger')
  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} }
  const event = { button: 0, pointerId: 1, clientX: 1070, clientY: 312, currentTarget: target }
  trigger.props.onPointerDown(event)
  trigger.props.onPointerMove({ ...event, clientX: 1000, clientY: 380 })
  trigger.props.onPointerUp(event)
  trigger.props.onClick(); tree = render()
  const saved = JSON.parse(storage.get('gord-worktree:task-monitor-position'))
  assert.ok(saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1)
  assert.equal(part(tree, 'data-task-panel'), undefined)
})
await check('reset returns the tray to its native index anchor', () => {
  tree.props.onPointerEnter(); tree = render()
  all(tree, (node) => node.props['aria-label'] === '恢复索引下方的位置')[0].props.onClick()
  advance(16); tree = render()
  assert.equal(tree.props.style.top, railRect.bottom + 12)
  assert.equal(storage.has('gord-worktree:task-monitor-position'), false)
})
await check('no tasks hides the UI and releases every geometry observer', () => {
  uiData.set({ rows: [], unavailable: false }); tree = render()
  assert.equal(tree, null)
  assert.ok(observers.every((observer) => observer.disconnected))
})
await check('unmount cancels hover timers and UI subscriptions', () => {
  for (const stop of cleanups.values()) stop()
  cleanups.clear()
  assert.equal(uiData.listeners.size, 0)
  assert.equal(timers.size, 0)
  for (const listeners of eventListeners.values()) assert.equal(listeners.size, 0)
})
await check('disposing cancels pending selection waits and all source subscriptions', async () => {
  const row = find('wait')
  const pending = store.open(row.id, row.token)
  const rejected = assert.rejects(pending, /cancelled/)
  await flush(); store.dispose(); store.dispose(); await rejected
  for (const src of [list, statuses, current, workspaces]) assert.equal(src.listeners.size, 0)
  assert.equal(timers.size, 0)
  assert.equal(store.getSnapshot().rows.length, 0)
})

await check('real Cordis injection registers one global overlay and disposes its subscriptions', async () => {
  const registered = []
  const root = new Context()
  root.plugin({ apply(ctx) {
    ctx.provide('locale', { register: () => () => {}, bind: () => (key) => key })
    ctx.provide('sessions', sessions)
    ctx.provide('uiSession', uiSession)
    ctx.provide('uiWorkspace', { openSession() {} })
    ctx.provide('workspaces', { list: workspaces })
    ctx.provide('slots', {
      inject: (_name, factory) => factory(),
      register: (spec, component) => { registered.push({ spec, component }); return () => {} },
    })
  } })
  const mounted = root.plugin({ inject: bundle.inject, apply: bundle.apply })
  await flush()
  const overlays = registered.filter(({ spec }) => spec.name === 'shell.overlay')
  assert.equal(overlays.length, 1)
  assert.equal(overlays[0].spec.id, 'gord-task-monitor')
  assert.equal(overlays[0].component().type, bundle.TaskMonitor)
  assert.equal(statuses.listeners.size, 1)
  assert.equal(current.listeners.size, 1)
  for (const src of [list, workspaces]) assert.ok(src.listeners.size >= 1)
  await mounted.dispose()
  for (const src of [list, statuses, current, workspaces]) assert.equal(src.listeners.size, 0)
  registered.length = 0
  const nativeStatus = uiSession.sessionStatus
  uiSession.sessionStatus = undefined
  const legacy = root.plugin({ inject: bundle.inject, apply: bundle.apply })
  try {
    await flush()
    assert.equal(registered.filter(({ spec }) => spec.name === 'shell.overlay').length, 0)
  } finally { await legacy.dispose(); uiSession.sessionStatus = nativeStatus }
})

await check('a large idle catalog and repeated mounts keep only active summary subscriptions', () => {
  const summaries = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['idle-' + i, { title: 'History ' + i, running: false }]).concat([
    ['active', { title: 'Active', running: true }], ['ended', { title: 'Ended', running: false }],
  ]))
  let summaryReads = 0
  const many = source({ phase: 'ready', ids: Object.keys(summaries), byId: new Proxy(summaries, { get(target, key) { summaryReads++; return target[key] } }) })
  const states = source(new Map([['active', { running: true }], ['ended', { completionUnread: true }]]))
  const selected = source({ key: 'other' })
  for (let i = 0; i < 25; i++) {
    const monitor = bundle.createTaskMonitorStore({ list: many, retain() { throw new Error('unexpected hydration') } },
      { sessionStatus: states, adapter: { current: selected } }, {})
    monitor.start()
    assert.equal(monitor.getSnapshot().rows.length, 2)
    const stable = monitor.getSnapshot()
    summaryReads = 0
    many.set({ ...many.getSnapshot() })
    assert.equal(monitor.getSnapshot(), stable)
    assert.ok(summaryReads <= 2, 'stream-only updates must not rescan idle history')
    monitor.dispose()
    for (const src of [many, states, selected]) assert.equal(src.listeners.size, 0)
  }
  assert.equal(timers.size, 0)
})

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exitCode = failures ? 1 : 0
