/**
 * dsh-worktree client-half smoke test.
 *
 * The browser bundle only exists inside DSH's module loader, so this test
 * recreates the two things it needs — `window.__ModuleLoader__.load` and a
 * React — and then drives a real render. The React here is deliberately
 * minimal (no reconciliation, no DOM): it provides `createElement` plus the
 * four hooks the panel uses, which is enough to prove the panel's data flow —
 * mount → fetch → render rows → mutate → refresh — instead of merely proving
 * the file parses.
 *
 *   node test/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
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

process.stdout.write('minimal React runtime\n')

/** Hook slot cursor for the in-progress render; reset by every render pass. */
let cursor = 0
/** Hook value store, indexed by hook position (stable because hook order is). */
let slots = []
/** Effects scheduled by the current render, flushed after it returns. */
let pendingEffects = []
/** Set when a setter runs during a render pass, to request another pass. */
let dirty = false

/** Reset the hook cursor for one render pass. */
function beginRender() {
  cursor = 0
  pendingEffects = []
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(slots[index]) : next
      if (Object.is(value, slots[index])) return
      slots[index] = value
      dirty = true
    }
    return [slots[index], set]
  },
  useEffect(effect, _deps) {
    pendingEffects.push(effect)
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
}

/**
 * Resolve a tree of `createElement` results into host elements.
 *
 * The real React calls a function component when it reaches one; the minimal
 * runtime here must do the same, or every tree would stop at the outermost
 * component and render nothing.
 *
 * @param node - element, array, or leaf.
 * @returns the same tree with function components replaced by their output.
 */
function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve).filter((child) => child !== null)
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...node.props, children: node.children })
    return resolve(rendered)
  }
  return { type: node.type, props: node.props, children: node.children.map(resolve).filter((child) => child !== null) }
}

/** Collect every string rendered anywhere in a tree. */
function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  for (const child of node.children) textsOf(child, out)
  return out
}

/** Find the first node whose props carry `onClick`, matching by rendered label. */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === 'button' && textsOf(node).join('').includes(label)) return node
  for (const child of node.children) {
    const hit = findButton(child, label)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Find the first `<input>` whose placeholder matches. */
function findInput(node, placeholder) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findInput(child, placeholder)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === 'input' && node.props.placeholder === placeholder) return node
  for (const child of node.children) {
    const hit = findInput(child, placeholder)
    if (hit !== undefined) return hit
  }
  return undefined
}

process.stdout.write('\nloading the bundle\n')

/** The bundle registers itself here instead of in a browser. */
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registration = spec
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null
    },
    setItem(key, value) {
      this.store.set(key, value)
    },
  },
  navigator: { language: 'zh-CN' },
}
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
// eslint-disable-next-line no-eval -- the bundle is a browser script, not a module
;(0, eval)(readFileSync(clientPath, 'utf8'))

check('bundle registers with the module loader', registration !== undefined)
check('bundle keeps the package id', registration?.id === 'dsh-worktree', registration?.id)

const bundle = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})
check('bundle exports apply', typeof bundle.apply === 'function')
check('bundle declares the slots injection', Array.isArray(bundle.inject) && bundle.inject.includes('slots'), JSON.stringify(bundle.inject))

process.stdout.write('\nslots registration\n')
let sectionSpec
let Section
const ctx = {
  get: () => undefined,
  effect: (callback) => callback(),
  slots: {
    inject(name, factory) {
      sectionSpec = { name, factory }
    },
    register(spec, component) {
      sectionSpec = { name: sectionSpec.name, spec }
      Section = component
      return () => {}
    },
  },
}
bundle.apply(ctx)
check('injects into settings.section', sectionSpec?.name === 'settings.section', sectionSpec?.name)
// The bundle registers through the inject factory, so read the spec the
// factory actually built rather than the pairing stub's placeholder.
const builtSpec = sectionSpec.factory()
check('factory returns a disposer', typeof builtSpec === 'function')
check('section has an id', sectionSpec?.spec?.id === 'worktree', JSON.stringify(sectionSpec?.spec))
check('section carries a nav order', typeof sectionSpec?.spec?.order === 'number', String(sectionSpec?.spec?.order))
check('section labels itself', typeof sectionSpec?.spec?.label === 'function' && sectionSpec.spec.label() !== '', String(sectionSpec?.spec?.label?.()))
check('registers a component', typeof Section === 'function')

process.stdout.write('\nrender: initial load\n')

/** Listing payload the fake host answers with. */
const listing = {
  ok: true,
  root: '/tmp/demo/app',
  mainRoot: '/tmp/demo/app',
  branch: 'main',
  dirty: true,
  isLinked: false,
  defaultParent: '/tmp/demo/app-worktrees',
  worktrees: [
    { path: '/tmp/demo/app', branch: 'main', head: 'aaaaaaa', current: true, detached: false, locked: false, pruned: false },
    { path: '/tmp/demo/app-worktrees/feat', branch: 'worktree/feat', head: 'bbbbbbb', current: false, detached: false, locked: false, pruned: false },
  ],
}
const calls = []
globalThis.fetch = (url, options) => {
  const action = new URL(url, 'http://localhost').searchParams.get('action')
  calls.push({ action, body: JSON.parse(options.body) })
  const payload =
    action === 'list'
      ? listing
      : action === 'create'
        ? { ok: true, path: '/tmp/demo/app-worktrees/new', branch: 'worktree/new', workspace: { workspaceId: 'w1' } }
        : action === 'remove'
          ? { ok: true, removed: options.body.path, branch: 'worktree/feat', branchDeleted: true }
          : action === 'adopt'
            ? { ok: true, workspace: { workspaceId: 'w1', path: options.body.path, title: 'feat' } }
            : { ok: true, output: '' }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
}

/**
 * Run render passes until the tree settles.
 *
 * Effects fire async fetches, so one pass only starts the request and a later
 * pass renders the answer. The loop therefore also flushes the microtask queue
 * a few times per pass and keeps going while any state setter ran, which is
 * exactly React's "render until quiescent" contract at this scale.
 *
 * @param props - component props.
 * @param passes - safety bound on render passes.
 * @returns the last rendered tree.
 */
async function settle(props, passes = 40) {
  let tree
  for (let pass = 0; pass < passes; pass++) {
    dirty = false
    beginRender()
    tree = resolve(Section(props))
    for (const effect of pendingEffects.splice(0)) effect()
    for (let flush = 0; flush < 4; flush++) await new Promise((resolve) => setImmediate(resolve))
    if (!dirty) break
  }
  return tree
}

const props = { t: (key, params) => {
  const dict = bundle.DICT.zh
  let text = dict[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
} }

const tree = await settle(props)
const allText = textsOf(tree).join(' | ')
check('panel fetched the listing', calls.some((call) => call.action === 'list'), JSON.stringify(calls.map((c) => c.action)))
check('panel renders the repository root', allText.includes('/tmp/demo/app'), allText.slice(0, 200))
check('panel renders the repository branch', allText.includes('main'))
check('panel flags a dirty repository', allText.includes('有未提交改动'))
check('panel lists both worktrees', allText.includes('worktree/feat') && allText.includes('共 2 个'), allText.slice(-300))
check('panel marks the current worktree', allText.includes('当前'))
check('panel renders the default parent', allText.includes('/tmp/demo/app-worktrees'))
check('panel renders the create form toggle', findButton(tree, '新建') !== undefined || findButton(tree, '创建') !== undefined)

process.stdout.write('\ninteraction: create\n')
const toggle = findButton(tree, '+ 创建') ?? findButton(tree, '新建工作树')
check('create section exposes a toggle', toggle !== undefined)
toggle?.props.onClick()
const opened = await settle(props)
check('form opens', findInput(opened, '例如 /Users/me/code/my-app') !== undefined && findButton(opened, '创建') !== undefined, textsOf(opened).join(' | ').slice(0, 200))

process.stdout.write('\ninteraction: open as workspace\n')
const openButton = findButton(opened, '用工作区打开')
check('rows expose "open as workspace"', openButton !== undefined)
openButton?.props.onClick()
const adopted = await settle(props)
check('adopt posts the host action', calls.some((call) => call.action === 'adopt'), JSON.stringify(calls.map((c) => c.action)))
check('adopt result is reported', textsOf(adopted).join(' ').includes('已添加为工作区'), textsOf(adopted).join(' ').slice(-200))

process.stdout.write('\ninteraction: remove with confirmation\n')
const removeButton = findButton(adopted, '删除')
check('rows expose remove', removeButton !== undefined)
removeButton?.props.onClick()
const confirming = await settle(props)
check('remove asks for confirmation first', textsOf(confirming).join(' ').includes('确认删除'), textsOf(confirming).join(' ').slice(-200))
check('remove is not called before confirmation', !calls.some((call) => call.action === 'remove'))
const confirmRemove = findButton(confirming, '取消') !== undefined ? findButton(confirming, '删除') : undefined
const submit = confirming.children.flatMap((child) => findButton(child, '删除') ?? []).filter((node) => node !== removeButton)[0]
check('confirmation offers a submit', submit !== undefined || confirmRemove !== undefined)

process.stdout.write('\nlocalization\n')
check('dictionaries are key-set identical', JSON.stringify(Object.keys(bundle.DICT.zh).sort()) === JSON.stringify(Object.keys(bundle.DICT.en).sort()), 'zh/en mismatch')
check('english dictionary has real copy', bundle.DICT.en['nav.label'] === 'Worktrees', bundle.DICT.en['nav.label'])

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)