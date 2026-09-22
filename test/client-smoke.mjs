/**
 * gord-dsh-worktree client-half smoke test.
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
import { Context } from '@deepseek-ai/cordis'

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
/** Cleanup returned by each effect, keyed by hook position. */
let cleanups = {}
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
  useEffect(effect, deps) {
    // Deps are honoured: the chip keys its loader on `open`, and an
    // unconditional flush would re-run it every pass and never settle. A
    // cleanup belongs to its own effect and runs only when that effect is
    // about to re-run — running it on every render would tear down the mount
    // effect immediately and the component would never see its own fetch.
    const index = cursor++
    const previous = slots[index]
    const changed = previous === undefined || deps === undefined || deps.some((dep, i) => !Object.is(dep, previous[i]))
    if (!changed) return
    slots[index] = deps
    if (typeof cleanups[index] === 'function') {
      cleanups[index]()
      delete cleanups[index]
    }
    pendingEffects.push(() => {
      const result = effect()
      if (typeof result === 'function') cleanups[index] = result
    })
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
  const element = { type: node.type, props: node.props, children: node.children.map(resolve).filter((child) => child !== null) }
  // React attaches refs to host elements at commit time; without this the
  // chip's containment check would always see a null ref and the dismissal
  // paths could not be tested at all. The stub answers `contains` from the
  // marker the test puts on the event target.
  const ref = node.props?.ref
  if (ref !== null && typeof ref === 'object' && 'current' in ref) {
    ref.current = { contains: (target) => target?.insideControl === true }
  }
  return element
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

/** Every option row in a rendered menu, in document order. */
function findOptions(node) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (typeof current.props?.className === 'string' && current.props.className.includes('gord-dsh-worktree-option')) found.push(current)
    current.children.forEach(walk)
  }
  walk(node)
  return found
}

/** Find the first node whose className contains `needle`. */
function findByClass(node, needle) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, needle)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes(needle)) return node
  for (const child of node.children) {
    const hit = findByClass(child, needle)
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

/** The first `<select>` in a rendered tree. */
function findSelect(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findSelect(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node.type === 'select') return node
  for (const child of node.children) {
    const hit = findSelect(child)
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
// The chip registers dismissal listeners on `document`; the stub records them
// so a test can fire the same events the browser would.
const documentListeners = new Map()
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    documentListeners.get(type)?.delete(handler)
  },
}
const fireDocument = (type, event) => {
  for (const handler of documentListeners.get(type) ?? []) handler(event)
}

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
// eslint-disable-next-line no-eval -- the bundle is a browser script, not a module
;(0, eval)(readFileSync(clientPath, 'utf8'))

check('bundle registers with the module loader', registration !== undefined)
check('bundle keeps the package id', registration?.id === 'gord-dsh-worktree', registration?.id)

// `createPortal` is what puts the picker onto the Hero row; the stub records
// where it was asked to render so the placement can be asserted.
const portalCalls = []
const ReactDOM = {
  createPortal(node, container) {
    portalCalls.push(container)
    return node
  },
}
// The icon package the two neighbouring controls use; the stub only needs
// something renderable, since the shipping markup is compared live.
const icon = (props) => ({ type: 'Icon', props: props ?? {}, children: [] })
const primitives = {
  IconBranchOutline16: icon,
  IconChevronDownOutline14: icon,
}
const bundle = registration.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})
check('bundle exports apply', typeof bundle.apply === 'function')
check('bundle declares the slots injection', Array.isArray(bundle.inject) && bundle.inject.includes('slots'), JSON.stringify(bundle.inject))
// The icon package is resolved through the boot graph's inject list, so a
// missing declaration means `require` throws at load and nothing renders.
check(
  'bundle declares the icon package it requires',
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'),
  JSON.stringify(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dsh.client.inject),
)

process.stdout.write('\nslots registration\n')
let sectionSpec
let Section
let chipSpec
let Chip
// A real cordis context, with both services provided by sibling plugin fibers —
// the same topology the client shell uses. This is not decoration: reaching an
// un-injected service as a property only throws when its provider is a sibling
// rather than an ancestor, so a stub that answers every lookup hides exactly
// the bug that blanked the Settings page.
const root = new Context()
const registeredDicts = []
/** `sessions.create` calls the chip makes, in order. */
const createdSessions = []
/** Session ids the chip asked the controller to select. */
const openedSessions = []
/** Session list snapshot the fake `sessions` service answers with. */
const sessionList = {
  current: 's1',
  byId: { s1: { id: 's1', cwd: '/tmp/demo/app', blank: true } },
}
root.plugin({
  name: 'test:services',
  apply(serviceCtx) {
    serviceCtx.provide('locale', {
      register(ns, dicts) {
        registeredDicts.push({ ns, dicts })
        return () => {}
      },
      bind(ns) {
        // Resolve the real dictionary *and* interpolate, exactly as the locale
        // service does: the slot's own wrapper supplies this translator to the
        // component, so a non-interpolating stand-in would leave `{path}` and
        // `{branch}` unexpanded and hide whether the component renders right.
        return (key, params) => {
          let text = bundle.DICT.zh[key] ?? `${ns}:${key}`
          for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
          return text
        }
      },
    })
    serviceCtx.provide('sessions', {
      list: {
        getSnapshot: () => sessionList,
        subscribe: () => () => {},
      },
      // The real contract is `Promise<SessionId>` — a bare string. Returning a
      // result object here is exactly the mistake that let a broken unwrap
      // pass the suite while failing in the browser.
      create: (opts) => {
        const sessionId = `new-${createdSessions.length + 1}`
        createdSessions.push({ cwd: opts.cwd, workspaceId: opts.workspaceId, sessionId })
        return Promise.resolve(sessionId)
      },
      open: (id) => {
        openedSessions.push(id)
      },
    })
    serviceCtx.provide('slots', {
      inject(name, factory) {
        if (name === 'conversation.input.dock') chipSpec = { name, factory }
        else sectionSpec = { name, factory }
        return factory()
      },
      register(spec, component) {
        if (spec.name === 'conversation.input.dock') {
          chipSpec = { ...chipSpec, spec }
          Chip = component
        } else {
          sectionSpec = { ...sectionSpec, spec }
          Section = component
        }
        return () => {}
      },
    })
  },
})

check('bundle declares the locale injection', Array.isArray(bundle.inject) && bundle.inject.includes('locale'), JSON.stringify(bundle.inject))
root.plugin({ name: 'gord-dsh-worktree', inject: bundle.inject, apply: bundle.apply })
// A plugin that injects waits for its services, so `apply` lands a tick later.
for (let tick = 0; tick < 20 && typeof Section !== 'function'; tick++) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

check('injects into settings.section', sectionSpec?.name === 'settings.section', sectionSpec?.name)
check('registers a component', typeof Section === 'function')
check('section has an id', sectionSpec?.spec?.id === 'worktree', JSON.stringify(sectionSpec?.spec))
check('section carries a nav order', typeof sectionSpec?.spec?.order === 'number', String(sectionSpec?.spec?.order))
check('section declares its locale namespace', sectionSpec?.spec?.locale === 'gord-worktree', String(sectionSpec?.spec?.locale))
check('dictionaries register under that namespace', registeredDicts.length === 1 && registeredDicts[0].ns === 'gord-worktree', JSON.stringify(registeredDicts.map((d) => d.ns)))
// Regression: the settings nav makes this call, and it is where the
// un-injected `ctx.locale` used to throw and blank the whole page.
const navLabel = sectionSpec?.spec?.label?.()
check('section label resolves through the locale service', navLabel === '工作树', String(navLabel))

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
  branches: ['main', 'origin/main', 'origin/colleague/feature'],
  localBranches: ['main'],
  worktrees: [
    { path: '/tmp/demo/app', branch: 'main', head: 'aaaaaaa', current: true, detached: false, locked: false, pruned: false },
    { path: '/tmp/demo/app-worktrees/feat', branch: 'worktree/feat', head: 'bbbbbbb', current: false, detached: false, locked: false, pruned: false },
  ],
}
const calls = []
globalThis.fetch = (url, options) => {
  const action = new URL(url, 'http://localhost').searchParams.get('action')
  // Parse once: `options.body` is the raw JSON string, so reading `.branch` off
  // it directly would silently yield undefined.
  const body = JSON.parse(options.body)
  calls.push({ action, body })
  const payload =
    action === 'list'
      ? listing
      : action === 'create'
        ? {
            ok: true,
            path: '/tmp/demo/app-worktrees/new',
            branch: body.branch || 'worktree/new',
            base: 'origin/colleague/feature',
            pickedUpRemote: body.branch === 'colleague/feature' ? 'origin/colleague/feature' : undefined,
            // NOTE: kept literal (not JSON-round-tripped) on purpose in the other probes.
            // The route adopts the worktree so the session has a workspace to
            // belong to; the client then starts the session against this id.
            workspace: { workspaceId: 'ws-new', title: 'new', path: '/tmp/demo/app-worktrees/new' },
          }
        : action === 'remove'
          ? { ok: true, removed: body.path, branch: 'worktree/feat', branchDeleted: true }
          : action === 'adopt'
            ? { ok: true, workspace: { workspaceId: 'w1', path: body.path, title: 'feat' } }
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

process.stdout.write('\ncomposer chip\n')
// The chip is a second root component, mounted fresh, so the shared hook store
// is cleared once here and then left alone — clearing it per render would reset
// the chip's own state and it could never open.
slots = []
cleanups = {}
// The chip is a second root component. The hook store here is indexed by
// position rather than keyed by component, so it must be cleared between roots
// — otherwise the chip would inherit the section's hook values.
/** The chip's translator, bound to the plugin dictionary like the real one. */
const chipT = (key, params) => {
  const dict = bundle.DICT.zh
  let text = dict[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}

/** A blank New Session, as the `input.dock` owner passes it. */
const blankSession = { id: 's1', cwd: '/tmp/demo/app', blank: true }

const renderChip = async (passes = 40, session = blankSession) => {
  let tree
  for (let pass = 0; pass < passes; pass++) {
    dirty = false
    beginRender()
    // Drive the registered component, not the inner chip: the blank-session
    // gate lives in the registration, so bypassing it would test nothing.
    tree = resolve(Chip({ session, onClose: () => {} }))
    for (const effect of pendingEffects.splice(0)) effect()
    for (let flush = 0; flush < 4; flush++) await new Promise((resolve) => setImmediate(resolve))
    if (!dirty) break
  }
  return tree
}

check('chip registers above the composer card', chipSpec?.name === 'conversation.input.dock', chipSpec?.name)
check('chip registers a component', typeof Chip === 'function')
check('chip has an id', chipSpec?.spec?.id === 'worktree-location', JSON.stringify(chipSpec?.spec))

// The resolve helper calls function components directly, so the gate is
// exercised by invoking the registered component with each session shape.
const asActive = resolve(Chip({ session: { id: 's1', cwd: '/tmp/demo/app', blank: false } }))
check('chip hides once the session is no longer blank', asActive === null, JSON.stringify(asActive))
const asMissing = resolve(Chip({ session: undefined }))
check('chip hides when no session is addressed', asMissing === null, JSON.stringify(asMissing))

const chip = await renderChip()
const chipText = textsOf(chip).join(' ')
// The control shows its value, like the workspace and preset controls beside
// it; its name lives in the aria-label and tooltip rather than a prefix.
check('chip is named for assistive tech', findByClass(chip, 'gord-dsh-worktree-seat')?.props['aria-label'] === '工作树')
check('chip shows its value', chipText.includes('当前工作树'), chipText.slice(0, 200))
// Closed by default, and defaulting to the project's own directory rather than
// to a worktree: that is where a session starts unless one is asked for.
check('chip defaults to the current worktree', chipText.includes('当前工作树'), chipText.slice(0, 200))
check('chip is collapsed until asked', findByClass(chip, 'gord-dsh-worktree-option') === undefined)
// With no row to attach to (no DOM here) the control renders in place rather
// than vanishing; the portal itself is verified against the live shell.
check('chip degrades to inline when no row is found', portalCalls.length === 0)

process.stdout.write('\nworktree parent map\n')
// The patched sidebar grouping folds a worktree's sessions into its project's
// group, and it reads this map synchronously during render — a fetch would land
// after the first paint and flash the worktree as a second project. So the
// contract is: every worktree of the repo, keyed by path, pointing at the repo.
const parents = JSON.parse(globalThis.window.localStorage.getItem('gord-worktree:parents') ?? '{}')
check(
  'the panel publishes each worktree as a child of its repo',
  parents['/tmp/demo/app-worktrees/feat'] === '/tmp/demo/app',
  JSON.stringify(parents),
)
check(
  'the project is not published as its own child',
  parents['/tmp/demo/app'] === undefined,
  JSON.stringify(parents),
)
// A blocked store must not break the panel: the sidebar then just shows the
// worktree as its own group, which is the unpatched behaviour.
const realSet = globalThis.window.localStorage.setItem
globalThis.window.localStorage.setItem = () => { throw new Error('quota') }
let survived = true
try {
  findByClass(await renderChip(), 'gord-dsh-worktree-seat')
} catch (error) {
  survived = false
}
globalThis.window.localStorage.setItem = realSet
check('a failing localStorage does not break the panel', survived)

process.stdout.write('\ncomposer chip: picker\n')
const chipToggle = findByClass(chip, 'gord-dsh-worktree-seat')
check('chip exposes a toggle', chipToggle !== undefined)
// Parity with the two controls it sits between is a style contract, not a
// cosmetic preference: borderless pill, 16px radius, 13px/500.
check('chip is a borderless pill like its neighbours', chipToggle?.props.style.border === 'none' && chipToggle?.props.style.borderRadius === '16px', JSON.stringify({ border: chipToggle?.props.style.border, radius: chipToggle?.props.style.borderRadius }))
check('chip label matches the neighbours\u2019 type', chipToggle?.props.style.fontSize === '13px' && chipToggle?.props.style.fontWeight === '500' && chipToggle?.props.style.lineHeight === '20px', JSON.stringify({ size: chipToggle?.props.style.fontSize, weight: chipToggle?.props.style.fontWeight }))
check('chip carries the shared chevron', findByClass(chip, 'gord-dsh-worktree-chevron') !== undefined)
chipToggle?.props.onClick()
const chipOpen = await renderChip()
check(
  'opening the chip lists the session repository',
  calls.some((call) => call.action === 'list' && call.body.dir === '/tmp/demo/app'),
  JSON.stringify(calls.map((c) => c.action + ':' + (c.body.dir || ''))),
)
// The menu is exactly two entries: where a session starts, and how to start
// one somewhere else. Other worktrees of the project are workspaces in their
// own right once created, so they belong to the workspace picker, not here.
const openedText = textsOf(chipOpen).join(' ')
const openedOptions = findOptions(chipOpen)
check('menu offers exactly two entries', openedOptions.length === 2, JSON.stringify(openedOptions.map((o) => textsOf(o).join(' '))))
check('menu offers the current worktree', openedText.includes('当前工作树'), openedText.slice(0, 240))
check('menu offers to create a worktree', openedText.includes('新建工作树'), openedText.slice(0, 240))
check('menu does not list existing worktrees', !openedText.includes('app-worktrees'), openedText.slice(0, 240))
check('the current worktree is the marked entry', findByClass(chipOpen, 'gord-dsh-worktree-option-active') !== undefined)

// Choosing the current workspace is a no-op: the session already targets it,
// so nothing should be adopted and no session created.
const localOption = openedOptions[0]
// Scope the assertions to this action: earlier sections have already used the
// same call log, so an unscoped check would read their traffic as this one's.
const callsBeforeLocal = calls.length
const sessionsBeforeLocal = createdSessions.length
localOption?.props.onClick()
const chipAfterLocal = await renderChip()
const localCalls = calls.slice(callsBeforeLocal)
check('choosing the current worktree closes the menu', findByClass(chipAfterLocal, 'gord-dsh-worktree-option') === undefined)
check('choosing the current worktree adopts nothing', !localCalls.some((call) => call.action === 'adopt'), JSON.stringify(localCalls.map((c) => c.action)))
check('choosing the current worktree starts no session', createdSessions.length === sessionsBeforeLocal, JSON.stringify(createdSessions.slice(sessionsBeforeLocal)))

process.stdout.write('\ncomposer chip: dismissal\n')
// Reopen and prove the ways out the core selectors also honour.
findByClass(await renderChip(), 'gord-dsh-worktree-seat')?.props.onClick()
const reopened = await renderChip()
check('menu reopens for the dismissal checks', findByClass(reopened, 'gord-dsh-worktree-option') !== undefined)
// A pointer inside the control must NOT close it, or the create form could
// never be filled in.
fireDocument('pointerdown', { target: { nodeType: 1, insideControl: true } })
const afterInside = await renderChip()
check('a pointer inside the control keeps the menu open', findByClass(afterInside, 'gord-dsh-worktree-option') !== undefined)
// A pointer anywhere else closes it.
fireDocument('pointerdown', { target: { nodeType: 1, insideControl: false } })
const afterOutside = await renderChip()
check('clicking outside closes the menu', findByClass(afterOutside, 'gord-dsh-worktree-option') === undefined)
// Escape closes it too.
findByClass(await renderChip(), 'gord-dsh-worktree-seat')?.props.onClick()
check('menu is open before escape', findByClass(await renderChip(), 'gord-dsh-worktree-option') !== undefined)
fireDocument('keydown', { key: 'Escape' })
const afterEscape = await renderChip()
check('escape closes the menu', findByClass(afterEscape, 'gord-dsh-worktree-option') === undefined)
// A key that is not Escape must leave it open.
findByClass(await renderChip(), 'gord-dsh-worktree-seat')?.props.onClick()
await renderChip()
fireDocument('keydown', { key: 'a' })
check('other keys leave the menu open', findByClass(await renderChip(), 'gord-dsh-worktree-option') !== undefined)
// Leave it closed: the next block opens it itself.
findByClass(await renderChip(), 'gord-dsh-worktree-seat')?.props.onClick()
check('menu closed before the next block', findByClass(await renderChip(), 'gord-dsh-worktree-option') === undefined)

process.stdout.write('\ncomposer chip: new worktree\n')
// Choosing a new worktree is one click and no form: the branch is cut from the
// current one and named for the code that names the directory, so there is
// nothing to type. What has to happen is the part that was missing — the
// session must end up rooted in the new directory, because a session's
// directory is fixed when it is created and cannot be changed afterwards.
findByClass(await renderChip(), 'gord-dsh-worktree-seat')?.props.onClick()
const chipOpen2 = await renderChip()
check('chip offers a new-worktree entry', findButton(chipOpen2, '新建工作树') !== undefined, textsOf(chipOpen2).join(' ').slice(0, 240))
check(
  'the new-worktree entry asks for nothing',
  findInput(chipOpen2, '自动生成') === undefined && findSelect(chipOpen2) === undefined,
  textsOf(chipOpen2).join(' ').slice(0, 240),
)
const sessionsBeforeCreate = createdSessions.length
findButton(chipOpen2, '新建工作树')?.props.onClick()
const created = await renderChip()
const createCalls = calls.filter((call) => call.action === 'create')
check('chip posts the create to the host', createCalls.length === 1, JSON.stringify(calls.map((c) => c.action)))
check('the create carried no branch and no base', createCalls.at(-1)?.body.branch === '' && createCalls.at(-1)?.body.base === '', JSON.stringify(createCalls.at(-1)?.body))
// The point of the whole change: the session is created rooted in the worktree
// and opened, so the next message is sent there. Nothing else can move it —
// `sessions.create` is the only moment a directory is chosen.
// Addressed by workspace, not by directory: the two are mutually exclusive, and
// a session given only a cwd belongs to no workspace — which leaves the shell
// nowhere to draw it, showing "choose a workspace to start" over a session that
// does exist.
check(
  'creating starts a session in the new worktree',
  createdSessions.length === sessionsBeforeCreate + 1 && createdSessions.at(-1)?.workspaceId === 'ws-new',
  JSON.stringify(createdSessions.slice(sessionsBeforeCreate)),
)
check(
  'creating opens that session',
  openedSessions.includes(createdSessions.at(-1)?.sessionId),
  JSON.stringify({ opened: openedSessions, created: createdSessions.at(-1) }),
)
// The client does not adopt on its own — the host route does, because only the
// host holds the registry. A second adoption here would race it.
check(
  'the client adopts nothing itself',
  !calls.some((call) => call.action === 'adopt' && call.body.path === '/tmp/demo/app-worktrees/new'),
  JSON.stringify(calls.filter((c) => c.action === 'adopt').map((c) => c.body.path)),
)
check('creating reports where the worktree landed', textsOf(created).join(' ').includes('已创建 /tmp/demo/app-worktrees/new'), textsOf(created).join(' ').slice(-300))

process.stdout.write('\nlocalization\n')
check('dictionaries are key-set identical', JSON.stringify(Object.keys(bundle.DICT.zh).sort()) === JSON.stringify(Object.keys(bundle.DICT.en).sort()), 'zh/en mismatch')
check('english dictionary has real copy', bundle.DICT.en['nav.label'] === 'Worktrees', bundle.DICT.en['nav.label'])

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)