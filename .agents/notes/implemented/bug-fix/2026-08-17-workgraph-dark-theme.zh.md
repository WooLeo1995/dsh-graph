# Agent Note:workgraph UI 深色主题失配 —— 虚构 token 全面映射到宿主主题词汇

Status: implemented

[English](2026-08-17-workgraph-dark-theme.md) | 中文

## 问题

workgraph 的会话内卡片与浮动活动面板从未适配深色主题。对照宿主主题(`@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`,定义了完整 `--dsw-alias-*` 词汇并带 `body[data-ds-dark-theme]` 深色块)验证的根因:

1. **卡片(`WorkGraphNode.module.css`)引用虚构的 `--dsh-color-*` token**——36 处引用在宿主中完全不存在(web dist 零出现)。每个声明都静默落到浅色 fallback(`#fff`、`#ddd`、`#222`…),卡片永远浅色。
2. **面板(`ActivityPanel.module.css`)携带上游 token 桥接块**,发明了别名(`--dsw-alias-line-normal`、`--dsw-alias-bg-module`、`--dsw-alias-bg-fill-*`、`--dsw-alias-state-success/warning/danger`、`--dsw-alias-label-on-fill`),背靠静态浅色值(`--dsw-static-neutral-bluish-*`)。这些别名同样不属于本宿主的词汇——上游桥接块是为另一个 harness 版本写的,面板因此也永远浅色。

## 决议

- **卡片映射到真实主题 token**:surface→`bg-layer-1`、border→`border-l1`、text→`label-primary`、muted→`label-tertiary`、muted bg→`bg-layer-2`、primary→`state-business-primary`、success/warning/error→`state-*-primary`、soft 填充→`state-*-tertiary`(success/warn/business 有 tertiary;error 没有,所以失败节点的 soft 填充用 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-layer-1))`,两种主题都跟随)。
- **面板整体删除桥接块**,使用点直接引用真实 token:`line-normal`→`border-l1`、`line-strong`→`border-l2`、`bg-module`→`bg-layer-1`(小心不改写真实的 `bg-module-platform`)、`bg-fill-neutral`→`bg-layer-2`、`bg-fill-*`→`state-*-primary`、`state-success/warning/danger`→`state-*-primary`、`label-on-fill`→`label-primary-inverted`。
- **静态审计回归测试(`tests/css-theme.client.spec.ts`)**钉死契约:无 `--dsh-color-*` 引用、所有 `--dsw-alias-X` 引用在 78 个真实名单内、无 `--dsw-static-*` 引用、裸色值仅允许作 var() fallback。修复前红(2/3 失败),修复后绿。

## 验证

101/101 ui-workgraph 测试绿(98 既有 + 3 新审计);src 逐文件覆盖 100/100/100/100;`tsc -b` 干净;oxlint 触及文件 0 错误;客户端 bundle 重建并 grep 验证(`dsh-color` 0、`dsw-static` 0、真实 token 在)。深浅色适配现在直接来自宿主主题变量本身。

## 备选方案

**保留桥接块但把背靠值换成主题 token。**否决:桥接别名不属于词汇,留着只是无收益的间接层;直接引用让每个声明都能被静态测试审计。
