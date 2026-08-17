# Entry-Point Audit — packages/workgraph + packages/client/ui-workgraph

Audit of declared entry points (`main`, `types`, `exports`, `files`, `dsh.client`) in
the four workgraph packages, verified against the checkout tree and the host
build tree (`/Users/wutianyu/Downloads/project/github/deepseek-harness`, where
`tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host|client` actually runs;
`sync.sh` excludes `lib/`, so no `lib/` exists in this checkout — expected).

All four `package.json` files are byte-identical to the host copy. Build model:

- Packages **without** a package-local `tsdown.config.ts` (command-workgraph) fall back to the
  root workspace defaults (`tsdown.config.ts`: `entry: ['lib/types/{index,invariant,startup}.js']`).
- Packages **with** a package-local `tsdown.config.ts` (workgraph, workgraph-scheduler,
  ui-workgraph) REPLACE the root layout with exactly the entries they list.

Legend: `checkout` = file present in this repo; `host` = file present in the host build tree.
A `lib/` path marked `checkout=NO` is the expected sync.sh exclusion, not an inconsistency;
the consistency verdict is judged on whether the build actually produces the declared artifact.

---

## 1. @deepseek-ai/dsh-workgraph — packages/workgraph/workgraph

| Declaration | Path(s) | checkout | host | Verdict |
|---|---|---|---|---|
| `main` | `lib/index.js` | NO | YES (13.8 KB bundle) | 一致 |
| `types` | `lib/types/index.d.ts` | NO | YES (tsc emit) | 一致 |
| `exports["."]` | `lib/types/index.d.ts`, `lib/index.js` | NO | YES / YES | 一致 |
| `exports["./types"]` | `lib/types/types.d.ts`, `lib/types/types.js` | NO | YES / YES (tsc emit; shipped via `lib/types/**/*.js`) | 一致 |
| `exports["./src/*"]` | `./src/*` (e.g. `src/index.ts`) | YES | YES | 一致（开发期源码映射） |
| `exports["./package.json"]` | `./package.json` | YES | YES | 一致 |
| `exports["./invariant"]` | `lib/types/invariant.d.ts`, `lib/invariant.js` | NO | YES / **NO** | **不一致** |
| `files` | `lib/index.js`, `lib/invariant.js`, `lib/types/**/*.js`, `lib/types/**/*.d.ts`, `lib/invariant.js` | — | — | **不一致** |

**Inconsistency (workgraph):** `src/invariant.ts` exists (docblock declares
`@module @deepseek-ai/dsh-workgraph/invariant`) and `tsc` emits `lib/types/invariant.js`,
but the package-local `tsdown.config.ts` bundles only `entry: ['lib/types/index.js']`
→ only `lib/index.js` is produced. `lib/invariant.js` is never emitted, so the
`./invariant` export (and its `files` entry) points at a nonexistent artifact; the
companion code is unreachable at the declared path. Additionally, `files` lists
`lib/invariant.js` **twice** (duplicate). Root cause: this package's tsdown config
restates the lib half without the `invariant` entry that the root defaults
(`lib/types/{index,invariant,startup}.js`) include.

## 2. @deepseek-ai/dsh-workgraph-scheduler — packages/workgraph/workgraph-scheduler

| Declaration | Path(s) | checkout | host | Verdict |
|---|---|---|---|---|
| `main` | `lib/index.js` | NO | YES (176 KB bundle) | 一致 |
| `types` | `lib/types/index.d.ts` | NO | YES (tsc emit) | 一致 |
| `exports["."]` | `lib/types/index.d.ts`, `lib/index.js` | NO | YES / YES | 一致 |
| `exports["./src/*"]` | `./src/*` (e.g. `src/index.ts`) | YES | YES | 一致（开发期源码映射） |
| `exports["./package.json"]` | `./package.json` | YES | YES | 一致 |
| `exports["./invariant"]` | `lib/types/invariant.d.ts`, `lib/invariant.js` | NO | YES / **NO** | **不一致** |
| `files` | `lib/index.js`, `lib/invariant.js`, `lib/types/**/*.d.ts`, `lib/invariant.js` | — | — | **不一致** |

**Inconsistency (scheduler):** same root cause as workgraph — package-local
`tsdown.config.ts` entry is only `['lib/types/index.js']`, so `lib/invariant.js` is
never produced although `exports["./invariant"]` and `files` declare it; `files` also
duplicates `lib/invariant.js`. `lib/types/**/*.js` is not in `files`, which is harmless
for the declared runtime entries (scheduler declares no `./types` runtime subpath; `.`
and `./invariant` resolve to bundles), but is asymmetric with workgraph.

## 3. @deepseek-ai/dsh-command-workgraph — packages/workgraph/command-workgraph

| Declaration | Path(s) | checkout | host | Verdict |
|---|---|---|---|---|
| `main` | `lib/index.js` | NO | YES (18 KB bundle) | 一致 |
| `types` | `lib/types/index.d.ts` | NO | YES (tsc emit) | 一致 |
| `exports["."]` | `lib/types/index.d.ts`, `lib/index.js` | NO | YES / YES | 一致 |
| `exports["./src/*"]` | `./src/*` (e.g. `src/index.ts`) | YES | YES | 一致（开发期源码映射） |
| `exports["./package.json"]` | `./package.json` | YES | YES | 一致 |
| `exports["./invariant"]` | `lib/types/invariant.d.ts`, `lib/invariant.js` | NO | YES / YES (979 B bundle) | 一致 |
| `files` | `lib/index.js`, `lib/invariant.js`, `lib/types/**/*.d.ts` | — | — | 一致（无重复项） |

No package-local `tsdown.config.ts` → root workspace defaults emit
`lib/types/{index,invariant,startup}.js` → both `lib/index.js` and `lib/invariant.js`
are produced. All declared paths exist.

## 4. @deepseek-ai/dsh-client-ui-workgraph — packages/client/ui-workgraph

| Declaration | Path(s) | checkout | host | Verdict |
|---|---|---|---|---|
| `main` | `lib/index.js` | NO | YES | 一致 |
| `types` | `lib/types/index.d.ts` | NO | YES (tsc emit) | 一致 |
| `exports["."]` | `lib/types/index.d.ts`, `lib/index.js` | NO | YES / YES | 一致 |
| `exports["./invariant"]` | `lib/types/invariant.d.ts`, `lib/invariant.js` | NO | YES / YES | 一致 |
| `exports["./client"]` | `lib/types/client/index.d.ts`, `lib/client.js` | NO | YES / YES (+ `client.js.map`) | 一致 |
| `exports["./src/*"]` | `./src/*` (incl. `src/client/index.ts`) | YES | YES | 一致（开发期源码映射） |
| `exports["./package.json"]` | `./package.json` | YES | YES | 一致 |
| `files` | `lib/index.js`, `lib/invariant.js`, `lib/client.js`, `lib/types/**/*.d.ts` | — | — | 一致（均存在于 host） |
| `dsh.client` | `inject: [@deepseek-ai/dsh-client-runtime, @deepseek-ai/dsh-client-ui-conversation]`, `platform: "web"` | — | — | 一致（字段形状与其它 client 包如 ui-layout 相同；两个 inject 包均列于 peerDependencies） |

`clientBundle('@deepseek-ai/dsh-client-ui-workgraph', ['lib/types/index.js', 'lib/types/invariant.js'])`
emits the node half (`lib/index.js`, `lib/invariant.js`) plus the browser bundle
(`entryFileNames: 'client.js'` → `lib/client.js`), all present on host. Minor note:
`lib/client.js.map` is produced but not listed in `files`, so the sourcemap is not
shipped in an npm tarball (not a declared entry; dev-only asset).

---

## Summary

- 一致：`main`/`types`/`.` and `./src/*`/`./package.json` for all four packages; `./types`
  (workgraph), `./invariant` (command-workgraph, ui-workgraph), `./client` (ui-workgraph),
  `dsh.client` (ui-workgraph), `files` for command-workgraph and ui-workgraph.
- 不一致：**workgraph** 与 **workgraph-scheduler** 的 `./invariant` 导出与 `files` 中
  `lib/invariant.js` 声明——两包的 package-local `tsdown.config.ts` 只打包
  `lib/types/index.js`，构建从不产出 `lib/invariant.js`（源码 `src/invariant.ts` 存在且
  tsc 产出 `lib/types/invariant.js`，但未被 bundle 到顶层）。两包 `files` 中
  `lib/invariant.js` 各出现两次（重复项，cosmetic）。
- 本 checkout 中所有 `lib/` 路径缺失属预期（sync.sh `--exclude lib`，构建在 host 进行）；
  `src/` 侧存在清单与声明完全吻合。
- 仓库内暂无消费方 import `./invariant` 子路径（仅各包 `src/invariant.ts` 的 docblock
  自引用），故当前不一致为潜在发布问题而非现有运行破坏。
