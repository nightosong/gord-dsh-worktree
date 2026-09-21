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

    /** Dictionary namespace owned by this plugin. */
    var NS = 'worktree';
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
     * Register the settings page and its dictionaries.
     *
     * @param ctx - client cordis context (needs `slots`).
     */
    function apply(ctx) {
      var locale = ctx.get('locale');
      if (locale !== undefined) {
        ctx.effect(function () {
          return locale.register(NS, DICT);
        }, 'gord-dsh-worktree: dictionaries');
      }
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
        var spec = { name: 'settings.section', id: 'worktree', order: 62, label: function () { return fallbackT('nav.label'); } };
        if (ctx.get('locale') !== undefined) {
          spec.locale = NS;
          spec.label = function () { return ctx.locale.bind(NS)('nav.label'); };
        }
        return ctx.slots.register(spec, function (props) {
          var t = props && typeof props.t === 'function' ? props.t : fallbackT;
          var wrapped = function (key, params) {
            return interpolate(t(key), params);
          };
          return React.createElement(WorktreeSection, Object.assign({}, props, { t: wrapped }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.WorktreeSection = WorktreeSection;
    exports.DICT = DICT;
    return module.exports;
  },
});