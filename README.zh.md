# gord-dsh-worktree

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Git worktree 管理：把并行开发
放进各自独立的目录与分支。随包发布 **快速模式**（Fast mode，agent 预设），以及两个可选补丁。

[English](README.md) · [详细说明](docs/internals.zh.md)

![新会话行上的工作树选择器，展开态：当前工作树与新建工作树](docs/images/new-session-worktree-picker.png)
![工作树设置页：工作树列表与归档的会话卡片](docs/images/settings-worktrees.png)

## 功能

- **创建工作树** —— 一条原子命令建好目录和分支，agent 和 *Settings → Worktrees* 都能发起。工作树建在项目
  之外（默认 `$DSH_HOME/worktree/`），所以不会出现在自己项目的 diff 里。
- **在新工作树里开会话** —— New Session 那行有"工作位置"选择器：留在原地，或新建一个工作树把会话开进去。
- **看改动** —— 右侧栏 *Changes* 页签列出当前会话目录的改动文件和所选文件的 patch。
- **管理归档会话** —— *Settings → Worktrees* 列出归档的会话（短 id、标题、所在项目、日志大小），每行有
  **取消归档** 和删除图标，另有 **全部删除**。
- **双击重命名** —— 在侧栏会话行上直接改名，不用开菜单。
- **快速模式** —— 一个精简的 agent 预设，随插件一起装好。
- **只读工具并发** —— 可选补丁，让 `bash`、`glob`、`grep` 的批量只读调用并行执行。

## 安装

```sh
dsh plugin --profile web add github:nightosong/gord-dsh-worktree
```

重启 `dsh web`，然后打开 **Settings → Worktrees**。不需要改别的：包自带 bundle patch，`fast` 预设也由它
声明。从旧名（`dsh-worktree`）升级的话，先删掉旧的那个再装这个。

并发补丁是唯一需要动手的可选项，因为它改的是核心工具包而不是 composition：

```sh
cd /path/to/gord-dsh-worktree
npm run patch:concurrency     # --check 先看，--revert 撤销
```

可重复执行（DSH 升级后重跑一次即可），需要重启 `dsh web`。

要求 dsh `>=0.1.5-rc.1 <0.2.0`；快速模式和并发补丁需要 `0.1.7` 以上。侧栏折进项目的功能如果该构建已经原生
支持，补丁会报告 `native` 并且不做改动。

## Agent 工具

| 工具 | 作用 |
| ---- | ---- |
| `worktree_list` | 列出仓库的工作树，以及全部本地与远程跟踪分支。 |
| `worktree_create` | 建目录和分支；分支已存在时直接切过去，不重建。 |
| `worktree_status` | 某个工作树的分支、上游和改动文件。 |
| `worktree_remove` | 删除工作树；有未提交改动时拒绝，除非 `force`。 |
| `worktree_prune` | 清理目录已消失的工作树记录，不删文件。 |

五个工具默认从会话目录推断仓库，也可以用 `workdir` 指定另一个。项目本体永远不会被删，脏工作树没有
`force` 不会被删，分支名会先校验再使用。

## 开发

纯 ESM，无构建：`lib/index.js` 是宿主半，`lib/client.js` 是浏览器半，`lib/service.js` 和
`lib/worktree.js` 是两边共用的 git 逻辑。

```sh
npm test                       # 五个 smoke 套件，无需测试框架
npm run patch:sidebar          # 侧栏把工作树折进它的项目
npm run unpatch:sidebar
npm run patch:concurrency      # bash/glob/grep 只读并发
npm run check:concurrency
npm run unpatch:concurrency
```

宿主侧改动要重启 `dsh web`，客户端侧改动刷新页面即可。

## 许可证

MIT
