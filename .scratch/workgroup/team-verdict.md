# 团队综合裁定 — workgraph / workgraph-scheduler invariant 入口悬空与 files 重复 (t4)

裁定人: final-review (reviewer) · 日期: 2026-08-16
输入证据: t1 (audit-wg, @deepseek-ai/dsh-workgraph) · t2 (audit-sched, @deepseek-ai/dsh-workgraph-scheduler) ·
t3 (root-check, 根配置/对照组/消费方/门禁) · 以及本裁定人对 host 仓库的独立复核（含三部门禁实测复跑）。

---

## 0. 裁定结论总览

| # | 审计发现 | 裁定 | 依据 |
|---|---|---|---|
| 问题1 | 两包本地 tsdown.config.ts 只打包 lib/types/index.js，从不产出 lib/invariant.js，而 exports["./invariant"] / files 声明了该文件 | **成立（真实存在）** | 源码 + 构建产物 + npm 发布面 + 门禁实测，见 §1 |
| 问题2 | 两包 files 数组重复列出 lib/invariant.js | **成立（真实存在）** | package.json 原文 + constraints 门禁实测，见 §2 |

t3 补充发现的 3 类额外门禁违规（dsh-invariants peer/dev 缺失、tsconfig 缺 invariants 引用、verify-package-invariants 10 条）亦全部复核属实；
其中仅 2 条与问题1同源，其余 8 条为**独立问题**（见 §3）。

严重度: **发布阻断**（host 三道门禁全部失败、CI 必拒），但因全仓零消费方，当前无运行期破坏，属**潜伏性/潜在破坏**（见 §4）。

---

## 1. 问题1 — 成立：tsdown 缺 invariant 入口 → lib/invariant.js 永不产出，exports/files 悬空

### 1.1 本地配置缺入口（直接证据，host 原文）

- `packages/workgraph/workgraph/tsdown.config.ts` L6: `entry: ['lib/types/index.js']` — **无 invariant**
- `packages/workgraph/workgraph-scheduler/tsdown.config.ts` L6: `entry: ['lib/types/index.js']` — **无 invariant**
- 根默认 `tsdown.config.ts` L20 (host face): `entry: ['lib/types/{index,invariant,startup}.js']` — **含 invariant**

### 1.2 机制（tsdown 0.22.2 源码复核，非仅引用）

`node_modules/.pnpm/tsdown@0.22.2…/dist/`:
- `build-BxT2lm9L.mjs` `resolveWorkspace`: 每个 workspace 包 `loadConfigFile({…, cwd}, cwd, normalized)`，随后
  `configs.map(c => mergeConfig(normalized, c))`。
- `options-DWGUHu4D.mjs` `loadConfigFile` (L585+): 包**无**本地 `tsdown.config.ts` 时 `exported=[]` →
  `exported.push({})` → 返回空配置 → `mergeConfig(normalized, {})` = 根默认原样继承（含 invariant）。
- `mergeConfig` = `defu(...overrides.toReversed(), defaults)`；defu 对数组是**整体替换**（非合并）→ 包**有**
  本地配置时，本地 `entry` 数组**整体覆盖**根默认 glob，`invariant` 入口被丢掉。

实证对照组（host lib/ 构建产物，`ls` 实测）:
| 包 | 本地 tsdown.config.ts | lib/ 产物 | lib/invariant.js |
|---|---|---|---|
| workgraph | 有（缺 invariant） | index.js, types/ | **无** |
| workgraph-scheduler | 有（缺 invariant） | index.js, types/ | **无** |
| command-workgraph | **无**（继承根默认） | index.js, invariant.js(979B), types/ | 有 |
| ui-workgraph（packages/client/） | 有（显式含 'lib/types/invariant.js'） | index.js, invariant.js, client.js(+map), types/ | 有 |
| dsh-invariants（packages/runtime-diagnostics/） | **无**（继承根默认） | index.js, invariant.js, types/ | 有 |

→ 根因明确: 两包本地配置只写了 `lib/types/index.js`，漏掉根默认中的 `invariant` entry；
command-workgraph / dsh-invariants 因无本地配置而"碰巧正确"；ui-workgraph 因本地配置显式列出而正确。

### 1.3 悬空面（类型可解析、运行期 ENOENT）

- 两包 `tsc -b` 确实产出 `lib/types/invariant.js` + `.d.ts`（host `lib/types/` 实测存在）→
  `exports["./invariant"].types` 可解析；
- 但顶层 `lib/invariant.js` 从未产出（§1.2 产物表）→ `exports["./invariant"].default` 悬空。
- workgraph/package.json L27-30、workgraph-scheduler/package.json L23-26 均声明
  `"./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" }`。
- t3 `npm pack --dry-run`（workgraph）: tarball 含 lib/types/invariant.js/.d.ts，**不含 lib/invariant.js** →
  消费者 `import '@deepseek-ai/dsh-workgraph/invariant'` 运行期 `ERR_MODULE_NOT_FOUND`。

### 1.4 门禁实测（本裁定人复跑，全部复现）

`pnpm run verify-built-package-invariants`（`scripts/verify-built-package-invariants.mjs` 按 manifest.files
staged lib 视图后用裸 Node import `${pkg}/invariant`）→ **exit 1**，全 workspace 仅 2 处失败:
```
@deepseek-ai/dsh-workgraph-scheduler: Cannot find module '…/lib/invariant.js' imported from …/probe.mjs
@deepseek-ai/dsh-workgraph: Cannot find module '…/lib/invariant.js' imported from …/probe.mjs
```

---

## 2. 问题2 — 成立：files 数组重复列出 lib/invariant.js

### 2.1 直接证据（package.json 原文，host）

- `packages/workgraph/workgraph/package.json` L32-38 `files`:
  `["lib/index.js", "lib/invariant.js", "lib/types/**/*.js", "lib/types/**/*.d.ts", "lib/invariant.js"]`
  — L34 与 L37 重复。
- `packages/workgraph/workgraph-scheduler/package.json` L28-33 `files`:
  `["lib/index.js", "lib/invariant.js", "lib/types/**/*.d.ts", "lib/invariant.js"]`
  — L30 与 L32 重复。
- 对照组: ui-workgraph `files` = `["lib/index.js","lib/invariant.js","lib/client.js","lib/types/**/*.d.ts"]` — 无重复。

### 2.2 门禁实测（本裁定人复跑，复现）

`pnpm run constraints`（`scripts/check-workspace-constraints.ts`，`sameStringList` L150-152 要求 files
**逐项精确相等**：长度+顺序）→ **exit 1**，全 workspace 仅 2 处错误，均为 workgraph 对:
```
packages/workgraph/workgraph/package.json: files must be ["lib/index.js","lib/invariant.js","lib/types/**/*.js","lib/types/**/*.d.ts"]
packages/workgraph/workgraph-scheduler/package.json: files must be ["lib/index.js","lib/invariant.js","lib/types/**/*.d.ts"]
```
→ 重复项是**硬失败**（长度不匹配），非 cosmetic。t3 git blame: 重复项由 host 提交 `a1f5fa3ce9`
(test gates, 2026-08-15) 改写 files 数组时引入。

---

## 3. t3 额外发现的 3 类门禁违规 — 裁定与归类

### 3.1 完整 10 条违规（本裁定人复跑 `pnpm run verify-package-invariants`，exit 1，全在 workgraph 家族）

```
packages/workgraph/workgraph/package.json:        @deepseek-ai/dsh-invariants must be a workspace:^ peerDependency
packages/workgraph/workgraph/package.json:        @deepseek-ai/dsh-invariants must also be a workspace:^ devDependency
packages/workgraph/workgraph/tsconfig.json:       TypeScript project references must include ../../runtime-diagnostics/invariants
packages/workgraph/workgraph/tsdown.config.ts:    package build override must bundle lib/types/invariant.js
packages/workgraph/workgraph-scheduler/package.json:   @deepseek-ai/dsh-invariants must be a workspace:^ peerDependency
packages/workgraph/workgraph-scheduler/package.json:   @deepseek-ai/dsh-invariants must also be a workspace:^ devDependency
packages/workgraph/workgraph-scheduler/tsconfig.json:  TypeScript project references must include ../../runtime-diagnostics/invariants
packages/workgraph/workgraph-scheduler/tsdown.config.ts: package build override must bundle lib/types/invariant.js
packages/workgraph/command-workgraph/tsconfig.json:     TypeScript project references must include ../../runtime-diagnostics/invariants
packages/client/ui-workgraph/package.json:          @deepseek-ai/dsh-invariants must be a workspace:^ peerDependency
```

### 3.2 归类

| 违规 | 涉及包 | 归类 | 理由 |
|---|---|---|---|
| tsdown.config.ts "must bundle lib/types/invariant.js" ×2 | wg, sched | **与问题1同源** | 门禁明文编码问题1（本地 entry 缺 invariant）。修问题1即消 |
| dsh-invariants peer 缺失 ×3 | wg, sched, ui-wg | **独立问题** | 与 tsdown/files 无关；manifest 依赖声明缺口 |
| dsh-invariants dev 缺失 ×2 | wg, sched | **独立问题** | 同上（ui-wg 已含 dev=workspace:^，故只报 peer） |
| tsconfig references 缺 invariants ×3 | wg, sched, cmd-wg | **独立问题** | TypeScript 工程引用缺口（ui-wg 已含该引用，故不报） |

细账: 10 条 = 2 条同源（问题1）+ 5 条 dsh-invariants 依赖声明（wg peer/dev、sched peer/dev、ui peer）+
3 条 tsconfig 引用（wg、sched、cmd）。**无一条与问题2（files 重复）同源**。

复核依据（host 实测）:
- wg / sched: peer 与 dev 均无 `@deepseek-ai/dsh-invariants`；ui-wg: peer 无、dev 有(workspace:^)；cmd-wg: peer/dev 均有。
- wg / sched / cmd-wg 的 tsconfig.json references 均不含 `../../runtime-diagnostics/invariants`；ui-wg 已含。
- 门禁逻辑: `scripts/package-invariants.ts` checkManifest (L98-112) 与 checkBuild (L120-135) 明文编码上述规则。

---

## 4. 严重度评估

- **门禁 = 发布阻断**。host 三道门禁实测全部 exit 1，且失败项**全部**落在 workgraph / workgraph-scheduler
  两包（全 workspace 其余包通过）: constraints(问题2) ×2、verify-built-package-invariants(问题1运行面) ×2、
  verify-package-invariants ×10。任何正常 CI 流程都会拒绝发布。
- **运行期破坏 = 当前无、发布后有**。host + 镜像全仓 grep（*.ts/*.tsx/*.js/*.mts/*.yml/*.json/*.md）
  零消费方 import `dsh-workgraph/invariant` / `dsh-workgraph-scheduler/invariant` / `command-workgraph/invariant` /
  `ui-workgraph/invariant`（仅各包 src/lib/types 中 `@module …/invariant` docblock 自引用，非 import）。
  → 仓库自身代码无破坏；但 `npm pack` tarball 缺 lib/invariant.js，一旦发布，外部消费者
  `import '@deepseek-ai/dsh-workgraph/invariant'` 将 ERR_MODULE_NOT_FOUND。属**潜伏性/潜在破坏**。
- 附带（非缺陷）: 镜像与 host 四份相关文件 `diff` 逐字节一致（问题对镜像同样成立）；镜像缺 lib/ 属预期
  （sync.sh --exclude lib，构建在 host）——修复必须落在 host，镜像经 sync 同步。

---

## 5. 修复优先级建议

- **P0（发布阻断，必修；一次性解决问题1+问题2 及 4 条门禁失败: constraints×2 + built×2）**
  1. `packages/workgraph/workgraph/tsdown.config.ts` 与 `packages/workgraph/workgraph-scheduler/tsdown.config.ts`:
     entry 改为 `['lib/types/index.js', 'lib/types/invariant.js']`（对齐根默认与 ui-workgraph 模式，产出顶层 lib/invariant.js）。
  2. 两包 `package.json` `files` 删除重复的 `lib/invariant.js`（wg 删 L37，sched 删 L32）。
- **P1（同一 PR 内补齐，使 verify-package-invariants 全绿）**
  3. `@deepseek-ai/dsh-invariants: workspace:^` 加入 wg/sched 的 peer+dev、ui-wg 的 peer（wg/sched 另需 dev）。
  4. wg / sched / cmd-wg 的 `tsconfig.json` references 加入 `../../runtime-diagnostics/invariants`。
- **P2（收尾验证）**
  5. 复跑三部门禁 + `npm pack --dry-run` 确认 tarball 含 lib/invariant.js 且 files 精确匹配。
  6. 复核 `src/invariant.ts` 的 companion 契约（verify-built-package-invariants 还要求 inject 'invariants'
     与 apply 存在——修复后会自动进入该门禁检查路径，需确认两包 companion 满足）。

---

## 6. 证据清单（本裁定人独立复核，非仅转引）

1. 本地配置缺入口: `packages/workgraph/{workgraph,workgraph-scheduler}/tsdown.config.ts` L6。
2. 根默认含 invariant: host `tsdown.config.ts` L20。
3. 机制: tsdown 0.22.2 dist 源码（`mergeConfig`=defu 数组整体替换；无本地配置继承根默认）。
4. 构建产物: host `lib/` 五包实测（两包缺、三包有 invariant.js）。
5. 悬空声明: 两包 package.json exports["./invariant"]（wg L27-30 / sched L23-26）。
6. files 重复: wg package.json L32-38（L34/L37 重复）、sched L28-33（L30/L32 重复）。
7. 门禁复跑: constraints、verify-package-invariants、verify-built-package-invariants 三部门禁 exit 1，
   失败项与 t3 完全一致。
8. 消费方: host+镜像 grep 零 import（仅 docblock 自引用）。
9. 镜像一致性: 四文件 diff 逐字节一致。
