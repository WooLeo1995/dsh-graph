/**
 * Dark-theme regression audit: every color declaration in the workgraph UI
 * must resolve through the harness's real themed tokens. The card module used
 * fictional `--dsh-color-*` names (never defined by the theme, so the UI was
 * permanently light), and the panel's token-bridge block invented
 * `--dsw-alias-line-normal`-style aliases backed by static light values. This
 * spec reads both CSS sources and pins the contract: only the 78 real
 * `--dsw-alias-*` tokens (verified against
 * `dsh-client-ui-theme/lib/styles/design-platform.css`) may be referenced,
 * `--dsh-color-*` and `--dsw-static-*` are banned, and color literals are
 * allowed only as `var()` fallbacks.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function cssSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** The real themed alias vocabulary of the harness (design-platform.css). */
const ALLOWED_ALIASES = new Set([
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-mask-1', 'bg-mask-2',
  'bg-mask-3', 'bg-mask-drop', 'bg-mask-photo', 'bg-module-platform', 'bg-multi-select',
  'bg-overlay', 'bg-skeleton', 'border-inverted', 'border-inverted2', 'border-l1',
  'border-l2', 'border-l2-darkmode-thin', 'border-l3', 'border-l4', 'brand-primary',
  'brand-primary-invert', 'brand-primary-new-colorprimary-new-color', 'brand-text',
  'button-contrast-fill', 'button-elevated-fill', 'button-floating-fill',
  'button-floating-hover', 'button-ghost-active-border', 'button-ghost-active-fill',
  'button-ghost-active-hover', 'button-info-fill', 'button-info-hover',
  'button-primary-dimmed', 'button-primary-fill', 'button-primary-hover',
  'button-tool-bar-fill', 'button-tool-bar-fill-invisible', 'button-tool-bar-hover',
  'interactive-bg-active', 'interactive-bg-hover', 'interactive-bg-hover-accent',
  'interactive-bg-hover-danger', 'interactive-bg-hover-solid', 'label-caption',
  'label-dimmed', 'label-primary', 'label-primary-bluish', 'label-primary-dimmed',
  'label-primary-foreground', 'label-primary-inverted', 'label-secondary',
  'label-tertiary', 'markdown-citation', 'markdown-code-block',
  'markdown-code-block-banner', 'markdown-code-segment-selected',
  'markdown-code-segment-unselected', 'markdown-inline-code', 'markdown-placeholder',
  'markdown-tag', 'scrollbar-bg-l1', 'scrollbar-bg-l2', 'scrollbar-hover-l1',
  'scrollbar-hover-l2', 'state-business-primary', 'state-business-tertiary',
  'state-error-primary', 'state-error-secondary', 'state-success-primary',
  'state-success-secondary', 'state-success-tertiary', 'state-warn-label',
  'state-warn-primary', 'state-warn-secondary', 'state-warn-tertiary', 'toast-bg',
  'tooltip-bg',
])

const CSS_FILES = [
  '../src/client/WorkGraphNode.module.css',
  '../src/client/ActivityPanel.module.css',
] as const

/** Every alias name referenced by the file. */
function referencedAliases(source: string): string[] {
  return [...source.matchAll(/--dsw-alias-([a-z0-9-]+)/g)].map(match => match[1]!)
}

/** Every `--dsh-color-*` name referenced by the file. */
function referencedDshColors(source: string): string[] {
  return [...source.matchAll(/--dsh-color-([a-z0-9-]+)/g)].map(match => match[1]!)
}

/** Color literals that sit outside any `var()` argument (bare colors). */
function bareColorLiterals(source: string): string[] {
  const bare: string[] = []
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
      const index = match.index ?? 0
      const open = line.lastIndexOf('var(', index)
      const close = line.indexOf(')', index)
      // The literal is a var() fallback only when an open `var(` before it
      // has not already closed before the literal.
      if (open === -1 || (close !== -1 && close < index)) bare.push(match[0])
    }
  }
  return bare
}

describe('workgraph CSS theme tokens', () => {
  it('references only real themed aliases (no fictional or dsh-color tokens)', () => {
    for (const relative of CSS_FILES) {
      const source = cssSource(relative)
      expect(referencedDshColors(source), `${relative}: --dsh-color-* is not a real token`).toEqual([])
      const aliases = referencedAliases(source)
      for (const alias of aliases) {
        expect(ALLOWED_ALIASES.has(alias), `${relative}: --dsw-alias-${alias} is not in the theme vocabulary`).toBe(true)
      }
    }
  })

  it('never references static (theme-independent) tokens directly', () => {
    for (const relative of CSS_FILES) {
      const source = cssSource(relative)
      expect(source.match(/--dsw-static-[a-z0-9-]+/g) ?? [], `${relative}: static tokens are light-only`).toEqual([])
    }
  })

  it('allows color literals only as var() fallbacks', () => {
    for (const relative of CSS_FILES) {
      const bare = bareColorLiterals(cssSource(relative))
      expect(bare, `${relative}: bare color literals bypass the theme`).toEqual([])
    }
  })
})
