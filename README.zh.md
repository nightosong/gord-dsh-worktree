# gord-dsh-worktree

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Git worktree 管理：把并行开发
放进各自独立的目录与分支，Agent 和界面都能用。

[English](README.md)

## 功能

- **Agent 工具** —— `worktree_list`、`worktree_create`、`worktree_status`、`worktree_remove`、
  `worktree_prune`。Agent 可以为某个任务开一个隔离检出，而不是所有工作挤在同一个工作区里。
- **设置页** —— *设置 → 工作树*：列出仓库的全部 worktree 及分支/HEAD 与「当前 / 游离 HEAD / 已锁定 /
  记录失效」标记；提供新建表单（分支、起点、目录）、预演清理，以及一键 **用工作区打开**，把新 worktree
  注册成侧栏工作区，直接在其中开会话。
- **不用手敲 git** —— 创建是一条原子的 `git worktree add -b`；目录默认放在仓库同级的
  `<仓库名>-worktrees/<分支>`，绝不落在仓库内部。

## 安装

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

然后重启 `dsh web`（bundle 进入层栈后重新加载即可），打开 **设置 → 工作树**。无需手工编辑任何 profile
文件：包内声明了 `dsh.bundle.patch`，CLI 会自己把它加入 bundle 堆栈。

需要 dsh `0.1.5-rc.1` 或更新版本。

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

## 配置

| 字段 | 默认值 | 含义 |
| ---- | ------ | ---- |
| `defaultParent` | *空* | 新建 worktree 的父目录。留空用同级的 `<仓库名>-worktrees/`。 |
| `adoptWorkspace` | `true` | 面板创建 worktree 后自动注册为 DSH 工作区。 |

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

Host 半区作为 bundle 层挂载，改动需要重启 `dsh web`；客户端改动随 GUI 的模块重载生效。

`npm test` 会跑两个冒烟测试：Host 侧针对一个临时 git 仓库，客户端侧针对一个极简 React 运行时，
无需安装任何测试框架。

## 许可证

MIT