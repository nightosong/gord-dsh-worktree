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

    /** Dictionary namespace owned by this plugin. */
    var NS = 'gord-worktree';
    /** Where the last-used repository path is remembered between panel visits. */
    var STORE_KEY = 'gord-dsh-worktree:dir';
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
        'repo.title': '仓库',
        'repo.desc': '要管理的仓库路径；留空则使用 dsh 服务所在目录',
        'repo.placeholder': '例如 /Users/me/code/my-app',
        'repo.apply': '加载',
        'repo.reload': '刷新',
        'repo.current': '当前仓库',
        'repo.linked': '当前会话已在一个关联工作树中',
        'repo.dirty': '有未提交改动',
        'repo.clean': '工作区干净',
        'repo.defaultParent': '新工作树默认位置',
        'state.loading': '加载中…',
        'state.empty': '还没有关联工作树',
        'state.error': '操作失败',
        'state.notRepo': '该目录不在 git 仓库中',
        'list.title': '工作树',
        'list.count': '共 {n} 个',
        'badge.current': '当前',
        'badge.detached': '游离 HEAD',
        'badge.locked': '已锁定',
        'badge.pruned': '记录失效',
        'row.open': '用工作区打开',
        'row.openHint': '在侧栏工作区中打开该目录，以便在其中新建会话',
        'row.opened': '已添加为工作区',
        'row.remove': '删除',
        'create.title': '新建工作树',
        'create.desc': '在新分支上创建隔离的检出目录，不动当前工作区',
        'create.branch': '分支名',
        'create.branchHint': '留空则按 base 自动生成 worktree/<base>',
        'create.base': '起点',
        'create.baseHint': '新分支从哪个分支/提交开始；留空用当前分支',
        'create.path': '目录',
        'create.pathHint': '留空则放在仓库同级的 <仓库名>-worktrees/ 下',
        'create.submit': '创建',
        'create.running': '创建中…',
        'create.done': '已创建 {path}（分支 {branch}）',
        'create.workspace': '并已添加为工作区',
        'create.adoptFailed': '工作树已创建，但添加为工作区失败：{message}',
        'remove.confirm': '确认删除 {path}？',
        'remove.dirty': '该工作树有未提交或未跟踪的改动，删除会丢失它们。',
        'remove.force': '丢弃改动并删除',
        'remove.branch': '同时删除分支 {branch}',
        'remove.submit': '删除',
        'remove.cancel': '取消',
        'remove.done': '已删除 {path}',
        'prune.title': '清理失效记录',
        'prune.desc': '移除目录已被手动删除的工作树记录（不删除任何文件）',
        'prune.submit': '预演清理',
        'prune.done': '没有需要清理的记录',
        'prune.result': '将清理：\n{output}',
        'chip.label': '工作树',
        'chip.local': '当前工作区',
        'chip.none': '选择工作树',
        'chip.this': '主工作树',
        'chip.loading': '读取中…',
        'chip.title': '工作位置',
        'chip.desc': '在当前项目下选一个工作树开会话；会话的目录在创建时固定，所以选择会用它新建一个会话。',
        'chip.new': '新建工作树',
        'chip.newDesc': '在当前项目下再开一个检出目录，可同时并行开发',
        'chip.pick': '打开',
        'chip.pickHint': '在这个工作树里开始一个新会话',
        'chip.opening': '打开中…',
        'chip.openFailed': '打开会话失败：{message}',
        'chip.notRepo': '当前会话不在 git 仓库中',
        'chip.remote': '远程',
        'chip.pickedUpRemote': '已从 {remote} 拉取并跟踪',
        'chip.shadowed': '注意：存在远程分支 {remote}，但按你指定的起点创建',
      },
      en: {
        'nav.label': 'Worktrees',
        'brand.sub': 'Isolate parallel work with git worktrees',
        'repo.title': 'Repository',
        'repo.desc': 'Repository to manage; empty uses the directory dsh was started in',
        'repo.placeholder': 'e.g. /Users/me/code/my-app',
        'repo.apply': 'Load',
        'repo.reload': 'Refresh',
        'repo.current': 'Current repository',
        'repo.linked': 'This session is already inside a linked worktree',
        'repo.dirty': 'uncommitted changes',
        'repo.clean': 'working tree clean',
        'repo.defaultParent': 'New worktrees go to',
        'state.loading': 'Loading…',
        'state.empty': 'No linked worktrees yet',
        'state.error': 'Request failed',
        'state.notRepo': 'That directory is not inside a git repository',
        'list.title': 'Worktrees',
        'list.count': '{n} total',
        'badge.current': 'current',
        'badge.detached': 'detached',
        'badge.locked': 'locked',
        'badge.pruned': 'pruned',
        'row.open': 'Open as workspace',
        'row.openHint': 'Add this directory as a sidebar workspace so a session can start in it',
        'row.opened': 'Added as a workspace',
        'row.remove': 'Remove',
        'create.title': 'New worktree',
        'create.desc': 'Check out a new branch in its own directory, leaving this checkout untouched',
        'create.branch': 'Branch',
        'create.branchHint': 'Empty derives worktree/<base>',
        'create.base': 'Base',
        'create.baseHint': 'Branch or commit to start from; empty uses the current branch',
        'create.path': 'Directory',
        'create.pathHint': 'Empty uses a sibling <repo>-worktrees/ directory',
        'create.submit': 'Create',
        'create.running': 'Creating…',
        'create.done': 'Created {path} on branch {branch}',
        'create.workspace': ' and added it as a workspace',
        'create.adoptFailed': 'Worktree created, but adding it as a workspace failed: {message}',
        'remove.confirm': 'Remove {path}?',
        'remove.dirty': 'This worktree has uncommitted or untracked changes; removal discards them.',
        'remove.force': 'Discard changes and remove',
        'remove.branch': 'Also delete branch {branch}',
        'remove.submit': 'Remove',
        'remove.cancel': 'Cancel',
        'remove.done': 'Removed {path}',
        'prune.title': 'Prune stale records',
        'prune.desc': 'Drop records of worktrees whose directories are already gone (deletes no files)',
        'prune.submit': 'Dry run',
        'prune.done': 'Nothing to prune',
        'prune.result': 'Would prune:\n{output}',
        'chip.label': 'Worktree',
        'chip.local': 'Current workspace',
        'chip.none': 'Choose a worktree',
        'chip.this': 'main worktree',
        'chip.loading': 'Reading…',
        'chip.title': 'Working location',
        'chip.desc': 'Start this session in one of the project\u2019s worktrees. A session\u2019s directory is fixed when it is created, so picking one starts a new session there.',
        'chip.new': 'New worktree',
        'chip.newDesc': 'Check out another directory under this project for parallel work',
        'chip.pick': 'Open',
        'chip.pickHint': 'Start a new session in this worktree',
        'chip.opening': 'Opening…',
        'chip.openFailed': 'Could not open the session: {message}',
        'chip.notRepo': 'This session is not inside a git repository',
        'chip.remote': 'remote',
        'chip.pickedUpRemote': 'fetched and tracking {remote}',
        'chip.shadowed': 'Note: remote branch {remote} exists but was not used, because you named a base',
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
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
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
      primary: { background: 'var(--dsw-alias-brand-primary, #4176e6)', borderColor: 'transparent', color: '#fff' },
      danger: {
        color: 'var(--dsw-alias-state-error-primary, #d96b5a)',
        borderColor: 'var(--dsw-alias-state-error-primary, #d96b5a)',
        background: 'transparent',
      },
      meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
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

    /** Persist/restore the last repository path without failing the panel. */
    function readStoredDir() {
      try {
        return window.localStorage.getItem(STORE_KEY) || '';
      } catch (_) {
        return '';
      }
    }

    function storeDir(dir) {
      try {
        window.localStorage.setItem(STORE_KEY, dir);
      } catch (_) {
        /* private mode: remembering the path is a convenience, not a contract */
      }
    }

    /** Human-readable message for a failed host payload. */
    function messageOf(t, payload) {
      if (!payload) return t('state.error');
      if (payload.error === 'not-a-repository') return t('state.notRepo');
      return payload.message || payload.error || t('state.error');
    }

    function Badge(props) {
      return React.createElement('span', { style: Object.assign({}, S.badge, props.style || {}) }, props.children);
    }

    function Field(props) {
      return React.createElement(
        'label',
        { style: S.field },
        React.createElement('span', { style: S.label }, props.label),
        React.createElement('input', {
          className: 'gord-dsh-worktree-input',
          style: Object.assign({}, S.input, props.mono ? S.inputMono : {}),
          type: 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          spellCheck: false,
          autoComplete: 'off',
          disabled: props.disabled === true,
          onChange: function (event) {
            props.onChange(event.target.value);
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && props.onSubmit) props.onSubmit();
          },
        }),
        props.hint ? React.createElement('span', { style: S.desc }, props.hint) : null,
      );
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
     * One worktree row: identity, health badges, and the two actions that
     * matter — open it as a DSH workspace, or remove it.
     */
    function WorktreeRow(props) {
      var t = props.t;
      var entry = props.entry;
      var pending = props.pending;
      var force = props.force;

      var badges = [
        entry.current ? React.createElement(Badge, { key: 'cur', style: S.badgeAccent }, t('badge.current')) : null,
        entry.detached ? React.createElement(Badge, { key: 'det', style: S.badgeWarn }, t('badge.detached')) : null,
        entry.locked ? React.createElement(Badge, { key: 'lock', style: S.badgeWarn }, t('badge.locked')) : null,
        entry.pruned ? React.createElement(Badge, { key: 'pru', style: S.badgeError }, t('badge.pruned')) : null,
      ].filter(Boolean);

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
        React.createElement(
          Button,
          {
            variant: 'danger',
            disabled: props.busy || entry.path === props.mainRoot,
            onClick: function () {
              props.onAskRemove(entry.path);
            },
          },
          t('row.remove'),
        ),
      );

      var confirm = pending === entry.path
        ? React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px' } },
            React.createElement('div', { style: Object.assign({}, S.notice, S.error) }, t('remove.confirm', { path: entry.path })),
            entry.dirty ? React.createElement('div', { style: S.notice }, t('remove.dirty')) : null,
            React.createElement(
              'label',
              { style: Object.assign({}, S.notice, { display: 'flex', alignItems: 'center', gap: '6px' }) },
              React.createElement('input', {
                type: 'checkbox',
                checked: force,
                onChange: function (event) {
                  props.onForceChange(event.target.checked);
                },
              }),
              entry.dirty ? t('remove.force') : t('remove.branch', { branch: entry.branch || '—' }),
            ),
            React.createElement(
              'div',
              { style: S.actions },
              React.createElement(
                Button,
                {
                  variant: 'danger',
                  disabled: props.busy || (entry.dirty && !force),
                  onClick: function () {
                    props.onRemove(entry.path, force);
                  },
                },
                t('remove.submit'),
              ),
              React.createElement(
                Button,
                {
                  onClick: function () {
                    props.onAskRemove(undefined);
                  },
                },
                t('remove.cancel'),
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
          React.createElement('div', { style: Object.assign({}, S.title, S.mono) }, entry.path),
          React.createElement(
            'div',
            { style: S.meta },
            React.createElement('span', null, entry.branch || entry.head.slice(0, 7) || '—'),
            badges.length > 0 ? badges : null,
          ),
          confirm,
        ),
        confirm ? null : actions,
      );
    }

    /** The settings page: repo picker, worktree list, create form, prune. */
    function WorktreeSection(props) {
      var t = props && typeof props.t === 'function' ? props.t : fallbackT;
      var dirState = React.useState(readStoredDir);
      var dir = dirState[0];
      var setDir = dirState[1];
      var stateStore = React.useState({ phase: 'loading' });
      var snap = stateStore[0];
      var setSnap = stateStore[1];
      var pendingStore = React.useState(undefined);
      var pending = pendingStore[0];
      var setPending = pendingStore[1];
      var forceStore = React.useState(false);
      var force = forceStore[0];
      var setForce = forceStore[1];
      var busyStore = React.useState(false);
      var busy = busyStore[0];
      var setBusy = busyStore[1];
      var noteStore = React.useState(null);
      var note = noteStore[0];
      var setNote = noteStore[1];
      var formStore = React.useState({ open: false, branch: '', base: '', path: '' });
      var form = formStore[0];
      var setForm = formStore[1];
      var alive = React.useRef(true);

      React.useEffect(function () {
        alive.current = true;
        return function () {
          alive.current = false;
        };
      }, []);

      /** Load (or reload) the repository listing for `target`. */
      function load(target) {
        setSnap({ phase: 'loading' });
        return api('list', { dir: target === undefined ? dir : target }).then(function (data) {
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
        load(dir);
        // `load` closes over `dir`; re-running on dir changes is the intent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [dir]);

      function applyDir() {
        storeDir(dir);
        load(dir);
      }

      /** Run one mutation, then refresh so the list always shows committed state. */
      function mutate(action, payload, describe) {
        setBusy(true);
        setNote(null);
        return api(action, Object.assign({ dir: dir }, payload)).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setNote({ kind: 'error', text: messageOf(t, data) });
            return;
          }
          setNote(describe(data));
          setPending(undefined);
          setForce(false);
          return load(dir);
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
          if (alive.current) setBusy(false);
        });
      }

      function submitCreate() {
        mutate('create', { branch: form.branch, base: form.base, path: form.path }, function (data) {
          var text = t('create.done', { path: data.path, branch: data.branch });
          if (data.workspace && data.workspace.error) {
            return { kind: 'error', text: t('create.adoptFailed', { message: data.workspace.error }) };
          }
          return { kind: 'ok', text: data.workspace ? text + t('create.workspace') : text };
        }).then(function () {
          if (alive.current) setForm({ open: false, branch: '', base: '', path: '' });
        });
      }

      function openAsWorkspace(path) {
        // The host adopts an existing directory through its own action, so the
        // panel never has to create a worktree to reach the workspace registry.
        setBusy(true);
        setNote(null);
        api('adopt', { dir: dir, path: path }).then(function (data) {
          if (!alive.current) return;
          setNote(
            data && data.ok
              ? { kind: 'ok', text: t('row.opened') + ' · ' + (data.workspace ? data.workspace.path : path) }
              : { kind: 'error', text: messageOf(t, data) },
          );
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
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
        React.createElement(
          'div',
          { style: S.card },
          React.createElement(
            'div',
            { style: S.rowBetween },
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' } },
              React.createElement('div', { style: S.title }, t('repo.title')),
              React.createElement('div', { style: S.desc }, t('repo.desc')),
            ),
          ),
          React.createElement(
            'div',
            { style: S.actions },
            React.createElement('input', {
              className: 'gord-dsh-worktree-input',
              style: Object.assign({}, S.input, S.inputMono, { flex: '1', minWidth: '220px' }),
              type: 'text',
              value: dir,
              placeholder: t('repo.placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: function (event) {
                setDir(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') applyDir();
              },
            }),
            React.createElement(Button, { variant: 'primary', onClick: applyDir }, t('repo.apply')),
            React.createElement(Button, { disabled: busy, onClick: function () { load(dir); } }, t('repo.reload')),
          ),
          ready
            ? React.createElement(
                'div',
                { style: S.meta },
                React.createElement('span', { style: Object.assign({}, S.mono) }, ready.mainRoot),
                React.createElement('span', null, ready.branch),
                React.createElement('span', { style: ready.dirty ? S.error : S.ok }, ready.dirty ? t('repo.dirty') : t('repo.clean')),
                ready.isLinked ? React.createElement(Badge, null, t('repo.linked')) : null,
                React.createElement('span', null, t('repo.defaultParent') + ': ' + ready.defaultParent),
              )
            : null,
          snap.phase === 'loading' ? React.createElement('div', { style: S.notice }, t('state.loading')) : null,
          snap.phase === 'error' ? React.createElement('div', { style: Object.assign({}, S.notice, S.error) }, messageOf(t, snap.payload)) : null,
        ),
        ready
          ? React.createElement(
              'div',
              { style: S.card },
              React.createElement(
                'div',
                { style: S.rowBetween },
                React.createElement(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  React.createElement('div', { style: S.title }, t('create.title')),
                  React.createElement('div', { style: S.desc }, t('create.desc')),
                ),
                React.createElement(
                  Button,
                  {
                    variant: form.open ? undefined : 'primary',
                    onClick: function () {
                      setForm(Object.assign({}, form, { open: !form.open }));
                    },
                  },
                  form.open ? t('remove.cancel') : '+ ' + t('create.submit'),
                ),
              ),
              form.open
                ? React.createElement(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
                      React.createElement(Field, {
                        label: t('create.branch'),
                        hint: t('create.branchHint'),
                        value: form.branch,
                        mono: true,
                        disabled: busy,
                        onChange: function (value) { setForm(Object.assign({}, form, { branch: value })); },
                      }),
                      React.createElement(Field, {
                        label: t('create.base'),
                        hint: t('create.baseHint'),
                        value: form.base,
                        mono: true,
                        disabled: busy,
                        onChange: function (value) { setForm(Object.assign({}, form, { base: value })); },
                      }),
                    ),
                    React.createElement(Field, {
                      label: t('create.path'),
                      hint: t('create.pathHint'),
                      value: form.path,
                      mono: true,
                      disabled: busy,
                      onChange: function (value) { setForm(Object.assign({}, form, { path: value })); },
                      onSubmit: submitCreate,
                    }),
                    React.createElement(
                      'div',
                      { style: S.actions },
                      React.createElement(Button, { variant: 'primary', disabled: busy, onClick: submitCreate }, busy ? t('create.running') : t('create.submit')),
                    ),
                  )
                : null,
            )
          : null,
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
                      busy: busy,
                      onAskRemove: function (path) {
                        setForce(false);
                        setPending(path);
                      },
                      onForceChange: setForce,
                      onRemove: function (path, useForce) {
                        mutate('remove', { path: path, force: useForce, deleteBranch: useForce }, function (data) {
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
                React.createElement('span', { style: S.desc }, t('prune.desc')),
              ),
            )
          : null,
        note
          ? React.createElement(
              'pre',
              { style: Object.assign({}, S.pre, note.kind === 'error' ? S.error : S.ok) },
              note.text,
            )
          : null,
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
      var formStore = React.useState({ open: false, branch: '', base: '' });
      var form = formStore[0];
      var setForm = formStore[1];
      var alive = React.useRef(true);
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
          var sessions = ctx.sessions;
          var list = sessions.list.getSnapshot();
          var current = list.current;
          var summary = current === undefined ? undefined : list.byId[current];
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
        return api('list', { dir: dir }).then(function (data) {
          if (!alive.current) return;
          if (!data || data.ok !== true) {
            setSnap({ phase: 'error', payload: data });
            return;
          }
          setSnap({ phase: 'ready', dir: dir, data: data });
        }).catch(function (error) {
          if (!alive.current) return;
          setSnap({ phase: 'error', payload: { message: String((error && error.message) || error) } });
        });
      }

      // Refresh on open, and whenever the session's directory changes under us.
      React.useEffect(function () {
        if (!open) return undefined;
        var dir = currentDir();
        load(dir);
        var sessions = null;
        try {
          sessions = ctx.sessions;
        } catch (_) {
          sessions = null;
        }
        if (sessions === null || sessions.list === undefined) return undefined;
        var stop = sessions.list.subscribe(function () {
          var next = currentDir();
          if (next !== dir) load(next);
        });
        return stop;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      /**
       * Land the user in `path`: register it as a workspace when needed, then
       * open a session rooted there. Registration is best-effort — a session
       * can be created from a bare cwd, and the workspace only decides whether
       * the directory also shows up in the sidebar.
       *
       * @param path - worktree directory to open a session in.
       * @param collapse - whether to close the popover once the session opens.
       *   A plain pick collapses; a create stays open, because its result —
       *   path, branch, and whether a remote branch was picked up — is the
       *   thing worth reading, and closing would hide it immediately.
       */
      function openIn(path, collapse) {
        setBusy(true);
        var dir = snap.phase === 'ready' ? snap.dir : currentDir();
        // Register the worktree, then start a session rooted in it. The create
        // call resolves to the new session **id** (a string), not a result
        // object, so the id is used directly rather than unwrapped.
        //
        // The session is created by `cwd` rather than by workspace id on
        // purpose: adopting the workspace is best-effort, and a create that
        // named a workspace which failed to register would fail the whole
        // action. Naming the directory keeps the two independent.
        api('adopt', { dir: dir, path: path }).catch(function () {
          /* a workspace is a convenience; the session below is the point */
        }).then(function () {
          var sessions = ctx.sessions;
          return sessions.create({ cwd: path }).then(function (sessionId) {
            if (typeof sessionId !== 'string' || sessionId === '') {
              throw new Error(t('chip.openFailed', { message: String(sessionId) }));
            }
            sessions.open(sessionId);
          });
        }).then(function () {
          if (alive.current && collapse !== false) setOpen(false);
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: t('chip.openFailed', { message: String((error && error.message) || error) }) });
        }).then(function () {
          if (alive.current) setBusy(false);
        });
      }

      /** Create a worktree, then open a session in it. */
      function submitCreate() {
        setBusy(true);
        setNote(null);
        var dir = snap.phase === 'ready' ? snap.dir : currentDir();
        api('create', { dir: dir, branch: form.branch, base: form.base }).then(function (data) {
          if (!data || data.ok !== true) throw new Error(messageOf(t, data));
          if (alive.current) {
            var text = t('create.done', { path: data.path, branch: data.branch });
            setNote({
              kind: 'ok',
              text: data.pickedUpRemote !== undefined
                ? text + ' · ' + t('chip.pickedUpRemote', { remote: data.pickedUpRemote })
                : text,
            });
            setForm({ open: false, branch: '', base: '' });
          }
          return openIn(data.path, false);
        }).catch(function (error) {
          if (alive.current) setNote({ kind: 'error', text: String((error && error.message) || error) });
        }).then(function () {
          if (alive.current) setBusy(false);
        });
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
        if (snap.phase === 'norepo' || snap.phase === 'error') {
          items.push(React.createElement('div', { key: 'msg', style: S.desc },
            snap.phase === 'norepo' ? t('chip.notRepo') : messageOf(t, snap.payload)));
        }
        // The project's own directory. It is the only selectable entry: the
        // other worktrees of a project are workspaces in their own right once
        // created, so they are reached from the workspace picker rather than
        // listed again here.
        items.push(option('local', t('chip.local'), snap.phase === 'ready' ? snap.dir : '', true, function () {
          setOpen(false);
        }));
        if (form.open) {
          items.push(
            React.createElement('div', { key: 'newform', style: S.formBlock },
              React.createElement(Field, {
                label: t('create.branch'), hint: t('create.branchHint'),
                placeholder: t('create.branch'), value: form.branch,
                onChange: function (v) { setForm(Object.assign({}, form, { branch: v })); },
              }),
              React.createElement(Field, {
                label: t('create.base'), hint: t('create.baseHint'),
                placeholder: t('create.base'), value: form.base,
                onChange: function (v) { setForm(Object.assign({}, form, { base: v })); },
              }),
              React.createElement('div', { style: S.actions },
                React.createElement(Button, { disabled: busy, onClick: submitCreate },
                  busy ? t('create.running') : t('create.submit'))),
            ),
          );
        } else {
          items.push(option('new', t('chip.new'), t('chip.newDesc'), false, function () {
            setNote(null);
            setForm({ open: true, branch: '', base: '' });
          }));
        }
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
          React.createElement(primitives.IconBranchOutline16, { className: 'gord-dsh-worktree-seatIcon', style: S.seatIcon }),
          React.createElement('span', { className: 'gord-dsh-worktree-seatLabel', style: S.seatLabel }, value),
          React.createElement(primitives.IconChevronDownOutline14, { className: 'gord-dsh-worktree-chevron', style: S.chevron }),
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
    function apply(ctx) {
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
          return React.createElement(WorktreeSection, Object.assign({}, props, { t: wrapped }));
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