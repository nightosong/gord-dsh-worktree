/**
 * gord-dsh-worktree — browser half.
 *
 * Registered by DSH's client module system (`window.__ModuleLoader__.load`),
 * this bundle contributes a Worktrees page to Web Settings → Settings. It
 * talks to the host half's `/gord-dsh-worktree/api` route and never runs git
 * itself, so the browser and the agent tools share one implementation.
 *
 * Styling follows the platform's plugin conventions: every visual property is
 * an element-level React style (so the page renders correctly even if the
 * injected stylesheet never lands), the injected sheet adds only what inline
 * styles cannot express, and colours come from the `--dsw-alias-*` theme
 * variables with hard fallbacks for both light and dark themes.
 */

window.__ModuleLoader__.load({
  id: 'gord-dsh-worktree',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    // The Hero's working-location row is laid out by the core plugin and all
    // three of its slots are `single` — a second occupant shadows the first
    // rather than sitting beside it, so the row cannot take a third control
    // through the slot system. The core plugins themselves portal when they
    // need to place something inside a surface they do not own, so this does
    // the same: the dropdown below is rendered into the row element itself.
    var ReactDOM = require('react-dom');
    // The icon package the workspace and preset controls use. `require` can
    // only resolve a package the boot graph wires in, which is why this is
    // declared in `dsh.client.inject` alongside `react`.
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    /**
     * One glyph, resolved across the naming schemes primitives has shipped.
     *
     * 0.1.5/0.1.6 exported size-suffixed names (`IconTrashOutline16`) and took a
     * `size` prop; 0.1.7 renamed every glyph onto a weight suffix
     * (`IconTrashOutlineRegular`) with the same artwork and the same prop. Both
     * spellings are tried, newest first, so one bundle runs on either line.
     *
     * The fallback is the part that matters: `require` hands back a module
     * object, so a name the running build does not export is `undefined`, and
     * React rejects `undefined` as an element type with a throw that takes the
     * whole surface down — the Settings page, the picker, the tab. Drawing
     * nothing is the honest failure for a build whose glyph was renamed away.
     *
     * @param {string[]} names - export names to try, newest scheme first.
     * @returns {Function} a component that always renders.
     */
    function icon(names) {
      for (var i = 0; i < names.length; i += 1) {
        var candidate = primitives[names[i]];
        if (candidate !== undefined && candidate !== null) return candidate;
      }
      return function MissingIcon() {
        return null;
      };
    }

    /** The glyphs this plugin draws, each resolved across both schemes. */
    var IconTrash = icon(['IconTrashOutlineRegular', 'IconTrashOutline16']);
    var IconBranch = icon(['IconBranchOutlineRegular', 'IconBranchOutline16']);
    var IconChevronDown = icon(['IconChevronDownOutlineRegular', 'IconChevronDownOutline14']);
    var IconEdit = icon(['IconEditOutlineRegular', 'IconEditOutline16']);

    /** Dictionary namespace owned by this plugin. */
    var NS = 'gord-worktree';
    /** Host half's JSON surface; one route, everything addressed by `action`. */
    var API = '/gord-dsh-worktree/api';

    /**
     * Copy, zh-first with a complete en mirror (the official locale contract:
     * both dictionaries carry the same key set).
     */
    var DICT = {
      zh: {
        'nav.label': '工作树',
        'brand.sub': '用 git worktree 隔离并行开发，互不干扰',
        'repo.none': '没有可用的 git 仓库',
        'state.loading': '加载中…',
        'state.empty': '还没有关联工作树',
        'state.error': '操作失败',
        'state.notRepo': '该目录不在 git 仓库中',
        'state.notRepoAt': '该目录不在 git 仓库中：{dir}',
        'list.title': '工作树',
        'list.count': '共 {n} 个',
        'pick.workspace': '工作区',
        'badge.detached': '游离 HEAD',
        'badge.locked': '已锁定',
        'badge.pruned': '记录失效',
        'row.open': '打开会话',
        'row.openHint': '跳到该工作区已有的会话，没有就新建一个',
        'row.opened': '已添加为工作区',
        'row.remove': '删除',
        'create.done': '已创建 {path}（分支 {branch}）',
        'remove.confirm': '确认删除 {path}？',
        'remove.dirty': '该工作树有未提交或未跟踪的改动，删除会丢失它们。',
        'remove.force': '丢弃改动并删除',
        'remove.branch': '同时删除分支 {branch}',
        'remove.submit': '删除',
        'remove.cancel': '取消',
        'remove.done': '已删除 {path}',
        'prune.title': '清理失效记录',
        'prune.submit': '预演清理',
        'prune.done': '没有需要清理的记录',
        'prune.result': '将清理：\n{output}',
        'sidebar.tree': '侧栏树视图',
        'sidebar.treeDone': '已切到按工作区树，刷新页面后生效',
        'rows.hide': '隐藏工作树行（会话照旧显示）',
        'relocate.submit': '搬进项目',
        'relocate.done': '已搬进项目：{count} 个',
        'relocate.failed': '已搬 {count} 个，{failed} 个没搬动',
        'relocate.none': '没有需要搬动的工作树',
        'chip.label': '工作树',
        'chip.noProject': '未找到可用的 git 仓库工作区',
        'chip.local': '当前工作树',
        'chip.none': '选择工作树',
        'chip.this': '主工作树',
        'chip.loading': '读取中…',
        'chip.title': '工作位置',
        'chip.desc': '会话仍在当前工作区，工作树只改变它的工作目录。',
        'chip.new': '新建工作树',
        'chip.newDesc': '新建一个检出目录，可同时并行开发',
        'chip.creating': '正在新建工作树…',
        'chip.bindFailed': '工作树已创建，但会话未能启动：{message}',
        'chip.noRegistry': '当前配置没有工作区能力',
        'diff.tab': '变更',
        'diff.guide.title': '变更',
        'diff.guide.desc': '本会话工作区里未提交的改动',
        'diff.refresh': '刷新',
        'diff.loading': '读取改动…',
        'diff.clean': '没有未提交的改动',
        'diff.notRepo': '这个会话不在 git 仓库里',
        'diff.files': '{count} 个文件',
        'diff.totals': '+{added} −{removed}',
        'diff.truncated': '改动过多，只显示前 {count} 个文件',
        'diff.binary': '二进制文件，不显示差异',
        'diff.noPatch': '没有可显示的差异',
        'diff.expand': '展开其余 {count} 行',
        'diff.collapse': '收起',
        'diff.failed': '读取改动失败：{message}',
        'chip.pick': '打开',
        'chip.pickHint': '本次会话的工作目录',
        'chip.opening': '打开中…',
        'chip.openFailed': '打开会话失败：{message}',
        'chip.remote': '远程',
        'chip.shadowed': '注意：存在远程分支 {remote}，但按你指定的起点创建',
        'archive.title': '归档的会话',
        'archive.count': '共 {n} 条',
        'archive.loading': '读取归档…',
        'archive.empty': '没有已归档的会话',
        'archive.failed': '读取归档失败：{message}',
        'archive.noRegistry': '当前配置没有工作区能力，读不到归档',
        'archive.untitled': '（无标题）',
        'archive.size': '{size}',
        'archive.deleteOne': '永久删除这个会话',
        'archive.confirmOne': '确认永久删除这个会话？',
        'archive.unarchive': '取消归档',
        'archive.unarchiving': '取消中…',
        'archive.unarchived': '已取消归档，会话回到侧栏',
        'archive.deleteAll': '全部删除',
        'archive.deleteAllHint': '删除上面列出的全部归档会话',
        'archive.confirm': '确认永久删除这 {n} 个会话？',
        'archive.confirmBody': '会话日志、缓存投影与工作区记录都会删掉，无法恢复。',
        'archive.confirmSubmit': '永久删除',
        'archive.cancel': '取消',
        'archive.deleted': '已删除 {n} 个会话',
        'archive.skipped': '另有 {n} 个正在运行，已跳过（停止后再删）',
        'archive.truncated': '只列出最近的 {n} 条',
        'archive.recordPath': '归档时间记录在 {path}',
      },
      en: {
        'nav.label': 'Worktrees',
        'brand.sub': 'Isolate parallel work with git worktrees',
        'repo.none': 'No git repository available',
        'state.loading': 'Loading…',
        'state.empty': 'No linked worktrees yet',
        'state.error': 'Request failed',
        'state.notRepo': 'That directory is not inside a git repository',
        'state.notRepoAt': 'That directory is not inside a git repository: {dir}',
        'list.title': 'Worktrees',
        'list.count': '{n} total',
        'pick.workspace': 'Workspace',
        'badge.detached': 'detached',
        'badge.locked': 'locked',
        'badge.pruned': 'pruned',
        'row.open': 'Open session',
        'row.openHint': 'Go to this workspace\'s chat — its newest session, or a new one',
        'row.opened': 'Added as a workspace',
        'row.remove': 'Remove',
        'create.done': 'Created {path} on branch {branch}',
        'remove.confirm': 'Remove {path}?',
        'remove.dirty': 'This worktree has uncommitted or untracked changes; removal discards them.',
        'remove.force': 'Discard changes and remove',
        'remove.branch': 'Also delete branch {branch}',
        'remove.submit': 'Remove',
        'remove.cancel': 'Cancel',
        'remove.done': 'Removed {path}',
        'prune.title': 'Prune stale records',
        'prune.submit': 'Dry run',
        'prune.done': 'Nothing to prune',
        'prune.result': 'Would prune:\n{output}',
        'sidebar.tree': 'Tree sidebar',
        'sidebar.treeDone': 'Switched to the workspace tree; reload to apply',
        'rows.hide': 'Hide worktree rows (sessions stay)',
        'relocate.submit': 'Move in',
        'relocate.done': 'Moved into the project: {count}',
        'relocate.failed': 'Moved {count}, {failed} did not move',
        'relocate.none': 'No worktree to move',
        'chip.label': 'Worktree',
        'chip.noProject': 'No repository workspace found',
        'chip.local': 'Current worktree',
        'chip.none': 'Choose a worktree',
        'chip.this': 'main worktree',
        'chip.loading': 'Reading…',
        'chip.title': 'Working location',
        'chip.desc': 'The session stays in the current workspace; a worktree only changes its working directory.',
        'chip.new': 'New worktree',
        'chip.newDesc': 'Create another checkout for parallel work',
        'chip.creating': 'Creating a worktree…',
        'chip.bindFailed': 'The worktree was created, but the session could not start: {message}',
        'chip.noRegistry': 'workspace support is not composed in this profile',
        'diff.tab': 'Changes',
        'diff.guide.title': 'Changes',
        'diff.guide.desc': "Uncommitted changes in this session's workspace",
        'diff.refresh': 'Refresh',
        'diff.loading': 'Reading changes…',
        'diff.clean': 'No uncommitted changes',
        'diff.notRepo': 'This session is not in a git repository',
        'diff.files': '{count} files',
        'diff.totals': '+{added} −{removed}',
        'diff.truncated': 'Too many changes; showing the first {count} files',
        'diff.binary': 'Binary file; no diff shown',
        'diff.noPatch': 'Nothing to show',
        'diff.expand': 'Show the remaining {count} lines',
        'diff.collapse': 'Collapse',
        'diff.failed': 'Could not read the changes: {message}',
        'chip.pick': 'Open',
        'chip.pickHint': 'The working directory for this session',
        'chip.opening': 'Opening…',
        'chip.openFailed': 'Could not open the session: {message}',
        'chip.remote': 'remote',
        'chip.shadowed': 'Note: remote branch {remote} exists but was not used, because you named a base',
        'archive.title': 'Archived sessions',
        'archive.count': '{n} total',
        'archive.loading': 'Reading the archive…',
        'archive.empty': 'Nothing is archived',
        'archive.failed': 'Could not read the archive: {message}',
        'archive.noRegistry': 'This composition has no workspace support, so the archive cannot be read',
        'archive.untitled': '(untitled)',
        'archive.size': '{size}',
        'archive.deleteOne': 'Delete this session permanently',
        'archive.confirmOne': 'Permanently delete this session?',
        'archive.unarchive': 'Unarchive',
        'archive.unarchiving': 'Unarchiving…',
        'archive.unarchived': 'Unarchived — the session is back in the sidebar',
        'archive.deleteAll': 'Delete all',
        'archive.deleteAllHint': 'Delete every archived session listed above',
        'archive.confirm': 'Permanently delete these {n} sessions?',
        'archive.confirmBody': 'Their logs, cached projections and workspace records are removed. This cannot be undone.',
        'archive.confirmSubmit': 'Delete permanently',
        'archive.cancel': 'Cancel',
        'archive.deleted': 'Deleted {n} sessions',
        'archive.skipped': '{n} more are running right now and were skipped — stop them and retry',
        'archive.truncated': 'Showing the most recent {n}',
        'archive.recordPath': 'Archive times are recorded in {path}',
      },
    };

    /** Browser-language fallback when the locale service is absent. */
    function prefersEnglish() {
      var lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh';
      return String(lang).toLowerCase().indexOf('zh') !== 0;
    }

    /** Text lookup used until the locale service binds its own `t`. */
    function fallbackT(key, params) {
      var dict = prefersEnglish() ? DICT.en : DICT.zh;
      var text = dict[key] !== undefined ? dict[key] : key;
      if (params) {
        Object.keys(params).forEach(function (name) {
          text = text.split('{' + name + '}').join(String(params[name]));
        });
      }
      return text;
    }

    /** Fill `{name}` placeholders for `t` implementations that do not. */
    function interpolate(text, params) {
      if (!params) return text;
      return Object.keys(params).reduce(function (acc, name) {
        return acc.split('{' + name + '}').join(String(params[name]));
      }, text);
    }

    /** Element-level styles: the primary visual source, theme-variable driven. */
    var S = {
      root: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', width: '100%', padding: '4px 0 0', gap: '4px' },
      brand: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 0 6px' },
      logo: {
        width: '40px',
        height: '40px',
        borderRadius: '12px',
        background: 'var(--dsw-alias-brand-primary, #4176e6)',
        color: '#fff',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        fontWeight: '600',
        letterSpacing: '.3px',
        userSelect: 'none',
      },
      brandText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' },
      name: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: '16px', fontWeight: '500', lineHeight: '24px' },
      sub: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
      card: {
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
        borderRadius: '12px',
        padding: '14px 16px',
        marginTop: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: '14px', fontWeight: '500', lineHeight: '22px' },
      desc: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
      // The host is rendered by the dock but its content is portaled onto the
      // Hero row; it must collapse so it cannot leave a gap in the composer.
      host: { display: 'contents' },
      anchor: { position: 'relative', display: 'inline-flex', minWidth: '0' },
      // Every declaration below is taken from the workspace chip and the preset
      // seat so the three controls are indistinguishable. The styles cannot be
      // borrowed by class name — those live in the owning bundles' CSS modules
      // with hashed names — so they are reproduced here instead, and the
      // live check compares the rendered boxes.
      seat: {
        minWidth: '0',
        maxWidth: 'min(100%, 240px)',
        minHeight: '28px',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        background: '0 0',
        border: 'none',
        borderRadius: '16px',
        alignItems: 'center',
        gap: '4px',
        padding: '0 8px',
        fontSize: '13px',
        fontWeight: '500',
        lineHeight: '20px',
        display: 'inline-flex',
      },
      seatIcon: { color: 'var(--dsw-alias-label-primary)', flex: 'none', width: '16px', height: '16px' },
      seatLabel: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0', overflow: 'hidden' },
      chevron: { color: 'var(--dsw-alias-label-caption)', flex: 'none', width: '12px', height: '12px' },
      // Floated, so opening the menu never reflows the row it is anchored to.
      menu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: '0',
        zIndex: 40,
        minWidth: '260px',
        maxWidth: '420px',
        maxHeight: '320px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px',
        border: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        boxShadow: '0 8px 24px rgba(16, 24, 40, .12)',
      },
      option: {
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 8px',
        border: 'none',
        borderRadius: '7px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '18px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      optionMark: { flex: 'none', width: '12px', color: 'var(--dsw-alias-brand-primary, #4176e6)' },
      formBlock: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 8px 4px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1', minWidth: '0' },
      label: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '16px' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '7px 10px',
        fontSize: '13px',
        lineHeight: '18px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.06))',
        border: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
        borderRadius: '8px',
        outline: 'none',
      },
      inputMono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
      // The workspace picker is the one input that must not stretch: it sits in a
      // row beside its label, so its width is its content's.
      picker: { width: 'auto', minWidth: '180px', maxWidth: '100%' },
      pickRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      // Confirmation buttons belong on the right, where the eye ends: the
      // reading order is "what will happen, then decide".
      actionsEnd: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
      button: {
        boxSizing: 'border-box',
        padding: '6px 12px',
        fontSize: '13px',
        lineHeight: '18px',
        fontFamily: 'inherit',
        fontWeight: '500',
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.08))',
        border: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      // Square, and sized to the text buttons it sits beside (6 + 18 + 6 plus
      // the two border pixels), so a row's controls share one baseline instead
      // of the glyph floating a couple of pixels off it.
      iconButton: {
        width: '32px',
        height: '32px',
        padding: '0',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      // A destructive confirmation, set apart from the list it sits above so it
      // reads as one block rather than as loose copy between the header and the
      // rows. No left border: the danger colour is already carried by the text
      // and the submit button.
      confirm: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        margin: '4px 0',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.06))',
      },
      // The confirm's own buttons sit in the bottom-right corner of the block,
      // below the text they answer: the explanation reads first and the decision
      // comes last, where the eye already is after reading it. The destructive
      // button keeps its place on the left of Cancel — the order DSH's own
      // confirmations use — and only the group's alignment changes.
      confirmActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: '2px' },
      primary: { background: 'var(--dsw-alias-brand-primary, #4176e6)', borderColor: 'transparent', color: '#fff' },
      danger: {
        color: 'var(--dsw-alias-state-error-primary, #d96b5a)',
        borderColor: 'var(--dsw-alias-state-error-primary, #d96b5a)',
        background: 'transparent',
      },
      // One line of facts under a row's path: the branch and anything wrong with
      // it on the left, the time on the right. It does not wrap — a branch is the
      // only part that can be long, and it elides rather than pushing the line
      // onto a second one, which is what a narrow panel used to do.
      meta: { display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
      // A path is read from its end: the last segment is what tells two checkouts
      // apart, so the overflow is taken off the front. `direction: rtl` is what
      // moves the ellipsis there; `text-align: left` keeps the line itself on the
      // left edge, where a path belongs.
      pathLine: {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        direction: 'rtl',
        textAlign: 'left',
        minWidth: '0',
      },
      // The layers under the path: what this checkout is, on the left, and when
      // it last moved, on the right.
      metaLeft: { display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 auto', minWidth: '0', overflow: 'hidden' },
      // The branch is read from its front, unlike a path: `feat/integrate-midjourney-ima…`
      // still says which branch it is, where dropping the front would not.
      branch: { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // The session hover card is drawn by the Workspace bundle on its own dark
      // ground with literal colors, so this line matches them rather than reading
      // theme variables: a themed line on that card reads as another surface.
      hoverBranch: { color: '#cfd3d6', fontSize: '12px', lineHeight: '16px', wordBreak: 'break-all' },
      // Which workspace the session belongs to: a breadcrumb above the session
      // title the card draws itself, so it reads as context rather than a name.
      hoverWorkspace: {
        order: -1,
        color: '#adb2b8',
        fontSize: '12px',
        lineHeight: '16px',
        wordBreak: 'break-all',
      },
      // The card lays its content out as a column, and the slot cannot reach
      // above the title by source order. `display: contents` keeps this wrapper
      // out of that layout, which is what lets `order: -1` on the workspace line
      // put it first in the card.
      hoverFacts: { display: 'contents' },
      // The archive row's meta line is a reading column, not a wrapped fact
      // list: the path takes the space it needs and the two numbers line up
      // against the right edge, where equal-width date strings and
      // tabular figures make the column scannable straight down.
      archiveMeta: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '12px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      archivePath: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'left',
      },
      // One line of identification: the id, then the title. It never wraps — a
      // second line is the row's facts, and a title broken across two lines is
      // what makes a list of them unreadable — so the title ellipsises instead.
      archiveLabel: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        minWidth: '0',
        marginBottom: '2px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      archiveId: {
        flex: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      archiveTitle: { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      archiveWhen: { flex: 'none', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      // The date and the size travel together and sit on the right edge, with
      // the size given a fixed width so the left edge of the number column is a
      // straight line too.
      archiveTail: { flex: 'none', display: 'flex', alignItems: 'baseline', gap: '12px', marginLeft: 'auto' },
      archiveSize: { flex: 'none', minWidth: '56px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' },
      item: {
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
      },
      itemText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '0', flex: '1' },
      badge: {
        flex: 'none',
        fontSize: '11px',
        lineHeight: '1',
        padding: '3px 7px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-fill-strong, rgba(127,127,127,.16))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      badgeAccent: { background: 'var(--dsw-alias-brand-primary, #4176e6)', color: '#fff' },
      badgeWarn: { background: 'var(--dsw-alias-state-warning-soft, rgba(217,160,90,.22))', color: 'var(--dsw-alias-state-warning-primary, #b07a2b)' },
      badgeError: { background: 'var(--dsw-alias-state-error-soft, rgba(217,107,90,.2))', color: 'var(--dsw-alias-state-error-primary, #d96b5a)' },
      notice: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      error: { color: 'var(--dsw-alias-state-error-primary, #d96b5a)' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #3f9a6d)' },
      pre: {
        margin: '6px 0 0',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.06))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '220px',
        overflow: 'auto',
      },
    };

    /** Injected sheet: only `:hover`, which inline styles cannot express. */
    var HOVER_CSS =
      '.gord-dsh-worktree-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l3, rgba(127,127,127,.16))}' +
      '.gord-dsh-worktree-btn.gord-dsh-worktree-primary:hover:not(:disabled){filter:brightness(1.06)}' +
      '.gord-dsh-worktree-btn:disabled{opacity:.55;cursor:default}' +
      '.gord-dsh-worktree-input:focus{border-color:var(--dsw-alias-brand-primary, #4176e6)}' +
      '.gord-dsh-worktree-seat:not(:disabled):hover,.gord-dsh-worktree-seat-open{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.gord-dsh-worktree-option:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.gord-dsh-worktree-option-active{background:var(--dsw-alias-fill-l2, rgba(127,127,127,.08))}' +
      '.gord-dsh-worktree-item:first-child{border-top:0 none transparent}' +
      '.gord-dsh-worktree-link:hover{text-decoration:underline}';

    /**
     * Where each worktree's sessions belong in the sidebar.
     *
     * The sidebar groups by workspace and has no parent field, so the patched
     * grouping (`tools/patch-sidebar.mjs`) reads this to fold a
     * worktree's sessions into the project's group. It has to be reachable
     * synchronously during render, which is why it is a localStorage map rather
     * than a fetch: after a reload the first render already needs the answer,
     * and a promise would land too late to avoid showing the worktree as a
     * second project first.
     *
     * Entries for worktrees that no longer exist are harmless — nothing folds
     * unless a workspace sits at that exact path — so this is only ever merged
     * into, never pruned.
     */
    var PARENTS_KEY = 'gord-worktree:parents';

    /**
     * The shell's own sidebar view store, when this shell has one.
     *
     * 0.2 ships a `workspace-tree` grouping that nests a workspace under the
     * workspace directory containing it, and it is off by default — which is why
     * worktrees read as top-level groups there. The choice is the shell's own
     * persisted state (`dsh.workspace.view.vN`), read here instead of guessed
     * at, so the panel offers the switch exactly on the hosts that have it and
     * stays silent on 0.1.7, whose sidebar this plugin patches directly.
     *
     * Probed by version number rather than by enumerating localStorage keys:
     * the store's key is the only one this must find, and `getItem` is the one
     * accessor every host (and every test stub) is sure to have.
     *
     * @returns {{key: string, state: object}|undefined} the store, or undefined.
     */
    function sidebarViewStore() {
      var ls = typeof globalThis.window !== 'undefined' && globalThis.window ? globalThis.window.localStorage : globalThis.localStorage;
      if (!ls || typeof ls.getItem !== 'function') return undefined;
      for (var version = 20; version >= 1; version -= 1) {
        var key = 'dsh.workspace.view.v' + version;
        var raw = null;
        try {
          raw = ls.getItem(key);
        } catch (error) {
          return undefined;
        }
        if (typeof raw !== 'string' || raw === '') continue;
        try {
          var state = JSON.parse(raw);
          if (state && typeof state === 'object') return { key: key, state: state };
        } catch (error) {
          return undefined;
        }
        return undefined;
      }
      return undefined;
    }

    /**
     * Ask the shell's sidebar for the tree grouping, keeping every other choice.
     *
     * @param {{key: string, state: object}} store - a store from `sidebarViewStore`.
     * @returns {boolean} whether the store was written.
     */
    function showSidebarAsTree(store) {
      var ls = typeof globalThis.window !== 'undefined' && globalThis.window ? globalThis.window.localStorage : globalThis.localStorage;
      try {
        ls.setItem(store.key, JSON.stringify(Object.assign({}, store.state, { groupBy: 'workspace-tree' })));
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * The sidebar rows that stand for a worktree of another workspace.
     *
     * A tree gives every registered workspace a row, so a worktree adds a folder
     * line above its own sessions. Hiding that line is display only: the row is
     * just the group's header, so its sessions keep rendering a level up at the
     * project's own indent, the workspace stays registered, and one click brings
     * the line back. The ids come from the host, never from row labels — a
     * workspace can be renamed.
     */
    var ROWS_KEY = 'gord-worktree:hide-worktree-rows';

    /** The ids the host named, kept for the panel's repaint. */
    var worktreeRows = [];

    /**
     * @returns {boolean} whether worktree rows are hidden; hidden unless the user
     * turned it off, including on a host too old to answer.
     */
    function hideWorktreeRows() {
      var ls = typeof globalThis.window !== 'undefined' && globalThis.window ? globalThis.window.localStorage : globalThis.localStorage;
      try {
        return !ls || typeof ls.getItem !== 'function' || ls.getItem(ROWS_KEY) !== '0';
      } catch (error) {
        return true;
      }
    }

    /** The depth a group section carries inline, in pixels, for its rows. */
    var INDENT_VAR = '--dsh-workspace-indent';

    /** The indent each section had before this code lowered it, by section. */
    var originalIndents = new WeakMap();

    /**
     * The group section that holds a row, which is where the indent lives.
     *
     * @param {object} row - any sidebar row.
     * @returns {object|undefined} the nearest section carrying the indent.
     */
    function indentSection(row) {
      var node = row.parentElement;
      while (node) {
        var style = node.style;
        if (style && typeof style.getPropertyValue === 'function' && style.getPropertyValue(INDENT_VAR) !== '') {
          return node;
        }
        node = node.parentElement;
      }
      return undefined;
    }

    /**
     * @param {object} section - a group section.
     * @returns {string|undefined} the indent of the section one level out, or
     * undefined at the top level, where there is nothing to align with.
     */
    function outerIndent(section) {
      var outer = indentSection(section);
      return outer === undefined ? undefined : outer.style.getPropertyValue(INDENT_VAR);
    }

    /**
     * Move a worktree's rows one indent level out, or put them back.
     *
     * A tree indents by an inline custom property on the group section that holds
     * the rows (`--dsh-workspace-indent`, `depth * 12px` in the 0.2 shell, read by
     * `padding-inline-start`), so lowering that one value lifts the worktree's
     * sessions to the project's own level together with the hidden header — no
     * row has to be touched one by one, and no pixel size is assumed. The
     * section's own value goes back when the header comes back.
     *
     * @param {object} row - a workspace row.
     * @param {boolean} hidden - whether its header is hidden right now.
     */
    function relevel(row, hidden) {
      var section = indentSection(row);
      if (section === undefined) return;
      if (hidden) {
        var outer = outerIndent(section);
        if (outer === undefined) return;
        if (!originalIndents.has(section)) {
          originalIndents.set(section, section.style.getPropertyValue(INDENT_VAR));
        }
        section.style.setProperty(INDENT_VAR, outer);
      } else if (originalIndents.has(section)) {
        section.style.setProperty(INDENT_VAR, originalIndents.get(section));
        originalIndents.delete(section);
      }
    }

    /**
     * Hide (or restore) the worktree rows in a document, and align what they held.
     *
     * Every sidebar row carries the workspace it stands for as `data-row-key`
     * (`workspace:<id>`), which is the one stable handle the markup offers: the
     * CSS classes are hashed per build and the labels are the user's to change.
     *
     * @param {object|undefined} root - the document to repaint.
     * @param {readonly string[]} ids - workspace ids that are worktrees.
     * @returns {number} how many rows were touched.
     */
    function paintWorktreeRows(root, ids) {
      if (!root || typeof root.querySelectorAll !== 'function' || !Array.isArray(ids) || ids.length === 0) return 0;
      var selector = ids
        .map(function (id) {
          return '[data-row-key="workspace:' + id + '"]';
        })
        .join(',');
      var rows = root.querySelectorAll(selector);
      var hide = hideWorktreeRows();
      for (var i = 0; i < rows.length; i += 1) {
        // A collapsed worktree renders no sessions at all, so hiding its header
        // would leave nothing to reopen it with: only an open row is a folder.
        var open = typeof rows[i].getAttribute === 'function' ? rows[i].getAttribute('aria-expanded') : undefined;
        var hidden = hide && open === 'true';
        rows[i].style.display = hidden ? 'none' : '';
        relevel(rows[i], hidden);
      }
      return rows.length;
    }

    /** Repaint the worktree rows with the ids already fetched. */
    function applyWorktreeRows() {
      paintWorktreeRows(typeof document === 'undefined' ? undefined : document, worktreeRows);
    }

    /**
     * Remember whether worktree rows are hidden, and repaint them now.
     *
     * @param {boolean} hidden - the new choice.
     */
    function setWorktreeRowsHidden(hidden) {
      var ls = typeof globalThis.window !== 'undefined' && globalThis.window ? globalThis.window.localStorage : globalThis.localStorage;
      try {
        if (ls && typeof ls.setItem === 'function') ls.setItem(ROWS_KEY, hidden ? '1' : '0');
      } catch (error) {
        /* the row keeps whatever the page was rendered with */
      }
      applyWorktreeRows();
    }

    /**
     * Keep the worktree rows hidden while the sidebar redraws.
     *
     * React rebuilds those rows on every view change, so a one-off pass would come
     * undone the moment the list re-renders. The ids are fetched once per page
     * load — they only change when a workspace is created or removed — and the
     * repaint runs whenever the tree changes.
     *
     * @param {object} ctx - plugin context, for the observer's lifetime.
     */
    function watchWorktreeRows(ctx) {
      var root = typeof document === 'undefined' ? undefined : document;
      if (!root || typeof root.querySelectorAll !== 'function') return;
      if (typeof MutationObserver === 'function' && root.documentElement) {
        var observer = new MutationObserver(function () {
          paintWorktreeRows(root, worktreeRows);
        });
        observer.observe(root.body || root.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-expanded'],
        });
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              observer.disconnect();
            };
          }, 'worktree.rowHide');
        }
      }
      api('worktreeRows', {})
        .then(function (data) {
          if (!data || data.ok !== true || !Array.isArray(data.rows)) return;
          worktreeRows = data.rows;
          applyWorktreeRows();
        })
        .catch(function () {
          /* no ids, no hiding: the sidebar keeps its rows */
        });
    }

    /**
     * Told on this document when a worktree appears or disappears.
     *
     * The composer's chip and the settings page are separate mounts of this
     * plugin: the chip creates a worktree in the middle of a conversation, and the
     * page can be open at that moment showing the very repository it landed in.
     * Nothing in DSH tells it, so the plugin tells itself.
     */
    var CHANGED_EVENT = 'gord-worktree:changed';

    /**
     * The sidebar session row's hover card. It is rendered by the Workspace
     * bundle, which declares this slot for whoever has something to add to it.
     */
    var HOVER_SLOT = 'sidebar.session.row.hover';

    /**
     * Branches per session, as the hover card has learned them. Emptied when the
     * window is focused again, which is the one moment the answer can have changed
     * without this window seeing it: a checkout somewhere else.
     */
    var HOVER_FACTS = {};

    /**
     * Record a project as the owner of the worktrees cut from it.
     *
     * The sidebar grouping rule reads this map, so a worktree that is never
     * published shows up as a project of its own instead of under the project it
     * came from — which is what a `create` response used to cause: it carries
     * the new directory but not the project it belongs to, so nothing was
     * published and the new workspace appeared at the top level.
     *
     * @param {object} data - a host payload: `mainRoot` and `worktrees`, or the
     *   single `path` a create returned.
     * @param {string} [projectRoot] - the project the payload came from, used
     *   when the payload does not name it.
     */
    /** Say that a worktree changed, for whichever half of the plugin is listening. */
    function announceChange() {
      if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
      try {
        document.dispatchEvent(new CustomEvent(CHANGED_EVENT));
      } catch (_) {
        document.dispatchEvent({ type: CHANGED_EVENT });
      }
    }

    function publishParents(data, projectRoot) {
      try {
        var named = typeof data.mainRoot === 'string' && data.mainRoot !== '' ? data.mainRoot : '';
        var main = named !== '' ? named : typeof projectRoot === 'string' ? projectRoot : '';
        if (main === '') return;
        var map = JSON.parse(window.localStorage.getItem(PARENTS_KEY) || '{}');
        var changed = false;
        var paths = (data.worktrees || []).map(function (entry) {
          return entry && typeof entry.path === 'string' ? entry.path : '';
        }).filter(function (path) { return path !== ''; });
        if (paths.length === 0 && typeof data.path === 'string') paths = [data.path];
        paths.forEach(function (path) {
          if (path === main) return;
          if (map[path] === main) return;
          map[path] = main;
          changed = true;
        });
        if (changed) window.localStorage.setItem(PARENTS_KEY, JSON.stringify(map));
      } catch (error) {
        // A blocked or full localStorage must not break the panel; the sidebar
        // then simply shows the worktree as its own group. Warned rather than
        // swallowed: a failure here is invisible in the UI, and the difference
        // between "not patched" and "patched but never told" is otherwise
        // impossible to tell apart.
        if (window.console && window.console.warn) {
          window.console.warn('gord-dsh-worktree: could not publish worktree parents', error);
        }
      }
    }

    /** One POST to the host surface; resolves the parsed JSON payload. */
    function api(action, payload) {
      return fetch(API + '?action=' + encodeURIComponent(action), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(function (res) {
        return res.json().catch(function () {
          throw new Error('HTTP ' + res.status);
        });
      });
    }

    /**
     * Ask the host for one session's workspace and branch, at most once per focus.
     *
     * The client knows the directory a session runs in and the host knows git and
     * the workspace registry, so the request carries the directory: it saves the
     * host a lookup, and the id is what it refuses an archived session by. A
     * failure is remembered as "nothing to show" as well — a hover card that
     * retries on every pass is worse than one that stays quiet until the window is
     * focused again.
     *
     * @param {object} sessions - the sessions service, for the session's directory.
     * @returns {function(string): Promise<{branch: string, workspace: string}>} the
     *   session's facts, with '' for whichever of the two is unknown.
     */
    function hoverFactsReader(sessions) {
      return function (sessionId) {
        if (Object.prototype.hasOwnProperty.call(HOVER_FACTS, sessionId)) {
          return Promise.resolve(HOVER_FACTS[sessionId]);
        }
        var dir = '';
        try {
          var row = sessions.list.getSnapshot().byId[sessionId];
          if (row !== undefined && typeof row.cwd === 'string') dir = row.cwd;
        } catch (_) {}
        return api('branch', { sessionId: sessionId, dir: dir })
          .then(function (data) {
            var answer = { branch: '', workspace: '' };
            if (data !== null && typeof data === 'object' && data.ok === true) {
              if (typeof data.branch === 'string') answer.branch = data.branch;
              if (typeof data.workspace === 'string') answer.workspace = data.workspace;
            }
            HOVER_FACTS[sessionId] = answer;
            return answer;
          })
          .catch(function () {
            var empty = { branch: '', workspace: '' };
            HOVER_FACTS[sessionId] = empty;
            return empty;
          });
      };
    }

    /**
     * What this plugin adds to a session's hover card: the workspace, and the branch.
     *
     * The card itself is the Workspace bundle's, but these are the facts about a
     * session that only the host can answer — which workspace claims it, and what
     * its checkout is on — so this renders nothing until the host has answered, and
     * nothing at all for a session no workspace claims.
     *
     * The workspace reads above the session title the card draws itself, which a
     * slot cannot reach by source order; `order: -1` inside a `display: contents`
     * wrapper is what lifts it there.
     *
     * @param {object} props - the slot's props, plus the lookup this plugin adds.
     * @returns {object|null} the lines, or null when there is nothing to show.
     */
    function SessionHoverFacts(props) {
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      var lookup = props.lookup;
      var state = React.useState({ branch: '', workspace: '' });
      var facts = state[0];
      var setFacts = state[1];
      React.useEffect(
        function () {
          if (sessionId === '' || lookup === undefined) return undefined;
          // The card mounts on hover and unmounts when the pointer leaves, which
          // is usually before a slow answer arrives: writing into a component that
          // is gone has to be guarded rather than assumed.
          var alive = true;
          lookup.factsOf(sessionId).then(function (answer) {
            if (alive) setFacts(answer);
          });
          return function () {
            alive = false;
          };
        },
        [sessionId],
      );
      var lines = [];
      if (typeof facts.workspace === 'string' && facts.workspace !== '') {
        lines.push(
          React.createElement(
            'div',
            { key: 'workspace', style: S.hoverWorkspace, title: facts.workspace, 'data-worktree-workspace': facts.workspace },
            facts.workspace,
          ),
        );
      }
      if (typeof facts.branch === 'string' && facts.branch !== '') {
        lines.push(
          React.createElement(
            'div',
            { key: 'branch', style: S.hoverBranch, title: facts.branch, 'data-worktree-branch': facts.branch },
            '\u2387 ' + facts.branch,
          ),
        );
      }
      if (lines.length === 0) return null;
      return React.createElement.apply(
        null,
        ['div', { style: S.hoverFacts, 'data-worktree-hover': '' }].concat(lines),
      );
    }

    /**
     * The directory the active session is rooted in, or '' when there is none.
     *
     * The current session belongs to the UI session service (`uiSession`), not
     * to the controller's list: that list's snapshot has no `current`, only
     * `byId`, so reading it alone answers '' and the page silently asks the
     * host about its own working directory instead. The list row is what
     * carries `cwd`, so the two services are combined here.
     *
     * The settings page is not a session slot, so this cannot come from props:
     * the services arrive through declared injections in the registration and
     * are passed down as a plain string, which keeps the component free of
     * service reads that would throw in a profile composed without them.
     */
    function sessionDirOf(sessions, uiSession) {
      try {
        var key = '';
        try {
          var binding = uiSession.adapter.current.getSnapshot();
          if (binding && typeof binding.key === 'string') key = binding.key;
        } catch (_) {}
        var list = sessions.list.getSnapshot();
        if (key === '' && typeof list.current === 'string') key = list.current;
        var row = key === '' ? undefined : list.byId[key];
        return row && typeof row.cwd === 'string' ? row.cwd : '';
      } catch (_) {
        return '';
      }
    }

    /** Human-readable message for a failed host payload. */
    function messageOf(t, payload, dir) {
      if (!payload) return t('state.error');
      if (payload.error === 'not-a-repository') {
        // Name the directory: the answer is about whatever the host was asked
        // for, which is not necessarily the one the user believes they are in.
        // The explicit argument wins, and the payload's own `dir` is the same
        // fact for callers that pass only the payload (the chip does).
        var at = typeof dir === 'string' && dir !== '' ? dir : payload.dir;
        return typeof at === 'string' && at !== '' ? t('state.notRepoAt', { dir: at }) : t('state.notRepo');
      }
      return payload.message || payload.error || t('state.error');
    }

    function Badge(props) {
      return React.createElement('span', { style: Object.assign({}, S.badge, props.style || {}) }, props.children);
    }

    function Button(props) {
      var variant = props.variant === 'primary' ? S.primary : props.variant === 'danger' ? S.danger : {};
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'gord-dsh-worktree-btn' + (props.variant === 'primary' ? ' gord-dsh-worktree-primary' : ''),
          style: Object.assign({}, S.button, variant),
          disabled: props.disabled === true,
          title: props.title || undefined,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    /**
     * An icon-only button.
     *
     * The glyph is the caller's, and so is the accessible name: an icon button
     * with no text has nothing for a screen reader to announce, so `title` is
     * required in practice and is copied to `aria-label` rather than trusted to
     * be repeated at every call site.
     */
    function IconButton(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'gord-dsh-worktree-iconbtn',
          style: Object.assign({}, S.button, S.iconButton, props.danger === true ? S.danger : {}),
          disabled: props.disabled === true,
          title: props.title || undefined,
          'aria-label': props.title || undefined,
          onClick: props.onClick,
        },
        props.children,
      );
    }

    /**
     * One worktree row: identity, health badges, and the two actions that
     * matter — open it as a DSH workspace, or remove it.
     */
    function WorktreeRow(props) {
      var t = props.t;
      var entry = props.entry;
      var pending = props.pending;
      var force = props.force;
      var dropBranch = props.dropBranch;
      var branch = entry.branch || entry.head.slice(0, 7) || '—';
      // Known dirty either from the list or from the host's own refusal, which
      // is the later word and the one that cannot be stale.
      var dirty = entry.dirty === true || props.refusedDirty === true;
      // A branch that outlives this checkout — the project holds it too — is not
      // the dialog's to delete, and the host refuses to anyhow.
      var branchOwned = entry.detached !== true && typeof entry.branch === 'string' && entry.branch !== '' && entry.branchShared !== true;

      // Only conditions worth acting on are badged. Which checkout is the project
      // is not one of them — every row is a checkout of the same repository, and
      // git knows no ranking between them.
      var badges = [
        entry.detached ? React.createElement(Badge, { key: 'det', style: S.badgeWarn }, t('badge.detached')) : null,
        entry.locked ? React.createElement(Badge, { key: 'lock', style: S.badgeWarn }, t('badge.locked')) : null,
        entry.pruned ? React.createElement(Badge, { key: 'pru', style: S.badgeError }, t('badge.pruned')) : null,
      ].filter(Boolean);

      // The project's own checkout is the one worktree git cannot remove, so the
      // row simply does not offer it: a disabled button with no explanation was
      // the least clear thing on the page.
      var removable = entry.path !== props.mainRoot;
      var actions = React.createElement(
        'div',
        { style: S.actions },
        React.createElement(
          Button,
          {
            title: t('row.openHint'),
            disabled: props.busy,
            onClick: function () {
              props.onOpen(entry.path);
            },
          },
          t('row.open'),
        ),
        removable
          ? React.createElement(
              Button,
              {
                variant: 'danger',
                disabled: props.busy,
                onClick: function () {
                  props.onAskRemove(entry.path);
                },
              },
              t('row.remove'),
            )
          : null,
      );

      var confirm = pending === entry.path
        ? React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px' } },
            React.createElement('div', { style: Object.assign({}, S.notice, S.error) }, t('remove.confirm', { path: entry.path })),
            dirty ? React.createElement('div', { style: S.notice }, t('remove.dirty')) : null,
            // Two separate consents, because they are two separate acts: the
            // checkbox that discards uncommitted work, and the one that also
            // deletes the branch. Tying both to one tick is how a request to
            // discard a file ends up deleting a line of work, and the host keeps
            // them apart anyway.
            dirty
              ? React.createElement(
                  'label',
                  { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: '6px' }) },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: force,
                    onChange: function (event) {
                      props.onForceChange(event.target.checked);
                    },
                  }),
                  t('remove.force'),
                )
              : null,
            branchOwned
              ? React.createElement(
                  'label',
                  { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: '6px' }) },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: dropBranch === true,
                    onChange: function (event) {
                      props.onDropBranchChange(event.target.checked);
                    },
                  }),
                  t('remove.branch', { branch: branch }),
                )
              : null,
            // Cancel first, decision last: with the row pushed right, that puts
            // the button that acts on the far right where a confirmation is
            // expected to be.
            React.createElement(
              'div',
              { style: S.actionsEnd },
              React.createElement(
                Button,
                {
                  onClick: function () {
                    props.onAskRemove(undefined);
                  },
                },
                t('remove.cancel'),
              ),
              React.createElement(
                Button,
                {
                  variant: 'danger',
                  disabled: props.busy || (dirty && !force),
                  onClick: function () {
                    props.onRemove(entry.path, force, dropBranch === true);
                  },
                },
                t('remove.submit'),
              ),
            ),
          )
        : null;

      return React.createElement(
        'div',
        { className: 'gord-dsh-worktree-item', style: S.item },
        React.createElement(
          'div',
          { style: S.itemText },
          React.createElement(
            'div',
            { style: Object.assign({}, S.title, S.mono, S.pathLine), title: entry.path },
            entry.path,
          ),
          React.createElement(
            'div',
            { style: Object.assign({}, S.meta, S.rowBetween) },
            React.createElement(
              'div',
              { style: S.metaLeft },
              React.createElement('span', { style: S.branch, title: branch }, branch),
              badges.length > 0 ? badges : null,
            ),
            React.createElement('span', { style: S.archiveWhen }, formatTime(entry.headTime)),
          ),
          confirm,
        ),
        confirm ? null : actions,
      );
    }

    /** `2025-09-23 14:20` in the browser's own zone, or '' when there is no time. */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
      var date = new Date(ms);
      function pad(value) {
        return (value < 10 ? '0' : '') + value;
      }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /** Whole units only: this is a size hint next to a title, not a measurement. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * A session id short enough to read.
     *
     * The head names the kind of thing it is and the tail is what tells two ids
     * apart; the middle is a uuid nobody reads, and a full one is longer than the
     * title it is supposed to introduce. Anything already short is left alone.
     */
    function shortSessionId(id) {
      var text = typeof id === 'string' ? id : '';
      if (text.length <= 24) return text;
      var parts = text.split('-');
      // `session-<uuid>`: the kind and the last group tell two ids apart, and the
      // separator between them is part of what reads as an id at all.
      if (parts.length >= 3) return parts[0] + '-...-' + parts[parts.length - 1];
      return text.slice(0, 8) + '...' + text.slice(-12);
    }

    /** The last two segments of a path, which is what tells two projects apart. */
    function shortPath(path) {
      var parts = String(path).split('/').filter(function (part) { return part !== ''; });
      return parts.length <= 2 ? String(path) : '…/' + parts.slice(-2).join('/');
    }

    /**
     * What one candidate is called in the picker.
     *
     * A workspace that is a repository is named by itself. A container workspace —
     * one that is not a repository but holds several — is named by both, because
     * `apifree` alone would not say which of its projects the list is about.
     */
    function projectOption(row) {
      var label = row.title || row.path;
      return row.inside === undefined || row.inside === '' ? label : row.inside + ' › ' + label;
    }

    /** The last segment of a path: what a project is called. */
    function baseName(path) {
      var parts = String(path || '').split('/').filter(function (part) { return part !== ''; });
      return parts.length === 0 ? '' : parts[parts.length - 1];
    }

    /**
     * The archive: every session DSH has hidden, with the one control core does
     * not offer (unarchive) and the one it does not have at all (delete).
     *
     * The rows come from the host, which reads the registry's own archive set —
     * nothing here decides what is archived, and nothing here filters it, so
     * the list cannot disagree with the sidebar about what was hidden.
     *
     * Deletion is the only irreversible thing on this page. It sits behind a
     * confirm that names the count and states what goes, and it sends back
     * exactly the ids it listed rather than a "delete everything" flag: a
     * session archived between this listing and the click is not swept up by a
     * button the user pressed while looking at a different set.
     */
    function ArchiveSection(props) {
      var t = props.t;
      var stateStore = React.useState({ phase: 'loading' });
      var snap = stateStore[0];
      var setSnap = stateStore[1];
      var busyStore = React.useState('');
      var busy = busyStore[0];
      var setBusy = busyStore[1];
      var confirmStore = React.useState(false);
      var confirming = confirmStore[0];
      var setConfirming = confirmStore[1];
      // The id of the row whose own delete confirm is open, if any. Held as an
      // id rather than a boolean so it stays correct across a refresh that
      // reorders the list.
      var deleteStore = React.useState('');
      var pendingDelete = deleteStore[0];
      var setPendingDelete = deleteStore[1];
      var noteStore = React.useState(null);
      var note = noteStore[0];
      var setNote = noteStore[1];
      var alive = React.useRef(true);

      React.useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      function load() {
        setSnap({ phase: 'loading' });
        return api('archived', {}).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setSnap({ phase: 'error', payload: data });
            return;
          }
          setSnap({ phase: 'ready', data: data });
        }).catch(function (error) {
          if (!alive.current) return;
          setSnap({ phase: 'error', payload: { message: String((error && error.message) || error) } });
        });
      }

      React.useEffect(function () {
        load();
      }, []);

      /** Run one mutation, then re-read so the list always shows committed state. */
      function run(action, ids, describe) {
        setBusy(ids.length === 1 ? ids[0] : 'all');
        setNote(null);
        return api(action, { ids: ids }).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setNote({ kind: 'error', text: messageOf(t, data) });
            return;
          }
          setNote(describe(data));
          setConfirming(false);
          setPendingDelete('');
          return load();
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
          if (alive.current) setBusy('');
        });
      }

      var ready = snap.phase === 'ready' ? snap.data : null;
      var records = ready ? ready.records || [] : [];
      var ids = records.map(function (row) { return row.id; });

      var rows = records.map(function (row) {
        // The title alone does not say which record a row is, and the id alone says
        // nothing a person can recognise: the row carries both, on one line.
        var label = React.createElement(
          'span',
          { style: S.archiveLabel, title: row.title ? row.id + ' · ' + row.title : row.id },
          React.createElement('span', { style: S.archiveId }, shortSessionId(row.id)),
          row.title ? React.createElement('span', { style: S.archiveTitle }, row.title) : null,
        );
        var facts = [];
        if (row.cwd) facts.push(React.createElement('span', { key: 'cwd', style: S.archivePath, title: row.cwd }, shortPath(row.cwd)));
        // One time, not three, and no label on it: the line reads as
        // "…/path                        2026-09-23 15:39   95 KB", where a date
        // is self-evident and "updated" was three words of chrome. The last
        // write is the honest answer to "when was this last used", and the
        // archive time is the plugin's own bookkeeping rather than a fact about
        // the session, so it is not shown at all: it stays in the record file
        // and keeps ordering the list newest-first.
        var when = row.updatedAt || row.createdAt;
        // The trailing group is pushed right even when there is no path to fill
        // the space ahead of it, so the numbers stay on one edge down the list.
        facts.push(React.createElement(
          'span',
          { key: 'tail', style: S.archiveTail },
          when ? React.createElement('span', { style: S.archiveWhen }, formatTime(when)) : null,
          row.sizeBytes ? React.createElement('span', { style: S.archiveSize }, t('archive.size', { size: formatBytes(row.sizeBytes) })) : null,
        ));

        return React.createElement(
          'div',
          { key: row.id, className: 'gord-dsh-worktree-archive-row', 'data-gord-archive-row': row.id },
          React.createElement(
            'div',
            { style: S.item },
            React.createElement(
              'div',
              { style: S.itemText },
              label,
              pendingDelete === row.id ? null : React.createElement('div', { style: S.archiveMeta }, facts),
            ),
            React.createElement(
              'div',
              { style: S.actions },
              // The icon carries no text, so its label lives in the tooltip and
              // the accessible name. It sits left of Unarchive because it is the
              // rarer of the two intents, and the one worth making deliberate.
              React.createElement(
                IconButton,
                {
                  danger: true,
                  disabled: busy !== '',
                  title: t('archive.deleteOne'),
                  onClick: function () {
                    setNote(null);
                    setConfirming(false);
                    setPendingDelete(row.id);
                  },
                },
                React.createElement(IconTrash, { size: 14 }),
              ),
              React.createElement(
                Button,
                {
                  disabled: busy !== '',
                  onClick: function () {
                    run('unarchive', [row.id], function () {
                      return { kind: 'ok', text: t('archive.unarchived') };
                    });
                  },
                },
                busy === row.id ? t('archive.unarchiving') : t('archive.unarchive'),
              ),
            ),
          ),
          // One session, one confirm, inside the row it belongs to — the same
          // shape the worktree list uses, so the destructive step reads the same
          // wherever it appears.
          pendingDelete === row.id
            ? React.createElement(
                'div',
                { className: 'gord-dsh-worktree-confirm', style: S.confirm },
                React.createElement('div', { style: Object.assign({}, S.notice, S.error) }, t('archive.confirmOne')),
                React.createElement('div', { style: S.notice }, t('archive.confirmBody')),
                React.createElement(
                  'div',
                  { style: S.confirmActions },
                  React.createElement(
                    Button,
                    {
                      variant: 'danger',
                      disabled: busy !== '',
                      onClick: function () {
                        run('deleteArchived', [row.id], function (data) {
                          var text = t('archive.deleted', { n: (data.deleted || []).length });
                          var skipped = (data.skipped || []).length;
                          return { kind: skipped > 0 ? 'error' : 'ok', text: skipped > 0 ? text + '；' + t('archive.skipped', { n: skipped }) : text };
                        });
                      },
                    },
                    t('archive.confirmSubmit'),
                  ),
                  React.createElement(
                    Button,
                    {
                      disabled: busy !== '',
                      onClick: function () {
                        setPendingDelete('');
                      },
                    },
                    t('archive.cancel'),
                  ),
                ),
              )
            : null,
        );
      });

      var body;
      if (snap.phase === 'loading') {
        body = React.createElement('div', { style: S.notice }, t('archive.loading'));
      } else if (snap.phase === 'error') {
        body = React.createElement(
          'div',
          { style: Object.assign({}, S.notice, S.error) },
          snap.payload && snap.payload.error === 'no-registry'
            ? t('archive.noRegistry')
            : t('archive.failed', { message: messageOf(t, snap.payload) }),
        );
      } else if (records.length === 0) {
        body = React.createElement('div', { style: S.notice }, t('archive.empty'));
      } else {
        body = React.createElement('div', null, rows);
      }

      return React.createElement(
        'div',
        { className: 'gord-dsh-worktree-archive', style: S.card, 'data-gord-archive': 'section' },
        React.createElement(
          'div',
          { style: S.rowBetween },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' } },
            React.createElement('div', { style: S.title }, t('archive.title')),
          ),
          React.createElement(
            'div',
            { style: S.actions },
            ready ? React.createElement(Badge, { style: S.badgeAccent }, t('archive.count', { n: ready.total })) : null,
            records.length > 0
              ? React.createElement(
                  Button,
                  {
                    variant: 'danger',
                    disabled: busy !== '',
                    title: t('archive.deleteAllHint'),
                    onClick: function () {
                      setNote(null);
                      setConfirming(true);
                    },
                  },
                  t('archive.deleteAll'),
                )
              : null,
          ),
        ),
        // A confirmation belongs next to the control that raised it. With
        // 93 rows below this, one rendered after the list sits a screenful
        // away from the button that was just pressed, and reads as nothing
        // having happened at all.
        confirming
          ? React.createElement(
              'div',
              { className: 'gord-dsh-worktree-confirm', style: S.confirm },
              React.createElement(
                'div',
                { style: Object.assign({}, S.notice, S.error) },
                t('archive.confirm', { n: ids.length }),
              ),
              React.createElement('div', { style: S.notice }, t('archive.confirmBody')),
              React.createElement(
                'div',
                { style: S.confirmActions },
                React.createElement(
                  Button,
                  {
                    variant: 'danger',
                    disabled: busy !== '',
                    onClick: function () {
                      run('deleteArchived', ids, function (data) {
                        var text = t('archive.deleted', { n: (data.deleted || []).length });
                        var skipped = (data.skipped || []).length;
                        return { kind: skipped > 0 ? 'error' : 'ok', text: skipped > 0 ? text + '；' + t('archive.skipped', { n: skipped }) : text };
                      });
                    },
                  },
                  t('archive.confirmSubmit'),
                ),
                React.createElement(
                  Button,
                  {
                    disabled: busy !== '',
                    onClick: function () {
                      setConfirming(false);
                    },
                  },
                  t('archive.cancel'),
                ),
              ),
            )
          : null,
        body,
        note
          ? React.createElement(
              'div',
              { style: Object.assign({}, S.notice, note.kind === 'error' ? S.error : S.ok) },
              note.text,
            )
          : null,
        ready && ready.truncated
          ? React.createElement('div', { style: S.notice }, t('archive.truncated', { n: records.length }))
          : null,
      );
    }

    /** The label of a project: its workspace title, else its path. */
    function projectLabel(path, projects) {
      var row = projects.find(function (candidate) { return candidate.path === path; }) || projects[0];
      return row ? row.title || row.path : '';
    }

    /** The user's workspaces, as the client's own service reports them. */
    /**
     * The sessions a workspace already has, newest first.
     *
     * Membership comes from the workspace (`sessionIds`, the authoritative
     * account membership) and recency from the session summary's `updatedAt` —
     * the same pair DSH's own sidebar orders by. Anything unreadable answers
     * "none", which opens a new session rather than jumping somewhere arbitrary.
     */
    function workspaceSessionIds(workspacesService, sessionsService, workspaceId) {
      try {
        if (workspacesService === null || sessionsService === undefined) return [];
        var workspace = workspaceList(workspacesService).find(function (row) {
          return (row.workspaceId === undefined ? row.id : row.workspaceId) === workspaceId;
        });
        var ids = workspace !== undefined && Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        var byId = sessionsService.list.getSnapshot().byId || {};
        return ids.filter(function (id) {
          return byId[id] !== undefined;
        }).sort(function (left, right) {
          var rank = (byId[right].updatedAt || 0) - (byId[left].updatedAt || 0);
          return rank !== 0 ? rank : left < right ? -1 : 1;
        });
      } catch (_) {
        return [];
      }
    }

    /**
     * Register a directory as a workspace and answer its workspace id.
     *
     * Through the client's own workspace service when it has one: that service
     * updates the very store the navigation reads, and a workspace the store has
     * not heard of is one navigation refuses — which is why a second row used to
     * register and then go nowhere. The host route stays the fallback for a profile
     * whose client service cannot create.
     */
    function ensureWorkspace(service, adopt, path) {
      if (service !== null && service !== undefined && typeof service.create === 'function') {
        return Promise.resolve()
          .then(function () {
            return service.create({ path: path });
          })
          .then(function (record) {
            return record !== undefined && typeof record.workspaceId === 'string' ? record.workspaceId : '';
          })
          .catch(function () {
            return adopt();
          });
      }
      return adopt();
    }

    /**
     * Give a workspace the name its sidebar entry should carry.
     *
     * The registry names a directory after itself, which for a worktree is the bare
     * code; the composer's own create titles it `project · code`, and a row opened
     * from here has to read the same way. Only a bare name is replaced, so a name
     * the user chose is never overwritten. Best effort: naming is not the point.
     */
    function nameWorkspace(service, workspaceId, title, bare) {
      try {
        if (service === null || typeof service.rename !== 'function') return;
        var row = workspaceList(service).find(function (item) {
          return (item.workspaceId === undefined ? item.id : item.workspaceId) === workspaceId;
        });
        if (row === undefined) return;
        if (typeof row.title === 'string' && row.title !== '' && row.title !== bare) return;
        service.rename(workspaceId, title);
      } catch (_) {}
    }

    /**
     * Show a workspace's chat: the newest session it already has, or a new one.
     *
     * `openSession` is the same call a sidebar row makes; `startSession` is the
     * one the composer's picker makes. Without the navigation service neither is
     * available, and the caller reports what it did instead of pretending.
     */
    function openWorkspaceSession(service, workspaceId, ids) {
      if (service === null || service === undefined || workspaceId === '') return false;
      if (ids.length > 0) {
        service.openSession(ids[0]);
        return true;
      }
      if (typeof service.startSession === 'function') {
        service.startSession(workspaceId);
        return true;
      }
      return false;
    }

    function workspaceList(service) {
      try {
        var snapshot = service.getSnapshot();
        // The store publishes either the list itself or an object holding it.
        var items = Array.isArray(snapshot) ? snapshot : snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        return items.filter(function (row) {
          return row !== null && typeof row === 'object' && typeof row.path === 'string' && row.path !== '';
        }).sort(function (left, right) {
          // Most recently used first, which is the order the host's own project
          // list uses — so the project a fallback picks is the same either way,
          // and is the one the user was last working in.
          var a = left.updatedAt === undefined ? '' : String(left.updatedAt);
          var b = right.updatedAt === undefined ? '' : String(right.updatedAt);
          return a < b ? 1 : a > b ? -1 : 0;
        });
      } catch (_) {
        return [];
      }
    }

    /** The title of the workspace at a path, else its last path segment. */
    function workspaceLabel(path, workspaces) {
      for (var i = 0; i < workspaces.length; i++) {
        if (workspaces[i].path === path && workspaces[i].title) return workspaces[i].title;
      }
      var parts = String(path).split('/').filter(function (part) { return part !== ''; });
      return parts.length > 0 ? parts[parts.length - 1] : String(path);
    }

    /**
     * The project a worktree of this session should be cut from.
     *
     * The session's own directory when it is a repository — that is the project
     * the user is working in — and otherwise the first of their workspaces that
     * is one, which is the same thing said differently: their workspaces are
     * their projects, and a session is often parked in a directory that is not
     * a repository itself.
     *
     * Resolved by asking the host's existing `list` action, so it needs no new
     * host interface and works against a host of any version. Nothing is typed
     * and nothing is chosen: the caller shows the name it resolved.
     *
     * @param {string} startDir - the session's directory, possibly ''.
     * @param {Array<{path: string}>} workspaces - the user's workspaces.
     * @returns {Promise<string>} the project's path, or '' when none is one.
     */
    function resolveProject(startDir, workspaces) {
      var candidates = [];
      if (typeof startDir === 'string' && startDir !== '') candidates.push(startDir);
      for (var i = 0; i < workspaces.length; i++) {
        if (workspaces[i].path !== startDir) candidates.push(workspaces[i].path);
      }
      // Probed together, in order: a serial walk would make the menu wait for
      // every candidate ahead of the right one.
      return Promise.all(candidates.map(function (path) {
        return api('list', { dir: path }).then(function (data) {
          return data && data.ok === true ? path : '';
        }).catch(function () {
          return '';
        });
      })).then(function (found) {
        for (var i = 0; i < found.length; i++) {
          if (found[i] !== '') return found[i];
        }
        return '';
      });
    }

    /** The settings page: repo picker, worktree list, create form, prune. */
    function WorktreeSection(props) {
      var t = props && typeof props.t === 'function' ? props.t : fallbackT;
      var sessionDir = props && typeof props.sessionDir === 'string' ? props.sessionDir : '';
      var workspaces = props && Array.isArray(props.workspaces) ? props.workspaces : [];
      // Which project to manage. Not typed and not inferred from the session:
      // a session is often parked in a directory that is not a repository, so
      // the choice comes from the user's own workspace list (the host's `repos`
      // action), and every worktree belongs to one of those projects.
      var projectsStore = React.useState([]);
      var projects = projectsStore[0];
      var setProjects = projectsStore[1];
      var projectStore = React.useState('');
      var projectPath = projectStore[0];
      var setProjectPath = projectStore[1];
      var dir = projectPath;
      var stateStore = React.useState({ phase: 'loading' });
      var snap = stateStore[0];
      var setSnap = stateStore[1];
      var pendingStore = React.useState(undefined);
      var pending = pendingStore[0];
      var setPending = pendingStore[1];
      var forceStore = React.useState(false);
      var force = forceStore[0];
      var setForce = forceStore[1];
      var branchStore = React.useState(false);
      var dropBranch = branchStore[0];
      var setDropBranch = branchStore[1];
      // The row the host refused as dirty. It is the answer the list may have
      // been too old to give, and it buys the same acknowledgement the list's
      // own `dirty` does — without it a row that went dirty while the page was
      // open offers no way to remove it at all.
      var refusedStore = React.useState('');
      var refusedDirty = refusedStore[0];
      var setRefusedDirty = refusedStore[1];
      var busyStore = React.useState(false);
      var busy = busyStore[0];
      var setBusy = busyStore[1];
      var noteStore = React.useState(null);
      var note = noteStore[0];
      var setNote = noteStore[1];
      var alive = React.useRef(true);
      // Read on every render: the switch rewrites the same store, so the offer
      // disappears exactly when it has been taken.
      var sidebar = sidebarViewStore();
      // Hidden unless turned off; the host names the rows after this first render.
      var rowStore = React.useState(hideWorktreeRows());
      var hideRows = rowStore[0];
      var setHideRows = rowStore[1];

      React.useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      /** The project to manage, and which one is selected. */
      function loadProjects() {
        return api('repos', { dir: sessionDir }).then(function (data) {
          if (data && data.ok === true && Array.isArray(data.repos) && data.repos.length > 0) return data.repos;
          // A host without that action, or a profile without the workspace
          // controller: resolve from the client's own workspace list, which is
          // the same answer by a slower road.
          return resolveProject(sessionDir, workspaces).then(function (path) {
            return path === '' ? [] : [{ id: path, title: workspaceLabel(path, workspaces), path: path, root: path }];
          });
        }).then(function (rows) {
          if (!alive.current) return;
          setProjects(rows);
          setProjectPath(function (current) {
            var kept = rows.some(function (row) { return row.path === current; });
            if (current !== '' && kept) return current;
            // The session's own project when it has one, else the most recent.
            var preferred = rows.find(function (row) { return row.path === sessionDir || row.root === sessionDir; });
            return (preferred || rows[0] || {}).path || '';
          });
        }).catch(function () {
          /* a missing list is reported by the empty state, not by a rejection */
        });
      }

      React.useEffect(function () {
        loadProjects();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /** Load (or reload) the listing of the selected project. */
      function load() {
        if (dir === '') {
          setSnap({ phase: 'empty' });
          return Promise.resolve();
        }
        setSnap({ phase: 'loading' });
        return api('list', { dir: dir }).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setSnap({ phase: 'error', payload: data, dir: dir });
            return;
          }
          publishParents(data);
          setSnap({ phase: 'ready', data: data, dir: dir });
        }).catch(function (error) {
          if (!alive.current) return;
          setSnap({ phase: 'error', payload: { message: String((error && error.message) || error) } });
        });
      }

      React.useEffect(function () {
        load();
        // `load` closes over `dir`; re-running when the selection changes is
        // the intent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dir]);

      // Nothing on this page has to change for its list to go stale: a worktree
      // made from the composer's chip in another view lands in the same
      // repository, and this page only re-lists when its own selection changes.
      // So it re-lists whenever the user reaches for it — coming back to the tab,
      // or clicking the picker at all — rather than carrying a refresh button,
      // which is the card this page dropped.
      React.useEffect(function () {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        function onVisible() {
          if (document.visibilityState === 'hidden') return;
          loadProjects();
          load();
        }
        function onChanged() {
          loadProjects();
          load();
        }
        document.addEventListener('visibilitychange', onVisible);
        document.addEventListener(CHANGED_EVENT, onChanged);
        return function () {
          if (typeof document.removeEventListener !== 'function') return;
          document.removeEventListener('visibilitychange', onVisible);
          document.removeEventListener(CHANGED_EVENT, onChanged);
        };
        // Both loaders close over the selection; this listener follows it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dir]);

      /** Run one mutation, then refresh so the list always shows committed state. */
      function mutate(action, payload, describe) {
        setBusy(true);
        setNote(null);
        return api(action, Object.assign({ dir: dir }, payload)).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setNote({ kind: 'error', text: messageOf(t, data, dir) });
            // The host checks dirtiness again at removal time, so it is the one
            // authority on it: a refusal is what tells a dialog opened against a
            // stale list that there is something to acknowledge after all.
            if (data && data.error === 'dirty' && typeof payload.path === 'string') setRefusedDirty(payload.path);
            return;
          }
          setNote(describe(data));
          setPending(undefined);
          setForce(false);
          setDropBranch(false);
          setRefusedDirty('');
          return load();
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
          if (alive.current) setBusy(false);
        });
      }

      /**
       * Show that directory's chat: an existing session of its workspace if it has
       * one, a new one otherwise.
       *
       * The workspace is registered first because navigation takes a workspace id
       * and, like the composer's own picker, this must work for a worktree that is
       * not a workspace yet. Registration is exact-path and idempotent, so an
       * already-registered directory is simply answered with the id it has.
       */
      function openAsWorkspace(path) {
        // Registration and navigation both live in the registering scope, which
        // holds the workspace store and the client's own navigation. The panel only
        // says which worktree, and reports what happened when there was no jump.
        setBusy(true);
        setNote(null);
        Promise.resolve()
          .then(function () {
            if (typeof props.openWorktree !== 'function') return false;
            return props.openWorktree(path, baseName(projectPath));
          })
          .then(function (jumped) {
            if (!alive.current) return;
            // The worktree nests under the project it belongs to, exactly as it does
            // for one the composer created.
            publishParents({ path: path }, ready !== null ? ready.mainRoot : dir);
            // Only when there is nothing to navigate with does the page say what it
            // did instead; the row's state changed either way, so it re-lists.
            if (jumped !== true) setNote({ kind: 'ok', text: t('row.opened') + ' · ' + path });
            return load();
          })
          .catch(function (error) {
            if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
          })
          .then(function () {
            if (alive.current) setBusy(false);
          });
      }

      var ready = snap.phase === 'ready' ? snap.data : null;
      var worktrees = ready ? ready.worktrees || [] : [];

      var header = React.createElement(
        'div',
        { style: S.root },
        React.createElement(
          'div',
          { style: S.brand },
          React.createElement('div', { style: S.logo }, 'WT'),
          React.createElement(
            'div',
            { style: S.brandText },
            React.createElement('div', { style: S.name }, 'Worktrees'),
            React.createElement('div', { style: S.sub }, t('brand.sub')),
          ),
        ),
        // One control, above the list it drives: every workspace the host can read
        // a repository out of, and choosing one re-lists that project's worktrees.
        // The selection arrives already resolved from the session's own workspace,
        // so the page opens on the project the session belongs to — and it can
        // then be pointed anywhere without leaving the page.
        projects.length === 0
          ? null
          : React.createElement(
              'div',
              { style: S.pickRow },
              React.createElement('label', { style: S.label, htmlFor: 'gord-dsh-worktree-workspace' }, t('pick.workspace')),
              React.createElement(
                'select',
                {
                  id: 'gord-dsh-worktree-workspace',
                  className: 'gord-dsh-worktree-select',
                  style: Object.assign({}, S.input, S.picker),
                  value: dir,
                  disabled: busy,
                  onClick: function () {
                    // Picking what is already picked changes nothing, and that is
                    // exactly the case where the list is the one thing out of
                    // date: re-list on the click as well as on the change.
                    load();
                  },
                  onChange: function (event) {
                    setProjectPath(event.target.value);
                  },
                },
                projects.map(function (row) {
                  return React.createElement('option', { key: row.id, value: row.path }, projectOption(row));
                }),
              ),
            ),
        // What an action just did, where the actions are. It used to sit under the
        // archive card, below the fold: the click worked and the page said so out
        // of sight.
        note
          ? React.createElement(
              'pre',
              { style: Object.assign({}, S.pre, note.kind === 'error' ? S.error : S.ok) },
              note.text,
            )
          : null,
        // The project card and the create form are gone: a worktree is made from
        // the composer's own chip, where the workspace it belongs to is known,
        // and a page that only lists what exists needs no header to say which
        // project it is looking at — every row carries its path and branch.
        // What is left of them is the states a list cannot show by itself.
        snap.phase === 'empty' ? React.createElement('div', { style: S.notice }, t('repo.none')) : null,
        snap.phase === 'loading' ? React.createElement('div', { style: S.notice }, t('state.loading')) : null,
        snap.phase === 'error' ? React.createElement('div', { style: Object.assign({}, S.notice, S.error) }, messageOf(t, snap.payload, snap.dir)) : null,
        ready
          ? React.createElement(
              'div',
              { style: S.card },
              React.createElement(
                'div',
                { style: S.rowBetween },
                React.createElement('div', { style: S.title }, t('list.title')),
                React.createElement('div', { style: S.desc }, t('list.count', { n: worktrees.length })),
              ),
              worktrees.length === 0
                ? React.createElement('div', { style: S.desc }, t('state.empty'))
                : worktrees.map(function (entry) {
                    return React.createElement(WorktreeRow, {
                      key: entry.path,
                      entry: entry,
                      t: t,
                      mainRoot: ready.mainRoot,
                      pending: pending,
                      force: force,
                      dropBranch: dropBranch,
                      refusedDirty: refusedDirty === entry.path,
                      busy: busy,
                      onAskRemove: function (path) {
                        setForce(false);
                        setDropBranch(false);
                        // Opening or dismissing the dialog is a new question, so
                        // the previous refusal does not answer it.
                        setRefusedDirty('');
                        setPending(path);
                      },
                      onForceChange: setForce,
                      onDropBranchChange: setDropBranch,
                      onRemove: function (path, useForce, deleteBranch) {
                        mutate('remove', { path: path, force: useForce, deleteBranch: deleteBranch }, function (data) {
                          return { kind: 'ok', text: t('remove.done', { path: data.removed }) };
                        });
                      },
                      onOpen: openAsWorkspace,
                    });
                  }),
              React.createElement(
                'div',
                { style: S.actions },
                React.createElement(
                  Button,
                  {
                    disabled: busy,
                    onClick: function () {
                      mutate('prune', {}, function (data) {
                        var output = String(data.output || '').trim();
                        return output === '' ? { kind: 'ok', text: t('prune.done') } : { kind: 'ok', text: t('prune.result', { output: output }) };
                      });
                    },
                  },
                  t('prune.submit'),
                ),
                React.createElement(
                  Button,
                  {
                    disabled: busy,
                    onClick: function () {
                      mutate('relocate', {}, function (data) {
                        var moved = Array.isArray(data.moved) ? data.moved.length : 0;
                        var failed = Array.isArray(data.failed) ? data.failed.length : 0;
                        if (moved === 0) return { kind: 'ok', text: t('relocate.none') };
                        if (failed > 0) return { kind: 'error', text: t('relocate.failed', { count: String(moved), failed: String(failed) }) };
                        return { kind: 'ok', text: t('relocate.done', { count: String(moved) }) };
                      });
                    },
                  },
                  t('relocate.submit'),
                ),
                sidebar !== undefined && sidebar.state.groupBy !== 'workspace-tree'
                  ? React.createElement(
                      Button,
                      {
                        onClick: function () {
                          if (showSidebarAsTree(sidebar)) setNote({ kind: 'ok', text: t('sidebar.treeDone') });
                        },
                      },
                      t('sidebar.tree'),
                    )
                  : null,
              ),
              React.createElement(
                'label',
                { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: '6px' }) },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: hideRows,
                  onChange: function (event) {
                    setHideRows(event.target.checked);
                    setWorktreeRowsHidden(event.target.checked);
                  },
                }),
                t('rows.hide'),
              ),
            )
          : null,
        React.createElement(ArchiveSection, { t: t }),
      );

      return header;
    }

    /**
     * The working-location picker for a New Session: pick one of the
     * repository's worktrees, or create another one under the same project.
     *
     * Placement. The Hero's own row — workspace, then agent preset — is laid
     * out by the core plugin, and all three `conversation.hero.*` slots are
     * `single`, so a third control cannot be joined to that row. This instead
     * occupies `conversation.input.dock` ("full-width entries above the
     * composer card"), which the Hero renders *after* that row and *before*
     * the input. The vertical reading order is therefore the requested
     * workspace → preset → worktree.
     *
     * Visibility. It is contributed only while the addressed session is still
     * blank (`SessionSnapshot.blank`), which is the same fact the core Hero
     * uses to decide it is a New Session. Once the first turn starts the chip
     * is gone: a session's directory is fixed at creation, so there is nothing
     * left for it to choose.
     *
     * @param props.ctx - client cordis context, for the injected `sessions` service.
     * @param props.t - namespaced translator.
     * @param props.session - the addressed session, from the `input.dock` owner.
     * @param props.onClose - closes the picker, called after a worktree is used.
     */
    function WorktreeChip(props) {
      var t = props && typeof props.t === 'function' ? props.t : fallbackT;
      var ctx = props && props.ctx;
      var openStore = React.useState(false);
      var open = openStore[0];
      var setOpen = openStore[1];
      // The dock owner passes the addressed session; fall back to the store so
      // the chip still resolves a directory if a future owner omits it.
      var session = props && props.session;
      var snapStore = React.useState({ phase: 'idle' });
      var snap = snapStore[0];
      var setSnap = snapStore[1];
      var busyStore = React.useState(false);
      var busy = busyStore[0];
      var setBusy = busyStore[1];
      var noteStore = React.useState(null);
      var note = noteStore[0];
      var setNote = noteStore[1];
      var alive = React.useRef(true);
      // The directory the current snapshot was loaded for. The subscriber below
      // cannot compare against a state variable — it closes over the first render
      // — so the directory it last saw lives in a ref.
      var loadedDir = React.useRef('');
      // Where this control is drawn: the Hero's own working-location row. That
      // row is laid out by the core plugin and every slot in it is `single`, so
      // it cannot take a third occupant — a second entry would shadow the first
      // rather than sit beside it. Rendering into the row's element directly is
      // how the core plugins place themselves inside surfaces they do not own,
      // and it is the only way to be *on* that row instead of in a band below.
      var hostRef = React.useRef(null);
      // The trigger and its menu share this node, so containment is decided by
      // one check: a pointer landing inside it is an interaction with the
      // control, anything else is a dismissal.
      var rootRef = React.useRef(null);
      var buttonRef = React.useRef(null);
      var rowStore = React.useState(null);
      var row = rowStore[0];
      var setRow = rowStore[1];
      /** The projects a worktree can be cut from. Needed here because the
      // session's own directory is often not a repository — and a worktree of
      // some project is what the control is for. */

      React.useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      // Dismissal. The core selectors this one imitates get this from the
      // shared `Menu` primitive; this menu cannot use it, because the create
      // flow needs a form inside the panel and `Menu` items are a flat
      // `{id, label}` list. So the behaviour is reproduced here: a pointer
      // anywhere outside closes it, and Escape closes it and hands focus back
      // to the trigger. Capture phase, so a handler that stops propagation
      // further in cannot leave the menu stranded open.
      React.useEffect(function () {
        if (!open) return undefined;
        function outside(event) {
          var root = rootRef.current;
          if (root === null) return;
          // Duck-typed rather than `instanceof Node`: `contains` converts its
          // argument as a Node and throws on anything else, and `instanceof`
          // also fails across realms. A real event target always carries a
          // numeric `nodeType`.
          var target = event.target;
          if (target !== null && typeof target === 'object' && typeof target.nodeType === 'number' && root.contains(target)) return;
          setOpen(false);
        }
        function escape(event) {
          if (event.key !== 'Escape') return;
          setOpen(false);
          if (buttonRef.current && typeof buttonRef.current.focus === 'function') buttonRef.current.focus();
        }
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        return function () {
          document.removeEventListener('pointerdown', outside, true);
          document.removeEventListener('keydown', escape, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      React.useEffect(function () {
        // Locate the row from this node outward rather than by a document-wide
        // query: the row's class name is build-hashed and unstable, while the
        // slot wrapper's `data-slot` attribute is the documented anchor. Our own
        // host is rendered by the dock, which lives in the same composer stack,
        // so walking outward finds this row and not another Hero's.
        function locate() {
          var el = hostRef.current;
          while (el) {
            if (typeof el.querySelector === 'function') {
              var anchor = el.querySelector('[data-slot="conversation.hero.workspace"]');
              if (anchor && anchor.parentElement) return anchor.parentElement;
            }
            el = el.parentElement;
          }
          return null;
        }
        function tick() {
          var found = locate();
          if (!found) return false;
          setRow(function (current) { return current === found ? current : found; });
          return true;
        }
        if (tick()) return undefined;
        // The row and this host mount in the same commit, but the row can
        // appear a frame later; poll briefly instead of assuming an order.
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          if (tick() || tries > 40) clearInterval(timer);
        }, 100);
        return function () { clearInterval(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);


      /**
       * The directory the current session is rooted in.
       *
       * The slot owner passes `{}`, so this cannot come from props. `sessions`
       * is injected rather than read with `ctx.get`: an un-injected service
       * read as a property throws inside render, which would take the whole
       * composer down instead of just losing this chip.
       */
      function currentDir() {
        try {
          if (session !== undefined && typeof session.cwd === 'string') return session.cwd;
          // Mirrors `sessionDirOf`: the controller's list snapshot carries no
          // `current`, so the session key comes from `uiSession`.
          var key = '';
          try {
            var binding = ctx.uiSession.adapter.current.getSnapshot();
            if (binding && typeof binding.key === 'string') key = binding.key;
          } catch (_) {}
          if (key === '') return '';
          var summary = ctx.sessions.list.getSnapshot().byId[key];
          return summary && typeof summary.cwd === 'string' ? summary.cwd : '';
        } catch (_) {
          return '';
        }
      }

      /** Load the worktrees of the repository containing `dir`. */
      function load(dir) {
        if (dir === '') {
          setSnap({ phase: 'norepo' });
          return Promise.resolve();
        }
        setSnap({ phase: 'loading' });
        // `dirty` because this panel is the one surface that removes a worktree:
        // the dialog warns from it and offers the acknowledgement that discards
        // the work. The chip and the pickers ask the same action without it.
        return api('list', { dir: dir, dirty: true }).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setSnap({ phase: 'error', payload: data });
            return;
          }
          publishParents(data);
          setSnap({ phase: 'ready', dir: dir, data: data });
        }).catch(function (error) {
          if (!alive.current) return;
          setSnap({ phase: 'error', payload: { message: String((error && error.message) || error) } });
        });
      }

      // Refresh on open, and whenever the session's directory changes under us.
      React.useEffect(function () {
        if (!open) return undefined;
        var start = currentDir();
        loadedDir.current = start;
        load(start);
        var sessions = null;
        try {
          sessions = ctx.sessions;
        } catch (_) {
          sessions = null;
        }
        if (sessions === null || sessions.list === undefined) return undefined;
        var stop = sessions.list.subscribe(function () {
          var next = currentDir();
          if (next === loadedDir.current) return;
          loadedDir.current = next;
          load(next);
        });
        return stop;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      /**
       * Make a new worktree and move this session into it.
       *
       * The order is forced by the platform, and it is why this runs on the
       * click rather than on the first message. A session's directory is fixed
       * when the session is created, and the blank session in the composer is
       * created before anything is typed — so there is no later moment at which
       * a message could be aimed at a directory that does not exist yet. The
       * only way to have the conversation run in the worktree is to make the
       * worktree, then start a session rooted in it, which is what this does.
       *
       * No workspace is registered. That is not an oversight: registering one
       * would put a second entry in the sidebar for what is the same project.
       * The directory is reported so it can also be named to the agent.
       */
      /**
       * The workspace this new session is being started in.
       *
       * The picker sits in this very row — the chip is rendered into it — and its
       * label is the workspace the user chose. Reading it is the only way to know
       * the choice before the session starts: a blank session has no directory
       * and is not yet filed under a workspace, and the plugin is asked for a
       * worktree precisely before the first message is sent.
       *
       * @returns {string} the workspace's path, or '' when it cannot be read.
       */
      function chosenWorkspace() {
        var items = props && Array.isArray(props.workspaces) ? props.workspaces : [];
        var found = { label: '', path: '' };
        if (row === null || row === undefined || typeof row.querySelector !== 'function') return found;
        // The label is not in the slot: the core renders the row as
        // [ WorkspaceChip ] [ conversation.hero.workspace ] [ preset ], and the
        // chip — the button that shows the chosen workspace — is the slot's
        // previous sibling. Reading the slot would read the picker's popover,
        // which is usually empty and never the choice.
        var label = '';
        var anchor = row.querySelector('[data-slot="conversation.hero.workspace"]');
        var chip = anchor === null || anchor === undefined ? null : anchor.previousElementSibling;
        if (chip !== null && chip !== undefined) {
          var span = chip.querySelector === undefined ? null : chip.querySelector('span');
          label = String((span === null || span === undefined ? chip : span).textContent || '').trim();
        }
        if (label === '') {
          // A build that renders no slot beside it: the row's own button that
          // names a workspace is still found by matching a known name.
          var buttons = typeof row.querySelectorAll === 'function' ? row.querySelectorAll('button') : [];
          for (var b = 0; b < buttons.length && label === ''; b++) {
            var text = String(buttons[b].textContent || '').trim();
            for (var k = 0; k < items.length; k++) {
              if (text === items[k].title) { label = text; break; }
            }
          }
        }
        if (label === '') return found;
        found.label = label;
        for (var i = 0; i < items.length; i++) {
          if (items[i].title === label) { found.path = items[i].path; return found; }
        }
        // The picker may name the directory instead of the workspace.
        for (var j = 0; j < items.length; j++) {
          if (label === items[j].path || label.indexOf(items[j].path) !== -1) { found.path = items[j].path; return found; }
        }
        // The name is still worth sending: the host knows every workspace, while
        // this side only knows what the plugin was handed.
        return found;
      }

      /**
       * The project to cut a worktree from when the session's own directory is
       * not in a repository.
       *
       * The host answers with the user's repository workspaces, most recently
       * used first, once it has the `repos` action; without it the same list is
       * read from the client's own workspace service. Either way the answer is
       * the project the user was last working in, and it is used rather than
       * asked about.
       *
       * @param {string} startDir - the session's directory, possibly ''.
       * @returns {Promise<string>} the project's path, or '' when none is one.
       */
      function projectForWorktree(startDir) {
        var workspaces = props && Array.isArray(props.workspaces) ? props.workspaces : [];
        var sessionId = props && props.session && typeof props.session.id === 'string' ? props.session.id : '';
        // The workspace picked in this row is the answer when it can be read;
        // otherwise the session's own workspace is asked for, which is the same
        // answer for a session that has already started.
        var fromWorkspaces = function (dir) {
          return resolveProject(dir === '' ? startDir : dir, workspaces).then(function (path) {
            return { path: path, root: path, workspace: path };
          });
        };
        var chosen = chosenWorkspace();
        var ask = chosen.path === '' ? startDir : chosen.path;
        return api('repos', { sessionId: sessionId, dir: ask, title: chosen.label }).then(function (data) {
          var rows = data && data.ok === true && Array.isArray(data.repos) ? data.repos : [];
          if (rows.length === 0) return fromWorkspaces(chosen.path);
          var own = rows.find(function (row) {
            return row.path === ask || row.root === ask || (Array.isArray(row.workspaces) && row.workspaces.includes(ask));
          });
          var pick = own || rows[0];
          return {
            path: pick.path,
            root: pick.root === undefined ? pick.path : pick.root,
            // The workspace the project belongs to. The sidebar folds a
            // worktree under a *workspace*, not under a repository, so this —
            // not the repository root — is what has to be published: for a
            // container workspace like `apifree`, the repository inside it is
            // not a workspace the sidebar could fold anything under.
            workspace: pick.workspace === undefined ? pick.root : pick.workspace,
          };
        }).catch(function () {
          return fromWorkspaces(chosen.path);
        });
      }

      function startNewWorktree() {
        setBusy(true);
        // The session's own repository when it is in one. Otherwise the project
        // is resolved: a session parked in a container directory still belongs to
        // a project, and the one it belongs to is the one the user works in —
        // their most recently used workspace that is a repository. Resolved on
        // the click, so the menu above asks nothing and shows no name it would
        // have to explain.
        var project = snap.phase === 'ready'
          ? Promise.resolve({
            path: snap.dir,
            root: (snap.data && snap.data.mainRoot) || snap.dir,
            workspace: chosenWorkspace().path,
          })
          : projectForWorktree(currentDir());
        var projectRoot = '';
        // No branch and no base: the host checks out the project's current
        // branch — a second working copy of it — and names the directory after a
        // fresh code, so this needs no input and cannot collide with an earlier
        // copy.
        project.then(function (target) {
          if (target === null || target.path === '') throw new Error(t('chip.noProject'));
          // Published as the sidebar reads it: the workspace that owns the
          // project, which is the project itself when it is a repository.
          projectRoot = target.workspace !== undefined && target.workspace !== ''
            ? target.workspace
            : target.root === undefined ? target.path : target.root;
          return api('create', { dir: target.path, branch: '', base: '' });
        }).then(function (data) {
          if (!data || data.ok !== true) throw new Error(messageOf(t, data));
          if (!alive.current) return undefined;
          // Published here as well as on list, because the chip only lists once
          // when it mounts: a worktree made now is in no listing this component
          // ever saw, so the sidebar would keep showing it as its own project
          // until something else happened to refresh.
          // With the project it came from, so the sidebar files the new
          // workspace under that project rather than at the top level.
          publishParents(data, projectRoot);
          announceChange();
          setNote({ kind: 'ok', text: t('create.done', { path: data.path, branch: data.branch }) });
          if (!data.workspace || data.workspace.error) {
            // The checkout succeeded; only the session could not be started.
            throw new Error(t('chip.bindFailed', { message: String((data.workspace && data.workspace.error) || t('chip.noRegistry')) }));
          }
          return bindSession(data.workspace);
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
          if (alive.current) setBusy(false);
        });
      }

      /**
       * Start a session in the new worktree and open it, so the next message is
       * sent there.
       *
       * Addressed by `workspaceId` rather than by `cwd`, and not by choice: the
       * two are mutually exclusive, and a session given only a directory has no
       * workspace to belong to, which leaves the shell with nowhere to draw it
       * — it renders "choose a workspace to start" over a session that exists.
       * The host registers the workspace for the same reason.
       *
       * `sessions.create` resolves to the new session **id** (a bare string),
       * not a result object — a distinction the earlier implementation got
       * wrong while a stub masked it.
       *
       * @param workspace - the adopted workspace for the new worktree.
       */
      function bindSession(workspace) {
        var sessions = ctx.sessions;
        return sessions.create({ workspaceId: workspace.workspaceId }).then(function (sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new Error(t('chip.openFailed', { message: String(sessionId) }));
          }
          openSession(sessions, sessionId);
        });
      }

      /**
       * Bring the session just created to the front.
       *
       * `sessions.open(id)` was the 0.1.5 spelling. It left the session
       * controller in 0.1.6, and navigation now belongs to the workspace plugin,
       * which publishes `uiWorkspace.openSession` — the same call a sidebar row
       * makes when it is clicked. That service is read rather than injected: a
       * composition without a workspace view must still create the session, and
       * `ctx.get` is the non-throwing lookup, exactly as the core plugins use it.
       *
       * @param sessions - the injected session controller, whose `open` older
       *   builds still carry.
       * @param sessionId - the id `sessions.create` resolved.
       */
      function openSession(sessions, sessionId) {
        var navigation = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
        if (navigation !== undefined && typeof navigation.openSession === 'function') {
          navigation.openSession(sessionId);
          return;
        }
        if (typeof sessions.open === 'function') sessions.open(sessionId);
      }

      // The default is the project's own directory — "local" — which is where a
      // session starts unless a worktree is asked for. Existing worktrees are
      // then options beside it, and creating one is the last option.
      var value = t('chip.local');

      /** One selectable row of the dropdown. */
      function option(key, title, sub, active, onPick) {
        return React.createElement(
          'button',
          {
            key: key,
            type: 'button',
            className: 'gord-dsh-worktree-option' + (active ? ' gord-dsh-worktree-option-active' : ''),
            style: S.option,
            disabled: busy,
            onClick: onPick,
          },
          React.createElement('span', { style: S.optionMark }, active ? '\u2713' : ''),
          React.createElement(
            'span',
            { style: S.field },
            React.createElement('span', { style: S.title }, title),
            sub ? React.createElement('span', { style: S.desc }, sub) : null,
          ),
        );
      }

      var items = [];
      if (open) {
        // Two entries, as this control has always had them, and nothing else:
        // the worktree the session is already in, and a new one. There is no
        // project to pick and no directory to type — the project is resolved
        // when a new worktree is asked for, and named nowhere before then.
        //
        // The project's own directory. It is the only selectable entry: the
        // other worktrees of a project are workspaces in their own right once
        // created, so they are reached from the workspace picker rather than
        // listed again here.
        items.push(option('local', t('chip.local'), snap.phase === 'ready' ? snap.dir : '', true, function () {
          setOpen(false);
        }));
        // The second choice, and nothing to fill in: the branch is cut from the
        // current one and named for the code that names the directory, so the
        // whole decision is "a fresh checkout" versus "here".
        items.push(option('new', t('chip.new'), busy ? t('chip.creating') : t('chip.newDesc'), false, function () {
          if (busy) return;
          setNote(null);
          startNewWorktree();
        }));
        if (note) {
          items.push(React.createElement('pre', {
            key: 'note',
            style: Object.assign({}, S.pre, note.kind === 'error' ? S.error : S.ok),
          }, note.text));
        }
      }

      // The control itself: label, current value, caret — the same shape as the
      // workspace and preset controls it sits between. The menu floats so that
      // opening it cannot reflow the row it lives in.
      // Markup copied from the two controls this sits between: an icon, the
      // value, and the shared chevron, all inside one borderless pill. The
      // class names differ only because the styles must live in this bundle,
      // but every declaration is the same as theirs, so the three render
      // identically instead of merely similarly.
      var control = React.createElement(
        'div',
        { ref: rootRef, style: S.anchor, 'data-gord-worktree': 'trigger' },
        React.createElement(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'gord-dsh-worktree-seat' + (open ? ' gord-dsh-worktree-seat-open' : ''),
            style: S.seat,
            onClick: function () { setOpen(!open); },
            title: t('chip.label') + ' · ' + t('chip.pickHint'),
            'aria-label': t('chip.label'),
            'aria-haspopup': 'menu',
            'aria-expanded': open,
          },
          React.createElement(IconBranch, { size: 16, className: 'gord-dsh-worktree-seatIcon', style: S.seatIcon }),
          React.createElement('span', { className: 'gord-dsh-worktree-seatLabel', style: S.seatLabel }, value),
          React.createElement(IconChevronDown, { size: 12, className: 'gord-dsh-worktree-chevron', style: S.chevron }),
        ),
        open ? React.createElement('div', { style: S.menu, role: 'menu' }, items) : null,
      );

      // The host is what locates the row; the control is portaled onto it. If
      // the row cannot be found the control is rendered in place, so the picker
      // degrades to the band below rather than disappearing.
      return React.createElement(
        'div',
        { ref: hostRef, style: S.host },
        row !== null
          ? ReactDOM.createPortal(control, row)
          : control,
      );
    }

    /**
     * Register the settings page and its dictionaries.
     *
     * @param ctx - client cordis context (needs `slots`).
     */
    /**
     * Right-sidebar tab type for this plugin.
     *
     * The id is the package id because it doubles as the slot key the two
     * `sidebar.right.*` registrations are filed under, and the kind is the
     * short name a caller passes to `openTab` and sees on the guide page.
     */
    var DIFF_ID = 'gord-dsh-worktree';
    /** Short kind of the Changes tab. */
    var DIFF_KIND = 'worktree-diff';
    /**
     * Glyph for the tab and its guide entry: the edit pencil, or the branch this
     * plugin already draws when the build ships no pencil. Both names are tried
     * per scheme, and `icon` never returns `undefined`, because a glyph the
     * running primitives package no longer exports would otherwise throw where
     * React renders the guide capsule.
     */
    var DIFF_ICON = icon([
      'IconEditOutlineRegular',
      'IconEditOutline16',
      'IconBranchOutlineRegular',
      'IconBranchOutline16',
    ]);
    /** Patch lines drawn before the rest waits behind a click. */
    var DIFF_PREVIEW_LINES = 400;

    /** Changes-pane styles: inline, like the rest of the plugin, theme variables. */
    var DS = {
      pane: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: '0',
        height: '100%',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      bar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '7px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
      },
      barText: { flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' },
      branch: {
        flex: 'none',
        maxWidth: '45%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      totals: {
        flex: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-caption, inherit)',
      },
      refresh: {
        flex: 'none',
        boxSizing: 'border-box',
        padding: '3px 8px',
        fontSize: '11px',
        lineHeight: '16px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      files: {
        flex: 'none',
        maxHeight: '38%',
        overflowY: 'auto',
        borderBottom: '1px solid var(--dsw-alias-border-l2, #e1e5ee)',
      },
      file: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '7px',
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 10px',
        background: 'transparent',
        border: '0 none transparent',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      fileActive: { background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.08))' },
      code: {
        flex: 'none',
        width: '16px',
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
      },
      filePath: { flex: '1', minWidth: '0', display: 'flex', alignItems: 'baseline', overflow: 'hidden' },
      dir: {
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        color: 'var(--dsw-alias-label-caption, inherit)',
        fontSize: '11px',
      },
      base: { flex: 'none', whiteSpace: 'nowrap' },
      counts: {
        flex: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-caption, inherit)',
      },
      patch: { flex: '1', minHeight: '0', overflow: 'auto', padding: '4px 0 12px' },
      row: {
        display: 'flex',
        alignItems: 'flex-start',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        lineHeight: '17px',
      },
      gutter: {
        flex: 'none',
        width: '3.2em',
        padding: '0 6px 0 4px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-caption, inherit)',
        userSelect: 'none',
      },
      lineText: { flex: '1', minWidth: '0', whiteSpace: 'pre', paddingRight: '10px' },
      state: {
        padding: '18px 12px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      more: {
        display: 'block',
        width: 'calc(100% - 20px)',
        margin: '6px 10px',
        padding: '5px 8px',
        fontSize: '11px',
        lineHeight: '16px',
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.08))',
        border: '0 none transparent',
        borderRadius: '6px',
        cursor: 'pointer',
      },
    };

    /** Backgrounds a patch row wears, by the kind `diffRows` gave it. */
    var ROW_BG = {
      add: 'var(--dsw-alias-state-success-soft, rgba(63,154,109,.14))',
      del: 'var(--dsw-alias-state-error-soft, rgba(217,107,90,.14))',
      hunk: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.06))',
    };

    /**
     * Colour of a porcelain status code.
     *
     * Both columns count: `A` anywhere is an addition, `D` a deletion, `R`/`C`
     * a move, and a plain modification is what is left.
     */
    function statusColor(code) {
      if (code.indexOf('?') >= 0 || code.indexOf('A') >= 0) return 'var(--dsw-alias-state-success-primary, #3f9a6d)';
      if (code.indexOf('D') >= 0) return 'var(--dsw-alias-state-error-primary, #d96b5a)';
      if (code.indexOf('R') >= 0 || code.indexOf('C') >= 0) return 'var(--dsw-alias-brand-primary, #4176e6)';
      return 'var(--dsw-alias-state-warning-primary, #b07a2b)';
    }

    /**
     * One file's patch as drawable rows, with the line numbers a diff shows.
     *
     * The file headers (`diff --git`, `index`, `---`, `+++`, `rename …`) are
     * separated from hunks so they can be dimmed rather than mistaken for
     * content, and the `+++`/`---` pair is classified before the `+`/`-` cases
     * that would otherwise swallow it.
     */
    function diffRows(patch) {
      var rows = [];
      var oldNo = 0;
      var newNo = 0;
      var lines = String(patch).split('\n');
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        var hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          oldNo = Number(hunk[1]);
          newNo = Number(hunk[2]);
          rows.push({ kind: 'hunk', text: line, old: '', now: '' });
          continue;
        }
        if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')
          || line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('new file')
          || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode')
          || line.startsWith('Binary files') || line.startsWith('\\ No newline')) {
          rows.push({ kind: 'meta', text: line, old: '', now: '' });
          continue;
        }
        if (line.startsWith('+')) {
          rows.push({ kind: 'add', text: line, old: '', now: String(newNo) });
          newNo += 1;
          continue;
        }
        if (line.startsWith('-')) {
          rows.push({ kind: 'del', text: line, old: String(oldNo), now: '' });
          oldNo += 1;
          continue;
        }
        rows.push({ kind: 'ctx', text: line, old: String(oldNo), now: String(newNo) });
        oldNo += 1;
        newNo += 1;
      }
      return rows;
    }

    /** Split a path into the part that may be dropped and the part that may not. */
    function pathParts(path) {
      var at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      if (at < 0) return { dir: '', base: path };
      return { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
    }

    /** The Changes tab's title in the pane's tab strip. */
    function ChangesTitle(props) {
      var tab = props && props.useTabInfo ? props.useTabInfo().tab : undefined;
      return React.createElement(React.Fragment, null,
        React.createElement(DIFF_ICON, { size: 16 }),
        React.createElement('span', null, tab ? tab.title : ''));
    }

    /**
     * The Changes tab: the uncommitted diff of the session's own directory.
     *
     * `cwd` comes from the session, so the pane follows a session into a
     * worktree without being told it did — the host answers for whichever
     * repository that directory belongs to.
     */
    function ChangesBody(props) {
      var t = props && typeof props.t === 'function' ? props.t : fallbackT;
      var sessionId = props ? props.sessionId : undefined;
      var useSessions = props ? props.useSessions : undefined;
      var cwd = useSessions ? useSessions(function (sessions) {
        var row = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
        return row ? row.cwd : undefined;
      }) : undefined;
      var snap = React.useState({ phase: 'idle' });
      var state = snap[0];
      var setState = snap[1];
      var pick = React.useState(0);
      var picked = pick[0];
      var setPicked = pick[1];
      var wide = React.useState(false);
      var expanded = wide[0];
      var setExpanded = wide[1];
      var alive = React.useRef(true);
      React.useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      var load = React.useCallback(function () {
        if (cwd === undefined || cwd === '') return;
        setState({ phase: 'loading' });
        api('diff', { dir: cwd }).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setState({ phase: 'error', data: data });
            return;
          }
          setState({ phase: 'ready', data: data });
          setPicked(0);
          setExpanded(false);
        }).catch(function (error) {
          if (!alive.current) return;
          setState({ phase: 'error', data: { message: String((error && error.message) || error) } });
        });
      }, [cwd]);

      React.useEffect(function () {
        load();
      }, [load]);

      if (cwd === undefined) {
        return React.createElement('div', { style: DS.state, 'data-worktree-changes': 'no-session' }, t('diff.loading'));
      }
      if (state.phase === 'loading' || state.phase === 'idle') {
        return React.createElement('div', { style: DS.state, 'data-worktree-changes': 'loading' }, t('diff.loading'));
      }
      if (state.phase === 'error') {
        var failure = state.data || {};
        var message = failure.error === 'not-a-repository'
          ? t('diff.notRepo')
          : t('diff.failed', { message: String(failure.message || failure.error || '') });
        return React.createElement('div', { style: DS.state, 'data-worktree-changes': 'error' },
          React.createElement('div', { style: S.error }, message),
          React.createElement('button', { type: 'button', style: Object.assign({}, DS.refresh, { marginTop: '8px' }), onClick: load }, t('diff.refresh')));
      }

      var data = state.data || {};
      var files = Array.isArray(data.files) ? data.files : [];
      var added = 0;
      var removed = 0;
      for (var i = 0; i < files.length; i += 1) {
        added += files[i].additions || 0;
        removed += files[i].deletions || 0;
      }
      var current = files[picked];

      var children = [
        React.createElement('div', { style: DS.bar, key: 'bar' },
          React.createElement('div', { style: DS.barText },
            data.branch ? React.createElement('span', { style: DS.branch, title: data.root }, data.branch) : null,
            React.createElement('span', { style: DS.totals }, t('diff.files', { count: files.length })),
            files.length > 0 ? React.createElement('span', { style: DS.totals }, t('diff.totals', { added: added, removed: removed })) : null),
          React.createElement('button', {
            type: 'button',
            style: DS.refresh,
            className: 'gord-dsh-worktree-btn',
            onClick: load,
          }, t('diff.refresh'))),
      ];

      if (files.length === 0) {
        children.push(React.createElement('div', { style: DS.state, key: 'clean', 'data-worktree-changes': 'clean' }, t('diff.clean')));
        return React.createElement('div', { style: DS.pane, 'data-worktree-changes': 'pane' }, children);
      }

      children.push(React.createElement('div', { style: DS.files, key: 'files', 'data-worktree-changes': 'files' },
        files.map(function (file, index) {
          var parts = pathParts(file.path);
          var counts = (file.additions || file.deletions)
            ? t('diff.totals', { added: file.additions || 0, removed: file.deletions || 0 })
            : '';
          return React.createElement('button', {
            type: 'button',
            key: file.path,
            style: index === picked ? Object.assign({}, DS.file, DS.fileActive) : DS.file,
            className: 'gord-dsh-worktree-file',
            onClick: function () {
              setPicked(index);
              setExpanded(false);
            },
          },
          React.createElement('span', { style: Object.assign({}, DS.code, { color: statusColor(file.code) }) }, file.code.replace(/\./g, ' ')),
          React.createElement('span', { style: DS.filePath, title: file.path },
            parts.dir ? React.createElement('span', { style: DS.dir }, parts.dir) : null,
            React.createElement('span', { style: DS.base }, parts.base)),
          React.createElement('span', { style: DS.counts }, counts));
        })));

      if (data.truncated) {
        children.push(React.createElement('div', { style: Object.assign({}, DS.state, { padding: '6px 10px' }), key: 'truncated' },
          t('diff.truncated', { count: files.length })));
      }

      if (current !== undefined) {
        if (current.binary) {
          children.push(React.createElement('div', { style: DS.state, key: 'binary' }, t('diff.binary')));
        } else if (!current.patch) {
          children.push(React.createElement('div', { style: DS.state, key: 'nopatch' }, t('diff.noPatch')));
        } else {
          var rows = diffRows(current.patch);
          var hidden = Math.max(0, rows.length - DIFF_PREVIEW_LINES);
          var shown = expanded || hidden === 0 ? rows : rows.slice(0, DIFF_PREVIEW_LINES);
          children.push(React.createElement('div', { style: DS.patch, key: 'patch', 'data-worktree-changes': 'patch' },
            shown.map(function (row, index) {
              return React.createElement('div', {
                key: index,
                style: Object.assign({}, DS.row, ROW_BG[row.kind] ? { background: ROW_BG[row.kind] } : {}),
              },
              React.createElement('span', { style: DS.gutter }, row.old),
              React.createElement('span', { style: DS.gutter }, row.now),
              React.createElement('span', {
                style: Object.assign({}, DS.lineText, row.kind === 'meta' ? { color: 'var(--dsw-alias-label-caption, inherit)' } : {}),
              }, row.text));
            }),
            hidden > 0 ? React.createElement('button', {
              type: 'button',
              style: DS.more,
              onClick: function () {
                setExpanded(!expanded);
              },
            }, expanded ? t('diff.collapse') : t('diff.expand', { count: hidden })) : null));
        }
      }

      return React.createElement('div', { style: DS.pane, 'data-worktree-changes': 'pane' }, children);
    }

    function apply(ctx) {
      // A worktree's sidebar row is a folder line above its own sessions; hiding
      // it leaves the sessions on screen, which is the shape a patched 0.1.x
      // sidebar already has.
      watchWorktreeRows(ctx);
      // `locale` must be declared in `inject` below, not merely probed with
      // `ctx.get`. Reading an un-injected service as a property throws, and the
      // throw happens inside the settings nav's own render — so the whole
      // Settings page blanks instead of just losing one label. `ctx.get` is no
      // substitute: it resolves through the global store and happily returns a
      // service the fiber is not allowed to touch.
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, 'gord-dsh-worktree: dictionaries');
      if (typeof document !== 'undefined') {
        ctx.effect(function () {
          var tag = document.createElement('style');
          tag.dataset.plugin = 'gord-dsh-worktree';
          tag.dataset.pluginCss = 'gord-dsh-worktree/enhance';
          tag.textContent = HOVER_CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        }, 'gord-dsh-worktree: enhance stylesheet');
      }
      // The settings section belongs to a session, but its slot owner passes no
      // session: the service is reached through a declared injection rather
      // than as a bare property, which would throw in a profile that has no
      // sessions. When there is none the page keeps working off the remembered
      // path, exactly as before.
      var sessionsService;
      var uiSessionService;
      // The user's workspaces, which is where a project comes from when the
      // session's own directory is not a repository. Optional: a profile
      // without the workspace controller simply has no projects to offer.
      var workspacesService = null;
      ctx.inject(['workspaces'], function (scope) {
        workspacesService = scope.workspaces;
      });
      ctx.inject(['sessions'], function (scope) {
        sessionsService = scope.sessions;
      });
      // The client's own workspace navigation — what the sidebar's session rows
      // and the composer's workspace picker use to switch the chat area. Optional:
      // without it a row still registers its workspace, it just cannot jump.
      var uiWorkspaceService = null;
      ctx.inject(['uiWorkspace'], function (scope) {
        uiWorkspaceService = scope.uiWorkspace ?? null;
      });
      // The current session is not in that list: it belongs to the UI session
      // service, which publishes the main binding (`publishMain`).
      ctx.inject(['uiSession'], function (scope) {
        uiSessionService = scope.uiSession;
      });
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'worktree',
          order: 62,
          locale: NS,
          label: function () {
            return ctx.locale.bind(NS)('nav.label');
          },
        }, function (props) {
          var t = props && typeof props.t === 'function' ? props.t : fallbackT;
          var wrapped = function (key, params) {
            return interpolate(t(key), params);
          };
          // Resolved per render: the session can move into a worktree while the
          // page is open, and the page should follow it.
          var sessionDir = sessionDirOf(sessionsService, uiSessionService);
          return React.createElement(WorktreeSection, Object.assign({}, props, {
            t: wrapped,
            sessionDir: sessionDir,
            workspaces: workspaceList(workspacesService),
            // A worktree's open action needs the workspace store and the client's
            // navigation, both of which live in this scope rather than the panel's.
            openWorktree: function (path, project) {
              var bare = baseName(path);
              return ensureWorkspace(workspacesService, function () {
                return api('adopt', { dir: dir, path: path }).then(function (data) {
                  return data && data.ok === true && data.workspace !== undefined && typeof data.workspace.workspaceId === 'string' ? data.workspace.workspaceId : '';
                });
              }, path).then(function (workspaceId) {
                if (workspaceId === '') return false;
                nameWorkspace(workspacesService, workspaceId, project === '' ? bare : project + ' · ' + bare, bare);
                return openWorkspaceSession(
                  uiWorkspaceService,
                  workspaceId,
                  workspaceSessionIds(workspacesService, sessionsService, workspaceId),
                );
              });
            },
          }));
        });
      });
      // The workspace and branch of a session, on the sidebar's session hover card.
      // The card belongs to the Workspace bundle, but it declares this slot (the
      // schedule plugin is built on it), so both reach the card without a bundle
      // patch and neither is re-applied on every DSH upgrade.
      ctx.inject(['slots', 'sessions'], function (scope) {
        if (scope.slots === undefined || typeof scope.slots.register !== 'function') return;
        var read = hoverFactsReader(scope.sessions);
        // A checkout in another window is the one change this window cannot see,
        // so regaining focus is exactly when the cached answer is known to be
        // stale. A timer instead would be wrong until it fired, or would run git
        // for hovers nobody made.
        var forget = function () {
          HOVER_FACTS = {};
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', forget);
          scope.effect(function () {
            return function () {
              window.removeEventListener('focus', forget);
            };
          });
        }
        // Coming back to the tab counts as looking again, for the same reason
        // focus does: nothing was watching while it was hidden.
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', forget);
          scope.effect(function () {
            return function () {
              document.removeEventListener('visibilitychange', forget);
            };
          });
        }
        // A branch can also change while this window keeps the focus — an agent
        // running `git switch` inside the session is the common case — and neither
        // focus nor a timer sees that. What does change is the session itself, so
        // every update to it drops the cache: the next hover reads again, and
        // nothing is fetched for hovers nobody makes.
        try {
          var stop = scope.sessions.list.subscribe(forget);
          scope.effect(function () {
            return stop;
          });
        } catch (_) {}
        var register = function () {
          return scope.slots.register(
            { name: HOVER_SLOT, id: 'gord-worktree-hover', order: 20 },
            function HoverFactsSlot(props) {
              return React.createElement(SessionHoverFacts, {
                sessionId: props.sessionId,
                lookup: { factsOf: read },
              });
            },
          );
        };
        // `inject` is the wrapper that waits for the slot's owner to exist; a
        // profile whose slot registry has no such method still gets the line, and
        // one that cannot register at all loses only the line.
        scope.effect(function () {
          return typeof scope.slots.inject === 'function' ? scope.slots.inject(HOVER_SLOT, register) : register();
        });
      });

      // The Changes tab of the right sidebar. Registered from a child scope for
      // the same reason the chip is: a profile composed without the right
      // sidebar should lose this tab, not fail to apply the whole plugin — and
      // a service read as a property outside its inject throws.
      ctx.inject(['slots', 'locale', 'sidebarRightTabs'], function (scope) {
        scope.effect(function () {
          return scope.sidebarRightTabs.register({
            id: DIFF_ID,
            kind: DIFF_KIND,
            title: function () {
              return localeT(scope)('diff.tab');
            },
            guide: [{
              order: 40,
              title: function () {
                return localeT(scope)('diff.guide.title');
              },
              description: function () {
                return localeT(scope)('diff.guide.desc');
              },
              icon: DIFF_ICON,
            }],
          });
        }, 'gord-dsh-worktree: changes tab type');
        scope.slots.inject('sidebar.right.pane.tab', function () {
          return scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: DIFF_ID,
            locale: NS,
          }, function (props) {
            var t = props && typeof props.t === 'function' ? props.t : fallbackT;
            var wrapped = function (key, params) {
              return interpolate(t(key), params);
            };
            return React.createElement(ChangesBody, Object.assign({}, props, { t: wrapped }));
          });
        });
        scope.slots.inject('sidebar.right.pane.tab.title', function () {
          return scope.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: DIFF_ID,
          }, ChangesTitle);
        });
      });
      // Registering from inside `ctx.inject` rather than from `apply` keeps the
      // chip's dependency on `sessions` optional: if the session controller is
      // absent the chip is simply not contributed, instead of the whole plugin
      // failing to apply. `slots` is named here even though `apply` already
      // injects it: every core plugin that registers from a child scope lists
      // each service its body reads, and reading an un-injected service as a
      // property throws — the same failure that once blanked the whole
      // Settings page.
      ctx.inject(['slots', 'sessions'], function (scope) {
        // The workspace list is a separate, optional injection: a profile
        // without the workspace controller must still get this control for a
        // session that is already in a repository. Read per render, so a service
        // that arrives later is picked up rather than frozen as missing.
        var workspacesService = null;
        scope.inject(['workspaces'], function (inner) {
          workspacesService = inner.workspaces;
        });
        scope.slots.inject('conversation.input.dock', function () {
          return scope.slots.register({
            name: 'conversation.input.dock',
            id: 'worktree-location',
            order: 20,
            locale: NS,
          }, function (props) {
            var session = props && props.session;
            // New Session only. `blank` is the same bit the core Hero uses, so
            // the chip appears exactly while choosing where a new session
            // starts and disappears once the first turn is under way — at
            // which point the directory is already fixed and there is nothing
            // left to pick.
            if (session === undefined || session.blank !== true) return null;
            return React.createElement(WorktreeChip, {
              ctx: scope,
              t: localeT(scope),
              session: session,
              workspaces: workspaceList(workspacesService),
              onClose: props && props.onClose,
            });
          });
        });
      });
    }

    /**
     * Namespaced translator bound to the plugin's locale namespace.
     *
     * `apply` declares `locale` in `inject`, so the bound function is
     * available by the time any component renders; the fallback covers the
     * window before that binding resolves.
     */
    function localeT(ctx) {
      try {
        return ctx.locale.bind(NS);
      } catch (_) {
        return fallbackT;
      }
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.WorktreeSection = WorktreeSection;
    exports.WorktreeChip = WorktreeChip;
    exports.DICT = DICT;
    return module.exports;
  },
});