# 仓库级与文档级完整性检查报告（workgraph 能力族）

- 检查对象：dsh-graph 镜像仓库（`/Users/wutianyu/Downloads/company/ca/gitlab/dsh-graph`，HEAD `e3ee637`，分支 `main`）
- 检查方式：只读（未修改任何源文件）；git 命令 + 文件核对 + 宿主 checkout（`/Users/wutianyu/Downloads/project/github/deepseek-harness`，分支 `master`）交叉核对
- 检查日期：2026-08-15

---

## 1) 镜像仓库状态 — **PASS**

| 检查项 | 结论 | 证据 |
|---|---|---|
| `git status` 干净 | pass | `git status` → "On branch main / nothing to commit, working tree clean"（.DS_Store、.dsh/ 均被 .gitignore 忽略：`.gitignore:9,14`） |
| 分支 main | pass | `git branch --show-current` → `main`；宿主为 `master`，与 README.md:27 记载一致 |
| PAIRS 六路径与仓库布局匹配 | pass | sync.sh:16-25 声明的 8 个条目全部存在：`packages/workgraph/workgraph/`、`packages/workgraph/workgraph-scheduler/`、`packages/workgraph/command-workgraph/`、`packages/client/ui-workgraph/`、`.scratch/workgraph/`、`docs/subsystems/workgraph.md`、`docs/subsystems/workgraph.zh.md`、`docs/subsystems/workgraph.i18n.yaml` |
| 族级 README 三件套 | pass | sync.sh:41,53 同步的 `packages/workgraph/README.{md,zh.md,i18n.yaml}` 均存在 |
| feature 笔记过滤器 `2026-08-14-workgraph-v*` | pass | sync.sh:29；`.agents/notes/implemented/feature/` 下实际为 v1–v9 共 9 组，全部命中该 glob（含 .i18n.yaml） |
| bug-fix 笔记过滤器 `2026-08-15-workgraph-*` | pass | sync.sh:33；实际文件 `2026-08-15-workgraph-deny-lists-registered-tools.{md,zh.md,i18n.yaml}` 命中 |

## 2) 试用安装链路（README 步骤 1–4 vs examples/web-graph.patch.yml）— **PASS**

| 检查项 | 结论 | 证据 |
|---|---|---|
| 步骤 1 构建命令（宿主 tsc -b + tsdown） | pass | README.md:40-45 / README.zh.md:40-45 一致 |
| 步骤 2 四个符号链接（含 ui-workgraph） | pass | README.md:46-53 / README.zh.md:46-53 一致 |
| 步骤 3 三个插件行 + `workgraphDir` 配置 | pass | README.md:54-65 / README.zh.md:54-65 的 yaml 块完全一致（id=workgraph/command-workgraph/ui-workgraph，`workgraphDir: !!js dshHomePath('workgraph')`） |
| 步骤 4 启动命令与端口 3081 | pass | README.md:66-70 / README.zh.md:66-70：`node apps/cli/lib/bin.js web --patch examples/web-graph.patch.yml`，监听 `http://127.0.0.1:3081`；examples/web-graph.patch.yml:7-10 仅覆盖 `webserver` 的 `host: 127.0.0.1`、`port: 3081`，与 README 所述"端口覆盖"职责分工一致（patch 注释第 3-4 行明确插件行已装入用户 patch 层 `~/.dsh/profiles/web/cordis.patch.yml`，即步骤 3 的内容） |
| class-plugin 默认导出惯例 | pass | README.md:72 声称 loader 以包默认导出取用调度器类；`packages/workgraph/workgraph-scheduler/src/index.ts:91-93` 确为 `export { WorkGraphScheduler as default }`（注释：class plugins follow this convention） |
| `workgraphDir` 位于 Config schema | pass | `config.ts:60` `workgraphDir: z.string()` |

## 3) 配置一致性（config.ts schema vs README vs CONTEXT.md）— **PASS（附 1 处 minor）**

| 字段 | 文档记载 | 代码实现 | 结论 |
|---|---|---|---|
| concurrency | 3，钳 1–8（README.md:74、CONTEXT.md:47） | `config.ts:14` 默认 3、`:31` 钳 1–8、`:61-62` schema | pass |
| nodeRounds | 3，钳 1–8 | `config.ts:16,32,63-64` | pass |
| replanCap | 3，钳 0–10 | `config.ts:18,33,65-66` | pass |
| optimizer | 开（true） | `config.ts:20,67` 默认 true | pass |
| maxNodes | 24 | `config.ts:22,68` | pass |
| historyMax | 64 | `config.ts:24,69` | pass |
| planBytesMax | 256 KiB | `config.ts:26` = 256*1024、`:70` | pass |
| childAwaitBudget | 600 s，钳 1–3600 | `config.ts:28,34,71-72` | pass |

测试佐证：`tests/config.spec.ts:23-38`（默认值）、`:49-58`（直构越界失败）、`:60-84`（schema 加载边界，含 `childAwaitBudget: 3601` 拒绝于 `:79`）。

- **minor**：`resolveWorkGraphConfig` 直构路径对 `childAwaitBudget` 只校验 `> 0`（`config.ts:117-118`），未执行文档所述 1–3600 的上钳（上钳仅由 schema 加载层执行，`config.ts:71-72`）；且接受小数秒（测试 `config.spec.ts:41` 用 0.02），而 schema 的 `.step(1)` 要求整数秒。包 README `workgraph-scheduler/README.md:37` 声称"Direct construction … fails loudly on out-of-range values"，对 childAwaitBudget 上界而言略强于实际行为。无测试覆盖 3601 直构场景。

## 4) i18n 三件套记录 — **PASS**

| 位置 | README.md | README.zh.md | README.i18n.yaml | 记录哈希 vs 实际 blob | 结论 |
|---|---|---|---|---|---|
| packages/workgraph | ✓ | ✓ | ✓ | md `e3761df7…` / zh `f9a99870…` 均一致 | pass |
| packages/workgraph/workgraph | ✓ | ✓ | ✓ | `9d977ba4…` / `42503c92…` 一致 | pass |
| packages/workgraph/workgraph-scheduler | ✓ | ✓ | ✓ | `6fefa921…` / `dea373d8…` 一致 | pass |
| packages/workgraph/command-workgraph | ✓ | ✓ | ✓ | `ef61b18e…` / `e5b4c7b5…` 一致 | pass |
| packages/client/ui-workgraph | ✓ | ✓ | ✓ | `6572d24f…` / `d232d523…` 一致 | pass |
| docs/subsystems（workgraph.*） | ✓ | ✓ | ✓（workgraph.i18n.yaml） | `8400fa65…` / `8af53caa…` 一致 | pass |
| 根 README 三件套（附加） | ✓ | ✓ | ✓ | `e7d57a42…` / `62833b2e…` 一致 | pass |

哈希核对方式：`git rev-parse HEAD:<path>` 与 i18n.yaml 记录逐项比对，全部一致。内容层面：en/zh 标题数一致（根 7/7、族 1/1、workgraph 9/9、scheduler 16/16、command 9/9、ui 10/10、docs 7/7），docs/subsystems 生成段标记（`workgraph.md:52,157` 与 `workgraph.zh.md:52,157`）对称。笔记三件套 10/10 哈希核对通过（v1–v9 + bug-fix）。

## 5) 文档完备性与术语一致性 — **PASS**

| 文档 | 状态 | 证据 |
|---|---|---|
| CONTEXT.md 词汇表 | 齐全 | CONTEXT.md 全文 51 行，含核心概念/状态词汇/持久化与投影/执行模型/与宿主映射五节 |
| .scratch/workgraph/spec.md | 齐全 | 79 行，Status: ready-for-agent（spec.md:3） |
| issues/01–09 决议 | 齐全且全部 resolved | 各文件 `:7` `**Status:** resolved`、`:14` `## Resolution` 附实现细节；issue 01 决议交叉引用 v1 笔记 |
| feature 笔记 v1–v9 | 齐全 | `.agents/notes/implemented/feature/2026-08-14-workgraph-v1..v9-*.{md,zh.md,i18n.yaml}`，Status: implemented |
| bug-fix 笔记 2026-08-15 | 齐全 | `2026-08-15-workgraph-deny-lists-registered-tools.{md,zh.md,i18n.yaml}`，Status: implemented；与 HEAD 提交 `086c465`（deny lists name registered tools）对应 |
| 术语不漂移 | pass | 节点状态（`types.ts:22`）与图状态（`types.ts:26-32`）枚举值与 CONTEXT.md:23-24、docs/subsystems/workgraph.md:46 完全一致；`gn-final` 保留 id、`nodeRounds/replanCap/childAwaitBudget` 命名在代码（rounds.ts、scheduler.ts）与文档中统一；CONTEXT.md 恢复语义（:26）与 spec.md:43 一致 |

## 6) CONTEXT.md『未决』项收口 — **结论：关闭（该遗留已失效）**

CONTEXT.md:51 记载："唯一遗留问题：`examples/web-cordis/cordis.yml` 未提交的 `cordis-host-runner` 删除行——恢复还是保留（phase-1 遗留，作者拍板）。"

调查结果（镜像 + 宿主双重核对）：

1. **镜像端**：`examples/` 仅含 `web-graph.patch.yml`（见文件清单）；`examples/web-cordis` 在镜像 git 历史中从未存在——`git log --all -- 'examples/**'` 仅 2c0445b 一次提交新增 `web-graph.patch.yml`；全仓库（含历史）检索 `web-cordis|cordis-host-runner` 仅命中 CONTEXT.md:51 本身。sync.sh PAIRS（:16-25）不含 `examples/`，故该目录本就不在同步边界内。
2. **宿主端**（`/Users/wutianyu/Downloads/project/github/deepseek-harness`，分支 master）：
   - `examples/web-cordis/cordis.yml` 已提交且工作树干净（`git status --porcelain` 无输出，文件与 HEAD 完全一致）；
   - 其 15-19 行 `- insert:` 块包含 `cordis-host-runner` 行（`- id: cordis-host-runner` / `name: '@deepseek-ai/dsh-cordis-host-runner'`）——**行存在且已提交**；
   - git 历史：`git log -S 'cordis-host-runner'` 仅返回 4064198560（2026-08-13 "feat(self-modification): add dynamic Cordis plugin runtime and UI"）的 **ADD** 侧，历史上从未出现删除；无 stash、无未提交改动。
3. **处置结论**：**关闭**。所谓"未提交的 cordis-host-runner 删除行"在宿主与镜像的任何现存状态中都不存在：宿主侧该行已提交且存在（"保留"已成既成事实，且该插件被自指 Cordis 工具集 demo 与 `.scratch/graph-engineering/plugin/` 实际依赖），镜像侧无此文件可恢复，sync.sh 也不同步 examples/。CONTEXT.md:51 的『未决』条目应删除（属文档修订，本节点按契约只读，建议交由文档收口节点处理）。

---

## 缺陷清单（按严重级；未修改任何源文件）

- **blocker**：无
- **major**：无
- **minor**：
  1. `resolveWorkGraphConfig` 直构路径对 `childAwaitBudget` 未执行文档所述 1–3600 上钳（仅校验 >0），且接受小数秒，与 schema 层（整数 + 上钳）及包 README 的"fails loudly on out-of-range"表述略有出入——`config.ts:117-118` vs `config.ts:71-72`、`workgraph-scheduler/README.md:37`。
- **nit**：
  1. 文件权限不一致：`README.md`、`README.zh.md`、`CONTEXT.md`、`docs/subsystems/workgraph.md`、`packages/workgraph/command-workgraph/README.md`、`packages/client/ui-workgraph/README.md` 为 600，其余同族文件为 644；`sync.sh` 用 `rsync -a`（保留权限）会原样传播。
  2. 根 `README.i18n.yaml` 注释头与其余三件套的标准格式不一致（缺 `docs/i18n/README.md` 引用与 `pnpm run verify-translation-pairing` 命令），仅记录哈希、格式可用。
  3. `sync.sh` EXCLUDES（:14）未排除 `.DS_Store`，镜像内 `.scratch/workgraph/.DS_Store`、`packages/workgraph/workgraph/.DS_Store` 会被 rsync 带入宿主（git 侧已忽略，无仓库污染）。
