# gord-dsh-worktree

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Git worktree 管理：把并行开发
放进各自独立的目录与分支。同时随包发布 **快速模式**（Fast mode，agent 预设），以及一个可选补丁——让只读
工具调用并发执行。

[English](README.md)

## 功能

1. **创建工作树** —— 一条原子命令同时建好隔离检出与分支；Agent（`worktree_list`、`worktree_create`、
   `worktree_status`、`worktree_remove`、`worktree_prune`）和 *设置 → 工作树* 都能建。工作树属于某个项目：
   项目**自动判定**——就是你在新会话行里选的那个工作区（从同一行的选择器读取，或从会话本身读取）；工作区本身是
   仓库就用它，是"容器"（如 `apifree` 下含 `backend/rest-atlas`、`backend/oms-atlas`）就用它里面最近活动过的仓库；
   两者都读不到时才退回你最近用过的仓库工作区。**新建的工作树检出该仓库当前的本地分支**（即项目本体所在那条分支，上游照旧，不再生成 `worktree/<code>` 之类的新分支名；项目本体那一行会标记为"项目本体"，其余都是它的副本），新工作树会**挂在它所属项目工作区下面**
   （侧栏分组靠插件发布的"工作树→项目根"映射，创建时就写入，不会变成一个独立工作区）。检出目录固定放在 `$DSH_HOME/worktree/`，**绝不放进项目目录**（放进项目会
   让该项目的 `git status` 与 diff 里多出一堆工作树文件）；指定项目内的路径会被直接拒绝，而不是悄悄改到别处。
2. **在 worktree 中开会话** —— 新会话行带工作位置选择器：留在当前工作树，或新建一个并直接在其中开会话。
3. **查看改动 diff** —— 右侧边栏的 *变更* 标签页显示本会话所在目录的未提交改动：每个改动文件及其增删
   行数，以及选中文件的补丁。
4. **管理归档会话** —— *设置 → 工作树* 列出本机所有已归档的会话，每行可 **取消归档** 或单独删除，整体可
   **全部删除**。
5. **双击重命名** —— 直接双击侧栏的会话行重命名，不用走菜单。
6. **快速模式** —— 随 bundle patch 发布的精简 agent 预设，装上插件即可在预设选择器里看到。见下面「快速模式」。
7. **只读工具调用并发** —— 可选补丁（`npm run patch:concurrency`），让 `bash`、`glob`、`grep` 在同一步里重叠
   执行，而不是一个接一个。见下面「只读工具调用并发」。

![新会话行上的工作树选择器，展开态：当前工作树与新建工作树](docs/images/new-session-worktree-picker.png)

![会话运行在 worktree 中，新会话行显示工作位置选择器](docs/images/session-in-worktree.png)

![工作树设置页：工作区下拉、两层显示的工作树列表及其操作，以及归档的会话卡片](docs/images/worktree-settings.png)

## 安装

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

然后重启 `dsh web`（bundle 进入层栈后重新加载即可），打开 **设置 → 工作树**。无需手工编辑任何 profile
文件：包内声明了 `dsh.bundle.patch`，CLI 会自己把它加入 bundle 堆栈。

快速模式随之而来——同一个 patch 声明了 `fast` 预设，所以不必编辑 profile 文件，预设选择器里就有**快速模式**。
如果 profile 自己的 `cordis.patch.yml` 里已经有一行手写的 `preset-fast`，请先删掉它：bundle 层先合并，同 id
两行会把预设挂载两次，而加载器并不会拒绝。新会话**默认**用哪个预设仍是用户自己的选择（profile patch 里的
`agent-preset-registry`），bundle 不替你决定。这个分工的另一个方向也要注意：快速模式是由本插件的 patch 声明的，
所以卸载插件时，请一并改掉或删掉 profile patch 里的 `default: fast` 那行，否则它指向一个已不存在的预设。

并发补丁是唯一需要手动执行的一步，因为它改的是核心工具包而不是组合层：

```sh
cd /path/to/gord-dsh-worktree
npm run patch:concurrency     # 先 --check 看状态，--revert 还原
```

它需要重启 `dsh web`，并且是幂等的——DSH 升级会还原它改的文件，升级后重跑一次即可。

支持 dsh `>=0.1.5-rc.1 <0.2.0`，也就是从 `0.1.5-rc.1` 起的整条 0.1.x 线。已实测 `0.1.5-rc.1`、
`0.1.6-alpha.2` 与 `0.1.7-rc.2` 三个版本：这三者之间图标导出名、会话跳转方式与插件设置接口都变过，
插件都做了适配——见下面「跨版本兼容」。

0.3.0 新增的两个能力要求比这个门槛高，所以最低版本按能力算、而不是按包算：

| 能力 | 最低 dsh | 原因 |
| ---- | -------- | ---- |
| worktree 工具、*设置 → 工作树*、侧栏 *变更* 标签、归档会话 | `0.1.5-rc.1` | 插件自身代码，对 0.1.5–0.1.7 之间变过的每个接口都保留回退 |
| 侧栏嵌套分组与双击重命名 | `0.1.5-rc.1` | 打进浏览器 bundle 的补丁：嵌套分组要补两处（会话列表与工作区树），双击重命名 0.1.7 起原生自带，脚本在那里报 `native`；**补丁在插件加载时自动核对并补装** |
| **快速模式（Fast mode）** | `0.1.7` | 预设是 `@deepseek-ai/dsh-agent-preset` 组合行——0.1.5/0.1.6 从 `$DSH_HOME/.agent-presets` 目录发现预设，0.1.7 换掉了这套机制。在没有这个包的构建上，`preset-fast` 那行没有东西可挂：把它从 `cordis.patch.yml` 里删掉，或留在 0.1.7+ |
| **只读 `bash`/`glob`/`grep` 并发** | `0.1.7` | 补丁按 0.1.7 的核心文件精确匹配锚点。其它构建上 `npm run check:concurrency` 报 `unknown`，工具会拒绝落盘而不是猜 |

## 跨版本兼容

0.1.5 → 0.1.7 之间，DSH 改了三处插件看得见的接口。插件对老版本保留回退，对新版本走新接口，两边都能跑：

| 接口 | 0.1.5 / 0.1.6 | 0.1.7 起 | 插件怎么做 |
| ---- | ---- | ---- | ---- |
| 图标导出名 | `IconTrashOutline16` 这类带尺寸后缀的名字 | `IconTrashOutlineRegular` 这类带字重后缀的名字 | 两套名字都试，都没有就画空——绝不把 `undefined` 当作元素类型交给 React |
| 会话跳转 | `sessions.open(id)` | `uiWorkspace.openSession(id)`，`sessions.open` 已移除 | 优先用工作区视图跳转，读不到时回退到旧方法 |
| 插件设置命名空间 | `settings.register(ns, schema)` | 无此方法，改用 profile 自身的表单模型 | 有 `register` 才注册，没有就直接用 profile 条目里的配置 |

`uiWorkspace` 与 `settings` 都是可选读取（`ctx.get`），因此组合里没有工作区视图、或没有设置能力的
profile 只会少一项功能，不会让插件加载失败。

DSH 升级还会还原并发补丁改的两个核心工具包（`dsh-tool-bash`、`dsh-tool-fs-search`）——随包发布的
预设不受升级影响，因为它就在这个包里。升级后重跑 `npm run patch:concurrency`，用
`npm run check:concurrency` 看当前状态：`patched`、`original`，或构建已变化时的 `unknown`（工具会拒绝硬打，
只报告）。

## 详细说明

### 在侧栏里看改动

右侧边栏的 *变更* 标签页显示本会话所在目录的未提交改动：与 `HEAD` 不同的每个文件、状态与增删行数，
以及选中文件的补丁（含两侧行号栏）。它是**工作区对 `HEAD`** 的差异——暂存与未暂存一起——而不是会话
自己的编辑，因为提交前要审的是磁盘上的内容，无论它是谁写的：Agent 的文件编辑、格式化工具，还是你另
一个窗口里的编辑器。会话自己的编辑已经在对话里内联显示，来自工具自身的上报。

对它来说 worktree 就是一个普通仓库。标签页向宿主询问的是**会话所在的目录**，所以会话进入 worktree 后
它会自动跟随，不需要任何额外告知。

![变更标签页：六个改动文件及其状态与行数，以及选中文件的补丁](docs/images/sidebar-changes-tab.png)

它通过内置文件树与文档预览所用的同一个 `sidebarRightTabs` 注册表注册，两个插槽（面板与标签标题）都
在子 scope 里注入，因此没有组合右侧边栏的 profile 只是少一个标签页，而不会让整个插件 apply 失败。
在右侧边栏的起始页里打开它，它和 *工作区文件* 并列。

### 快速模式（Fast mode）

`@deepseek-ai/dsh-agent-preset` 行属于组合层，而 bundle 的 patch 文件本身就是一层组合——所以这个插件
**声明了一个预设**：`preset-fast`，id `fast`，`order: 0`。装上插件，预设选择器里就有它，没有第二份需要同步。

快速模式保留默认 Agent 的标准——先理解再动手、按证据行动、证明改动、如实汇报——但去掉外面的流程：它是
`standard` 预设减去重型编排面（无 plan mode、无 goal、无 subagent、无 workflow），所以是 14 个插件行而不是
31 个工具：shell、文件、搜索、web、skill、todo、后台作业、用户提问、上下文压缩。

它 persona 里的那些规则来自实测而非文风：真实会话日志显示每轮 30–150 次模型往返、每次 6–12 s，工具调用里
`bash` 占 81–94%，而调用工具的那些步里约三分之一已经一次发两个。于是规则是：先侦察拿到能定结论的事实，
然后**在同一轮内**回答或执行；互不依赖的动作放同一轮发；不中途提问（要问就在开场一次问清）；不在轮次里空等
——构建、扫描、长查询走后台作业；上下文保持小，因为它每一步都要重发；不做改变不了结论的普查。

它**故意不选模型**。预设行是组合、不是配置：这一行既没有 `llm-*`、也没有 `agent-default-model`，更没有
`model` 字段——快速模式跑在你 profile 里配置的那个模型上，所以同一个预设对每个用户都成立。唯一涉及模型的
地方是 persona 里的 `{{model}}` 占位符：它只是把当前模型的名字告诉 agent，不替用户做选择。

### 只读工具调用并发

`dsh-agent-loop` 只在一批调用都被判定为并发安全时才并行执行，而 `dsh-tools` 把没有 `isConcurrencySafe` 的
工具视为独占。装好的核心里 `bash`、`glob`、`grep` 正是如此——所以一步里发两个 `bash` 仍然串行，紧挨着
`bash` 的 `read` 也要等它。

`npm run patch:concurrency` 在三处补上这个分类：

| 目标 | 补什么 |
| ---- | ------ |
| `dsh-tool-bash` | `isConcurrencySafe: (args) => isReadOnlyCommand(args?.command)`，用 `lib/read-only-command.js`（本插件随包提供，复制进该包） |
| `dsh-tool-fs-search` | `glob` 加 `isConcurrencySafe: () => true` |
| `dsh-tool-fs-search` | `grep` 加 `isConcurrencySafe: () => true` |

分类器是 fail-closed 的：只有当命令行**每一段**（按 `|`、`&&`、`;` 切分）的首命令都在一个很小的只读白名单里
——`ls`、`cat`、`head`、`grep`、`rg`、`find`（不带 `-delete`/`-exec`）、`sed`（不带 `-i`）、`awk`、
`jq`、`yq`（不带 `-i`）、`sort`（不带 `-o`）、`diff`、`stat`、`ps`、`pgrep`、`lsof`、`dig`、
`curl`（不带 `-X`/`-d`/`-o` 等），以及 `git`/`docker`/`npm`/`kubectl`/`gh` 的只读子命令——且整行没有
`>`、没有命令替换时，才判为可并行。其余一律独占，与打补丁前完全一致：写操作、`sed -i`、`npm install`、
`git commit`、脚本（`node x.mjs`、`python3 scripts/…`）、循环、`sleep`、`xargs`，以及任何认不出来的命令。

三条性质和分类结果同样重要：

- **幂等且可识别**：每处插入都带 marker；`--check` 逐行报告 `patched`／`original`／`unknown`，还有未打的就退出 2。
- **构建变了就停手**：落盘前要求每个锚点**恰好匹配一次**，所以 DSH 构建变了时一个文件都不写，退出 1 并报
  `not in the expected shape`，而不是打一半。
- **可还原**：`npm run unpatch:concurrency` 用补丁写在旁边的 `.orig` 备份还原每个文件，并删掉它装进去的分类器。

### 归档

DSH 归档一个会话，就是往工作区注册表的某一个数组里塞一个 id，而它没有留回头的路：远端契约里只有
一个归档方法、别无其他，CLI 完全不碰它，也没有任何界面列出归档了什么——整个客户端只带一条归档相
关的文案，就是执行归档的那个菜单项。会话一旦被归档，就从所有分组界面消失，既没有记录可查，也没有
控件可撤销。

**设置 → 工作树** 现在以一张 *归档的会话* 卡片收尾，列出本机所有已归档的会话，最近的归档在前：标题、
所在项目、创建时间、归档时间，以及日志在磁盘上占多大。每行带 **取消归档**，卡片右上角带 **全部删除**。

取消归档走的是注册表自己的串行操作队列与它的 `setState`——也就是 `archiveSession` 自己用的那一对——
所以改动既是持久的，又**立刻**上屏：侧栏把会话放回原来的位置，不用重启。归档本来就只是把它藏起来，
没有移动或删除任何东西。

**全部删除** 是本插件里唯一不可逆的控件。它会删掉所列出每个会话的日志目录、缓存投影与工作区归属，
并且藏在一条报出数量的确认之后。**每行还有一个同样的删除图标**，对应「只误归档了一条」这个远更常见的
情形。两者回传的都是自己列出过的那些确切 id，而不是一个「删掉一切」的开关，因此在列出与点击之间才被
归档的会话不会被顺手带走。仍在运行的会话会被跳过并如实上报，而不是把日志从一个正在跑的 agent 底下抽走。

删除唯一**保留**的就是归档条目本身。核心「不要显示这个会话」的开关只有归档集合——`sessionVisible`
每次渲染都查它——而核心完全无法表达「这个会话已经没了」。一个日志已删、却不再归档的 id 会掉出它所属
的工作区，落进浏览器的 *未分组* 桶里，变成一个空分组，直到刷新页面才消失。保留条目正是让会话立刻、且
在每次刷新后都保持隐藏的原因；而插件自己的列表会把这些 id 排除，因为已经没有东西可列了。

条目不会一直留着：插件每次**加载**时会清掉那些日志已经不在了的归档条目。这一刻清是安全的——宿主刚把会话从磁盘扫过
一遍，此后连上来的每个客户端都按同一次扫描建列表，这些 id 不可能再作为一行出现；而运行期间不清，是因为浏览器还握
着那行已删的会话。留着它们只会越积越多，0.1.7 给侧栏加的「显示已归档 / 只显示已归档」还会把这些残留渲染成一个
*未分组* 分组，里面的行连日志都没了，也就无从删除。

每行只显示一个时间，就是该会话的最后一次写入——在量大小的同一次目录扫描里，取日志目录中最新的
mtime。这才是「这个东西最后一次用是什么时候」的诚实答案，而一份归档列表真正会被问的就是这个问题。投影
本来能给出 `lastPromptAt`，那也是侧栏自己排序用的字段，但只有投影缓存里有行的会话才有它，冷读其余的
每个会话都要读整份日志——所以创建之后从未再写入的会话回退显示自己的创建时间，而这也就是一行会显示
创建时间的唯一情况。

归档**时间**同样不是 DSH 能给的东西：归档集合就是一个裸 id 数组，哪儿都没有时间戳。插件从加载那一刻
起自己记，记在 `$DSH_HOME/gord-dsh-worktree/archived-at.json`，并用它把列表按「最近归档在前」排序。
它**不**显示在行上是有意的：那是插件自己的记账，不是会话本身的事实，而一行一个时间比三个时间好读得多。

### 侧栏补丁：把 worktree 折进它的项目

侧栏本该做而没做的一件事，是把 worktree 的会话显示在它切出来的项目之下，而不是当成独立项目；0.1.7
以前的版本还缺一个双击会话行即可重命名。都由本仓库打进 DSH 的侧栏 bundle：

```sh
npm run patch:sidebar                 # 之后重启 dsh web
npm run patch:sidebar -- --check      # 每个行为打印一行状态，全部就位才返回 0
npm run unpatch:sidebar               # 还原出厂 bundle
```

三个版本线的形状不同，脚本按 bundle 的实际内容判断，不按版本号，且只补该版本真正缺的那部分：

| DSH | 嵌套分组 | 双击重命名 |
| --- | --- | --- |
| 0.1.7 起 | 两处分组都补：`groupByWorkspace`（会话列表——0.1.7 给它加了 `archivedFilter` 参数，旧签名锚点因此失配）与 `owningParentFolder`（工作区树）；两处都在路径包含关系之外再认插件发布的父级映射 | 核心自带，脚本报 `native`，不动手 |
| 0.1.6 | 同上（该版本已有「按工作区树」视图和这个函数） | 补会话行的 `onDoubleClick` |
| 0.1.5 | 改 `groupByWorkspace`——侧栏分组的全部逻辑——把 worktree 折进项目分组 | 同上 |

**两种分组都会嵌套。** 默认的「按工作区」列表走 `groupByWorkspace`，「按工作区树」视图走
`owningParentFolder`，两处都打上补丁，所以无论侧栏选哪种，worktree 都会折进它所属项目的分组里。
脚本不替用户改视图设置。

**父级**由两条规则决定：目录位于另一个工作区之内的，以及插件为**放在项目之外**的 worktree 发布的父级映射
（后者正是默认情形，`$DSH_HOME/worktree/<code>`）。0.1.6 起第二条落在 `owningParentFolder` 里，它是树状
分组父级映射的唯一来源、也只有一个调用点；0.1.5 则落在 `groupByWorkspace` 里。映射从 `localStorage`
读取，因为重新加载后的第一次渲染就需要答案，走 fetch 来不及。映射里指向已消失路径、指向自己或自己内部、
以及指向不是已注册工作区的条目，都会被忽略。

**双击重命名**只给会话行加一个 prop，调用的正是该行自带菜单已经在调的那个 handler——因此弹窗、校验和
报错文案都是核心的，而不是第二份副本。空白会话被跳过，与该菜单一致（它对空白会话隐藏全部操作）：空白
会话还没有标题可改（弹窗会以空输入框打开），而第一条消息之后会重新命名它，改了也会被覆盖。

之所以用补丁而不是插件：客户端插件只能靠接管整个 `sidebar.workspaces` 插槽来实现嵌套，而该插槽是
`single` 的，拥有分区标题、搜索框、每一行会话以及全部工作区对话框——14 个组件，还带拖拽排序、重命名、
归档与分叉。接管它意味着把它们全部重写，并在每个版本上与核心漂移。而分组函数只有十几行，重命名钩子
只有一个 prop。

**DSH 升级会覆盖该文件，升级后请重跑 `npm run patch:sidebar`。** 脚本是幂等的，第一次打补丁前会把出厂
bundle 存为 `client.js.orig`；若代码不是它认识的形状就拒绝动手，而不是硬套。每个行为带自己的标记，因此
已经打过其中一个的安装仍能拿到另一个；且只有当一个行为需要的全部替换点都找到时才会写入。`--check` 对
认识的行为打印 `patched` / `original` / `native`，遇到不认识的行为报 `not in the expected shape` 并以 1
退出——那意味着这次 DSH 升级又动了这些函数，补丁需要更新。

### 从 `dsh-worktree` 改名而来

现在的包名、模块 id、HTTP 路由与设置命名空间统一为 `gord-dsh-worktree`。若你装的是旧名字：

```sh
dsh plugin --profile web remove dsh-worktree
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

## 工具

| 工具 | 作用 |
| ---- | ---- |
| `worktree_list` | 列出仓库全部 worktree：路径、分支、HEAD，以及当前/游离/锁定/失效状态。 |
| `worktree_create` | 一条命令同时建目录与分支；分支已存在时改为检出，不重复创建。 |
| `worktree_status` | 单个 worktree 的分支、上游信息与改动文件。 |
| `worktree_remove` | 删除 worktree。存在未提交或未跟踪改动时默认拒绝，显式 `force` 才会丢弃。 |
| `worktree_prune` | 清理目录已被删除的 worktree 记录，不删除任何文件。 |

五个工具默认以会话目录作为仓库，也可用 `workdir`（或 `repo`）指定其它仓库。

## 安全约定

- 主工作树永远不可删除。
- 有改动时不会删除——且「有改动」包含未跟踪文件，因为 `worktree remove --force` 会一并删掉它们。
- 已锁定的 worktree 只做提示，不会静默解锁。
- 分支名交给 `git check-ref-format` 校验；所有路径都以位置参数传给 git，不经过 shell，名称无法变成参数。
- 面板使用的 HTTP 接口会在本机执行 git，因此写操作只接受同源与本机调用，它不是对外 API。
- 删除归档会话是唯一与 git 无关、也是唯一不可撤销的破坏性操作。它藏在一次明确确认之后，只删掉被明确
  交来的那些 id，并且拒绝碰仍在运行的会话。

- 并发补丁只决定**调度**，不决定跑什么：被判为并行的调用仍是同一条命令、同一个结果。分类器是 fail-closed
  的，所以最坏情况就是打补丁前的行为——一条只读命令仍然独占；它认不出来的命令永远不会被并行。

## 配置

| 字段 | 默认值 | 含义 |
| ---- | ------ | ---- |
| `defaultParent` | *空* | 新建 worktree 的父目录。留空用 `$DSH_HOME/worktree/`。在 profile 条目里设置；页面只显示，不提供编辑。 |

*设置 → 工作树* 页打开时先落到一个项目上，而且是自动判定的：当前会话所在的仓库；会话不在仓库里时，取你最近用过的
仓库工作区。列表上方有一个下拉，列出宿主能读出仓库的全部项目——本身就是仓库的工作区，或容器型工作区里的每个
仓库，写作 `apifree › rest-atlas`；选中即刷新该项目的列表，不用离开这一页。全程不需要手输：没有路径输入框，
也没有仓库诊断信息，"新建的工作树归哪个项目"仍然由会话行那个 chip 决定。工作树一律建在所有项目之外，
所以检出目录不会出现在它自己项目的 diff 里。

## 开发

插件是纯 ESM，没有构建步骤：`lib/index.js` 是 Host 半区，`lib/client.js` 是浏览器端 bundle（经
`window.__ModuleLoader__` 加载），`lib/service.js` 与 `lib/worktree.js` 放两端共用的 git 逻辑。

```sh
# 把本地检出作为实时依赖装进某个 profile
dsh plugin --profile web add /absolute/path/to/gord-dsh-worktree
```

按路径安装的检出会从自身目录解析 Node 依赖，而 DSH 的包从 profile 解析，因此 Host 半区看不到
`@deepseek-ai/dsh-tools`，除非检出自己能找到它们。在本地检出里一次性链接（已被 gitignore）：

```sh
mkdir -p node_modules/@deepseek-ai
SRC=$(dirname "$(readlink -f "$(which dsh)")")/../node_modules/@deepseek-ai
for p in schemastery dsh-tools dsh-settings cordis; do
  ln -sfn "$SRC/$p" "node_modules/@deepseek-ai/$p"
done
```

从 GitHub 或 npm 装进 profile 则不需要这一步：那时 peer 依赖经由 profile 自己的 `node_modules`
解析，和其它插件完全一致。

Host 半区作为 bundle 层挂载，改动需要重启 `dsh web`；客户端改动随 GUI 的模块重载生效。bundle patch 在每次
会话激活时重新读取（`patchReload: live`），所以改预设只需新开一个会话，不必重启。

`npm test` 会跑五个冒烟套件：Host 侧针对一个临时 git 仓库，客户端侧针对一个极简 React 运行时（含三套图标命名
与两条会话跳转路径），侧栏补丁针对**当前装着的** DSH bundle 副本，并发补丁针对合成包并对已安装核心做只读检查
（覆盖待打 → 已打 → 幂等 → 还原、构建不可识别时不落盘、以及分类器把写操作留在独占），bundle patch 自身的形状
检查（一条挂载行、一个恰好 14 个插件的 `preset-fast`、不含个人信息），无需安装任何测试框架。

三个工具，都不影响插件的正常使用：

| 脚本 | 作用 |
| ---- | ---- |
| `npm test` | 上面五个套件。 |
| `npm run patch:sidebar` / `unpatch:sidebar` | 把侧栏的 worktree 嵌套分组与双击重命名打进已安装的浏览器 bundle。 |
| `npm run patch:concurrency` / `unpatch:concurrency` / `check:concurrency` | 把只读 `bash`/`glob`/`grep` 的并发判定打进已安装的工具包。 |

## 许可证

MIT