# t3 核验报告 — 根 tsdown 默认配置、兄弟包机制、仓库内消费方 (root-check)

日期: 2026-08-16 · 核验人: root-check (researcher)
结论: 审计两个发现均 **真实存在**，且经 host 三道门禁实测**当前失败**；另发现 3 类额外门禁违规。

---

## 1. 根 tsdown 默认配置 (host: `tsdown.config.ts`)

`/Users/wutianyu/Downloads/project/github/deepseek-harness/tsdown.config.ts` L16-29:

```ts
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],  // ← 含 invariant!
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
```

- host-face 根默认 entry 为 `lib/types/{index,invariant,startup}.js` — **包含 invariant**。
- 构建命令 (package.json L22): `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`；
  client face: `tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client`。

**机制 (tsdown 0.22.2, node_modules/tsdown/dist)**: workspace 模式下对每个包目录执行
`loadConfigFile`；包**没有**本地 `tsdown.config.ts` 时继承根默认（含 invariant entry）；
包**有**本地 `tsdown.config.ts` 时该本地配置整体覆盖根布局
(`mergeConfig(normalized, config)` + defu 数组替换语义)。

## 2. 兄弟包机制对比（实证，host 构建产物）

| 包 | 本地 tsdown.config.ts | entry | host lib/ 实际产物 | invariant.js? |
|---|---|---|---|---|
| workgraph | 有 | `['lib/types/index.js']` | index.js, types/ | **NO** |
| workgraph-scheduler | 有 | `['lib/types/index.js']` | index.js, types/ | **NO** |
| command-workgraph | **无** | (继承根默认) | index.js(18234B), **invariant.js(979B)**, types/ | YES |
| ui-workgraph | 有 | `['lib/types/index.js','lib/types/invariant.js']` | index.js, **invariant.js**, client.js(+map), types/ | YES |
| (对照) dsh-invariants | **无** | (继承根默认) | index.js, **invariant.js**, types/ | YES |

- `tsc -b` (outDir lib/types) 对 workgraph/scheduler **确实**产出 `lib/types/invariant.js` + `.d.ts`
  (host lib/types/ 实测存在) → 类型侧可解析；但顶层 `lib/invariant.js` 从未产出 → 运行时侧悬空。
- 结论: 审计发现(1)成立。根因 = 本地配置只写了 `lib/types/index.js`，漏掉根默认里的
  `invariant` entry。command-workgraph 因无本地配置而"碰巧正确"。

## 3. npm 发布面（实测 npm pack --dry-run，workgraph 包）

- 无任何 warning；tarball 含 `lib/types/invariant.js`(916B) 与 `lib/types/invariant.d.ts`(679B)，
  **不含 `lib/invariant.js`** → `exports["./invariant"].default` 悬空；
  消费者 `import '@deepseek-ai/dsh-workgraph/invariant'` 运行时 ERR_MODULE_NOT_FOUND。

## 4. 仓库内消费方

- host 全仓 grep (`*.ts/*.tsx/*.js/*.mts/*.yml/*.yaml/*.json/*.md`)：**零消费方** import
  `dsh-workgraph/invariant`、`dsh-workgraph-scheduler/invariant`、`command-workgraph/invariant`、
  `ui-workgraph/invariant` — 仅各包 `src/invariant.ts` 的 docblock `@module .../invariant` 自引用。
- 镜像侧同样为零。→ 当前是**潜在发布问题/门禁失败**，尚无运行期破坏。

## 5. host 三道门禁实测（决定性证据，均 exit 1）

### 5a. `pnpm run constraints` (scripts/check-workspace-constraints.ts)
全 workspace 仅 2 处错误，均为 workgraph 对:
```
packages/workgraph/workgraph/package.json: files must be ["lib/index.js","lib/invariant.js","lib/types/**/*.js","lib/types/**/*.d.ts"]
packages/workgraph/workgraph-scheduler/package.json: files must be ["lib/index.js","lib/invariant.js","lib/types/**/*.d.ts"]
```
`sameStringList` 要求 files **逐项精确相等** → 重复 `lib/invariant.js`(审计发现2)是硬失败，非 cosmetic。
git blame: 重复项由 host 提交 `a1f5fa3ce9` (test gates, 2026-08-15) 改写 files 数组时引入。

### 5b. `pnpm run verify-built-package-invariants` (scripts/verify-built-package-invariants.mjs)
全 workspace 仅 2 处失败，均为 workgraph 对:
```
@deepseek-ai/dsh-workgraph-scheduler: Cannot find module '.../lib/invariant.js' imported from .../probe.mjs
@deepseek-ai/dsh-workgraph: Cannot find module '.../lib/invariant.js' imported from .../probe.mjs
```
脚本把 manifest.files 声明的 lib 视图 staged 后用普通 Node import `${pkg}/invariant` →
找不到 lib/invariant.js → 编译后伴侣加载失败(审计发现1的运行体现)。

### 5c. `pnpm run verify-package-invariants` (scripts/package-invariants.ts)
10 处违规，全部 workgraph 家族:
- workgraph + scheduler 各有 4 条:
  1. `tsdown.config.ts: package build override must bundle lib/types/invariant.js` ← **审计发现1被门禁明文编码**
  2. `@deepseek-ai/dsh-invariants must be a workspace:^ peerDependency` ← **新增发现**
  3. `@deepseek-ai/dsh-invariants must also be a workspace:^ devDependency` ← **新增发现**
  4. `tsconfig.json: TypeScript project references must include ../../runtime-diagnostics/invariants` ← **新增发现**
- command-workgraph: `tsconfig.json: ... must include ../../runtime-diagnostics/invariants` ← **新增发现**
- ui-workgraph: `@deepseek-ai/dsh-invariants must be a workspace:^ peerDependency` ← **新增发现**

## 6. 镜像/宿主一致性

- 四包 `package.json`、`tsdown.config.ts`、`tsconfig.json` 与 host **逐字节一致** (diff 实测) →
  审计结论对镜像与 host 同时成立。
- 镜像缺 `lib/` 属预期 (sync.sh `--exclude lib`，构建在 host)。
- 附带发现: 镜像缺 `packages/client/tsdown.client.ts`（ui-workgraph 本地配置 import 它；
  host 存在）— 镜像仅同步 ui-workgraph 子目录所致；镜像 README 声明构建在 host，非缺陷。

## 6b. 任务要点逐条事实清单（YES/NO）

| # | 事实 | 判定 | 证据 |
|---|---|---|---|
| F1 | 根 tsdown.config.ts 的 entry 默认值 | YES | host `tsdown.config.ts` L20: `entry: client ? '' : ['lib/types/{index,invariant,startup}.js']` — host-face 含 invariant |
| F2 | command-workgraph 无本地 tsdown 配置（继承根默认） | YES | `packages/workgraph/command-workgraph/` 无 tsdown.config.* 文件（ls 实测 0 个）；host 构建产物 `lib/invariant.js`(979B) 存在 = 继承生效实证 |
| F3 | ui-workgraph 无本地 tsdown 配置（继承根默认） | **NO（任务前提有误）** | `packages/client/ui-workgraph/tsdown.config.ts` 存在（L1-3: `clientBundle('@deepseek-ai/dsh-client-ui-workgraph', ['lib/types/index.js','lib/types/invariant.js'])`）— 显式声明两个 entry，**非**继承根默认 |
| F4 | command-workgraph 与 ui-workgraph 均声明 exports["./invariant"] | YES | command-workgraph package.json L23-26；ui-workgraph package.json L21-24，均 `{types: ./lib/types/invariant.d.ts, default: ./lib/invariant.js}` |
| F5 | 仓库内有消费方 import ./invariant 子路径 | **NO** | host+镜像全仓 grep（ts/tsx/js/mts/yml/yaml/json/md，排除 node_modules/lib）：仅各包 `src/invariant.ts` L3 `@module .../invariant` docblock 自引用；无任何 import/引用 |
| F6 | sync.sh 排除 lib | YES | `sync.sh` L14: `EXCLUDES=(--exclude lib --exclude node_modules --exclude .dsh --exclude '*.tsbuildinfo')`；L39/41/43/45/51/53/55/57 全部 rsync 均使用该数组 |
| F7 | 机制结论：本地配置覆盖根默认；无本地配置继承根默认 | YES | tsdown 0.22.2 dist `resolveWorkspace`→`loadConfigFile`(per-package cwd)+`mergeConfig(normalized, config)`（defu 数组替换）；实证：command-workgraph/dsh-invariants 有 lib/invariant.js，workgraph/workgraph-scheduler 无 |

补充说明 F3：任务描述"ui-workgraph 无本地 tsdown 配置（继承根默认）"与事实不符。ui-workgraph 恰恰**有**本地配置且显式包含 `lib/types/invariant.js` entry —— 这使其成为 workgraph/workgraph-scheduler 修复的**正确参照**（在本地配置中补 invariant entry，而非删除本地配置去继承根默认）。

## 7. 结论

1. **发现(1) 真实存在** — 两包本地 tsdown 配置不产 lib/invariant.js；exports/files 声明悬空；
   host 门禁 5b/5c 明文失败；npm tarball 缺该文件；运行期 import 必炸（现无消费方，潜伏）。
2. **发现(2) 真实存在** — 两包 files 重复列出 lib/invariant.js；host constraints 门禁(5a)明文失败。
3. 修复方向（供 final-review 裁定）: 两包本地 tsdown entry 加 `lib/types/invariant.js`（对齐
   ui-workgraph 与根默认），files 去重；顺带补 dsh-invariants peer/dev 依赖与 tsconfig
   references（5c 新增违规），否则 verify-package-invariants 仍失败。
