/**
 * Human-facing `/graph` command over the work-graph engine: set with an
 * optional token budget, status, the box-drawing DAG view, pause, resume
 * with a top-up, per-node retry, and clear. The grammar is a faithful port
 * of jxca-cli's `/graph` (case-insensitive control words, `resume`/`retry`
 * prefixes that never fall through to set, a trailing own-token `--budget`
 * flag, and the ASCII status glyphs plus the unicode DAG glyphs and legend).
 * @module @deepseek-ai/dsh-command-workgraph
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphSnapshot, WorkNodeState } from '@deepseek-ai/dsh-workgraph'

export const name = 'command-workgraph'
export const inject = ['commands', 'workGraph']

const USAGE = 'Usage: /graph <objective> [--budget <tokens>] | status | show | pause | resume [--budget <tokens>] | retry [node] | clear'

/** The box-drawing DAG width budget; wider output degrades to the status tree. */
const SHOW_WIDTH_BUDGET = 120

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

type GraphCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'show' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume'; readonly budget: number | undefined }
  | { readonly kind: 'retry'; readonly node: string | undefined }
  | { readonly kind: 'clear' }
  | { readonly kind: 'set'; readonly objective: string; readonly budget: number | undefined }

/**
 * Parse only the grammar owned by `/graph`; anything else is an objective.
 * ANY input starting with `resume` or `retry` resolves to that command and
 * never falls through to set — a typo'd top-up must not silently replace a
 * resumable budget-limited graph (jxca contract).
 */
function parseGraphCommand(rawInput: string): GraphCommand {
  const trimmed = rawInput.trim()
  const control = trimmed.toLowerCase()
  switch (control) {
    case '':
    case 'status':
      return { kind: 'status' }
    case 'show':
      return { kind: 'show' }
    case 'pause':
      return { kind: 'pause' }
    case 'resume':
      return { kind: 'resume', budget: undefined }
    case 'retry':
      return { kind: 'retry', node: undefined }
    case 'clear':
      return { kind: 'clear' }
  }
  if (control.startsWith('resume')) {
    // Well-formed `resume --budget <tokens>` carries the top-up; malformed
    // variants resolve to a plain resume, whose budget-limited arm prints
    // the top-up hint.
    const rest = trimmed.slice('resume'.length).trim()
    let budget: number | undefined
    if (rest.toLowerCase().startsWith('--budget')) {
      const value = rest.slice('--budget'.length).trim()
      if (value.length > 0 && /^\d+$/u.test(value)) {
        const parsed = Number(value)
        if (Number.isSafeInteger(parsed) && parsed > 0) budget = parsed
      }
    }
    return { kind: 'resume', budget }
  }
  if (control.startsWith('retry')) {
    const node = trimmed.slice('retry'.length).trim()
    /* v8 ignore next 2 -- the exact 'retry' case above already handles an empty rest */
    return { kind: 'retry', node: node.length === 0 ? undefined : node }
  }
  const { objective, budget } = parseSetBudget(trimmed)
  return { kind: 'set', objective, budget }
}

/**
 * Split a trailing `--budget <tokens>` flag off an objective. Only a
 * TRAILING, standalone flag is consumed: the flag must be its own
 * whitespace-separated token and the value a final all-digit positive
 * token; anything else stays part of the objective (jxca contract).
 */
function parseSetBudget(trimmed: string): { objective: string; budget: number | undefined } {
  const index = trimmed.lastIndexOf('--budget')
  if (index !== -1) {
    const head = trimmed.slice(0, index)
    const tail = trimmed.slice(index + '--budget'.length)
    const value = tail.trim()
    const flagIsOwnToken = /\s$/u.test(head) && /^\s/u.test(tail) && !/\s/u.test(value)
    const objective = head.trimEnd()
    if (flagIsOwnToken && objective.length > 0 && value.length > 0 && /^\d+$/u.test(value)) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return { objective, budget: parsed }
      }
    }
  }
  return { objective: trimmed, budget: undefined }
}

/** Human label for one graph lifecycle status. */
function statusLabel(status: WorkGraphSnapshot['status']): string {
  switch (status) {
    case 'active': return 'active'
    case 'user_paused': return 'user paused'
    case 'infra_paused': return 'infra paused'
    case 'blocked': return 'blocked'
    case 'budget_limited': return 'budget limited'
    case 'complete': return 'complete'
    /* v8 ignore next 2 -- WorkGraphStatus is closed and every member is handled above */
    default: return assertNever(status, 'graph status')
  }
}

/** The status-tree glyph per node state (jxca ASCII set). */
function statusGlyph(state: WorkNodeState): string {
  switch (state) {
    case 'achieved': return '[x]'
    case 'running': return '[>]'
    case 'ready': return '[ ]'
    case 'waiting': return '[.]'
    case 'failed': return '[!]'
    case 'blocked': return '[-]'
    /* v8 ignore next 2 -- WorkNodeState is closed and every member is handled above */
    default: return assertNever(state, 'node state')
  }
}

/**
 * Render the snapshot returned by a dispatch (set/resume/retry): the command
 * returns immediately while the graph runs in the background, so a pending
 * (zero-node) graph carries a progress hint instead of looking stuck.
 */
function renderDispatch(snapshot: WorkGraphSnapshot): string {
  const rendered = renderStatus(snapshot)
  if (snapshot.status === 'active' && snapshot.nodes.length === 0) {
    return `${rendered}\nPlanning and execution run in the background — /graph status|show and the DAG view update as it proceeds.`
  }
  return rendered
}

/** The DAG glyph per node state (jxca unicode set). */
function dagGlyph(state: WorkNodeState): string {
  switch (state) {
    case 'achieved': return '✓'
    case 'running': return '▶'
    case 'ready': return '○'
    case 'waiting': return '·'
    case 'failed': return '✗'
    case 'blocked': return '⊘'
    /* v8 ignore next 2 -- WorkNodeState is closed and every member is handled above */
    default: return assertNever(state, 'node state')
  }
}

/** The indented status tree: per-node glyph, id, title, waits, rounds, failure. */
function renderStatus(snapshot: WorkGraphSnapshot): string {
  const achieved = snapshot.nodes.filter(node => node.state === 'achieved').length
  const lines: string[] = [
    `Graph: ${snapshot.objective}`,
    `Status: ${statusLabel(snapshot.status)} | Plan v${snapshot.planVersion}`,
    `Nodes: ${achieved}/${snapshot.nodes.length} achieved`,
  ]
  for (const node of snapshot.nodes) {
    let line = `  ${statusGlyph(node.state)} ${node.id} — ${node.title}`
    if (node.state === 'waiting' && node.blocks.length > 0) {
      line += `  (waiting on ${node.blocks.join(', ')})`
    }
    if (node.state === 'achieved') {
      line += `  (${node.rounds} rounds)`
    }
    if (node.failure !== undefined) {
      line += `  — ${node.failure}`
    }
    lines.push(line)
  }
  let tokens = `Tokens: ${snapshot.tokensSpent}`
  if (snapshot.tokenBudget !== undefined) tokens += ` | Budget: ${snapshot.tokenBudget}`
  lines.push(tokens)
  if (snapshot.pendingDiscoveries.length > 0) {
    lines.push(`Discoveries: ${snapshot.pendingDiscoveries.length} pending replan`)
  }
  if (snapshot.pauseReason !== undefined) {
    lines.push(`Paused: ${snapshot.pauseReason}`)
  }
  return lines.join('\n')
}

/** The box-drawing DAG, or `undefined` when it cannot fit the width budget. */
function renderShow(snapshot: WorkGraphSnapshot): string {
  const rendered = renderDag(snapshot, SHOW_WIDTH_BUDGET)
  return rendered ?? renderStatus(snapshot)
}

// ---------------------------------------------------------------------------
// Box-drawing DAG (ported from jxca-cli graph_render.rs): longest-path
// layering, dummy chains, one-pass barycenter ordering, horizontal packing,
// and lane-packed connector buses. Spaces never overwrite ink.
// ---------------------------------------------------------------------------

/** Merge one grid cell glyph with an incoming glyph (blank cells yield). */
function mergeGlyph(existing: string, incoming: string): string {
  if (incoming === ' ') return existing
  if (existing === ' ') return incoming
  if ((existing === '─' && incoming === '│') || (existing === '│' && incoming === '─')) return '┼'
  /* v8 ignore start -- defensive matrix cells (jxca provenance); the painters never emit ┴/┬ as incoming */
  if ((existing === '─' && incoming === '┴') || (existing === '┴' && incoming === '─')) return '┴'
  if ((existing === '─' && incoming === '┬') || (existing === '┬' && incoming === '─')) return '┬'
  /* v8 ignore stop */
  return incoming
}

/** A character grid that never lets blanks overwrite ink. */
class Canvas {
  private readonly grid: string[][]
  private readonly width: number

  constructor(width: number) {
    this.width = width
    this.grid = []
  }

  private row(index: number): string[] {
    let row = this.grid[index]
    if (row === undefined) {
      row = Array.from({ length: this.width }, () => ' ')
      this.grid[index] = row
    }
    return row
  }

  put(row: number, column: number, glyph: string): void {
    /* v8 ignore next -- rows are pre-filled with spaces, so the nullish fallback never fires */
    this.row(row)[column] = mergeGlyph(this.row(row)[column] ?? ' ', glyph)
  }

  putStr(row: number, column: number, text: string): void {
    for (const [offset, char] of [...text].entries()) {
      this.put(row, column + offset, char)
    }
  }

  render(): string {
    return this.grid.map(row => row.join('').replace(/\s+$/u, '')).join('\n')
  }
}

/** Truncate a label to the title budget with a trailing ellipsis. */
function truncateTitle(title: string, budget: number): string {
  const chars = [...title]
  return chars.length > budget ? `${chars.slice(0, budget - 1).join('')}…` : title
}

/**
 * Render the graph as layered box-drawing text, or `undefined` when the
 * packing cannot fit `maxWidth` (the caller degrades to the status tree).
 * @param snapshot - the graph snapshot.
 * @param maxWidth - the horizontal budget.
 */
function renderDag(snapshot: WorkGraphSnapshot, maxWidth: number): string | undefined {
  const nodes = snapshot.nodes
  const count = nodes.length
  if (count === 0) return undefined
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]))
  // Blocks edges only; DiscoveredFrom is audit metadata (its origin is
  // terminal; drawing it doubles edges without scheduling meaning).
  const edges: Array<[number, number]> = []
  for (const [to, node] of nodes.entries()) {
    for (const dep of node.blocks) {
      const from = indexOf.get(dep)
      /* v8 ignore next -- the fold rejects non-canonical block ids, so an unknown live dep is unreachable */
      if (from !== undefined) edges.push([from, to])
    }
  }

  // Longest-path layering (deps validated acyclic upstream).
  const layer = new Array<number>(count).fill(0)
  let changed = true
  let guard = 0
  while (changed) {
    changed = false
    guard += 1
    if (guard > count + 1) {
      // A cycle can only mean upstream validation was bypassed —
      // refuse to render garbage.
      return undefined
    }
    for (const [from, to] of edges) {
      /* v8 ignore next 3 -- the layer array is fully filled before this loop, so the nullish fallbacks never fire */
      if ((layer[to] ?? 0) < (layer[from] ?? 0) + 1) {
        layer[to] = (layer[from] ?? 0) + 1
        changed = true
      }
    }
  }
  const depth = Math.max(...layer, 0) + 1

  // Dummy chains: split any edge spanning >1 layer into unit hops.
  // Segment endpoints are (layer, slot) pairs; real slots 0..n, dummy
  // slots appended after.
  const slots: Array<{ real: number | undefined }> = nodes.map((_node, index) => ({ real: index }))
  const slotLayer: number[] = [...layer]
  const hops: Array<[number, number]> = []
  for (const [from, to] of edges) {
    let previous = from
    /* v8 ignore next -- the layer array is fully filled, so the nullish fallbacks never fire */
    for (let midLayer = (layer[from] ?? 0) + 1; midLayer < (layer[to] ?? 0); midLayer += 1) {
      slots.push({ real: undefined })
      slotLayer.push(midLayer)
      const dummy = slots.length - 1
      hops.push([previous, dummy])
      previous = dummy
    }
    hops.push([previous, to])
  }

  // Layer membership + one-pass barycenter ordering (parents' mean
  // position; stable by construction order for roots).
  const layers: number[][] = Array.from({ length: depth }, () => [])
  for (const [slot, level] of slotLayer.entries()) {
    /* v8 ignore next -- every level in slotLayer is a built layer, so the fallback never fires */
    const members = layers[level] ?? []
    members.push(slot)
    layers[level] = members
  }
  const pos = new Array<number>(slots.length).fill(0)
  /* v8 ignore next -- depth >= 1 guarantees a root layer */
  const rootLayer = layers[0] ?? []
  rootLayer.forEach((slot, index) => { pos[slot] = index })
  for (let level = 1; level < depth; level += 1) {
    /* v8 ignore next -- every level below depth is a built layer, so the fallback never fires */
    const members = layers[level] ?? []
    const keyed = members.map((slot) => {
      const parents = hops
        .filter(([, to]) => to === slot)
        .map(([from]) => from)
      /* v8 ignore next 2 -- mid-layer slots always have a parent (layers derive from edges); the branch is jxca's defensive ordering */
      const key = parents.length === 0
        // Parentless mid-layer nodes go last, stably.
        ? Number.MAX_VALUE
        : parents.reduce((sum, parent) => sum + (pos[parent] ?? 0), 0) / parents.length
      return [key, slot] as const
    })
    keyed.sort((a, b) => a[0] - b[0])
    layers[level] = keyed.map(([, slot]) => slot)
    keyed.forEach(([, slot], index) => { pos[slot] = index })
  }

  // Horizontal packing per layer; grid width = widest layer.
  const TITLE_BUDGET = 18
  const H_GAP = 3
  const labelOf = (index: number): string => {
    const node = nodes[index]
    /* v8 ignore next -- every painted slot holds a real node index */
    if (node === undefined) return ''
    return `${dagGlyph(node.state)} ${truncateTitle(node.title, TITLE_BUDGET)}`
  }
  const cells = new Map<number, { node: number | undefined; center: number; left: number; label: string }>()
  let gridWidth = 0
  for (const members of layers) {
    let x = 0
    for (const slot of members) {
      const real = slots[slot]?.real
      if (real !== undefined) {
        const label = labelOf(real)
        const boxWidth = [...label].length + 2
        cells.set(slot, { node: real, center: x + Math.floor(boxWidth / 2), left: x, label })
        x += boxWidth + H_GAP
      } else {
        cells.set(slot, { node: undefined, center: x, left: x, label: '' })
        x += 1 + H_GAP
      }
    }
    gridWidth = Math.max(gridWidth, Math.max(0, x - H_GAP))
  }
  if (gridWidth > maxWidth) return undefined

  // Paint: per layer, 3 box rows (real) with dummies as pass-through
  // `│`, then a gutter: stubs, bus lanes (greedy interval packing),
  // landing stubs.
  const canvas = new Canvas(gridWidth)
  let row = 0
  for (const [level, members] of layers.entries()) {
    // Box band.
    for (const slot of members) {
      const cell = cells.get(slot)
      /* v8 ignore next -- every painted slot has a cell */
      if (cell === undefined) continue
      if (cell.node !== undefined) {
        const width = [...cell.label].length + 2
        canvas.put(row, cell.left, '┌')
        canvas.put(row + 2, cell.left, '└')
        for (let column = 1; column < width - 1; column += 1) {
          canvas.put(row, cell.left + column, '─')
          canvas.put(row + 2, cell.left + column, '─')
        }
        canvas.put(row, cell.left + width - 1, '┐')
        canvas.put(row + 2, cell.left + width - 1, '┘')
        canvas.put(row + 1, cell.left, '│')
        canvas.putStr(row + 1, cell.left + 1, cell.label)
        canvas.put(row + 1, cell.left + width - 1, '│')
      } else {
        for (let r = 0; r < 3; r += 1) {
          canvas.put(row + r, cell.center, '│')
        }
      }
    }
    row += 3
    if (level + 1 === depth) break
    // Gutter for hops level -> level+1.
    const thisLayer = hops
      .filter(([from]) => slotLayer[from] === level)
      .flatMap(([from, to]) => {
        const fromCell = cells.get(from)
        const toCell = cells.get(to)
        /* v8 ignore next 2 -- every painted slot has a cell, so the miss arm never fires */
        return fromCell === undefined || toCell === undefined
          ? []
          : [[fromCell.center, toCell.center] as const]
      })
    // Greedy lane packing: edges whose horizontal spans overlap get
    // distinct bus lanes.
    const lanes: Array<Array<readonly [number, number]>> = []
    const laneOf: number[] = []
    for (const [a, b] of thisLayer) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const lane = lanes.findIndex(candidate => candidate.every(([lLo, lHi]) => hi + 1 < lLo || lHi + 1 < lo))
      const index = lane === -1 ? (lanes.push([]), lanes.length - 1) : lane
      const laneMembers = lanes[index]
      /* v8 ignore next -- the push above guarantees the lane exists */
      if (laneMembers !== undefined) laneMembers.push([lo, hi])
      laneOf.push(index)
    }
    const laneCount = Math.max(lanes.length, 1)
    // Row layout: 1 stub row + lane_count bus rows + 1 landing row.
    thisLayer.forEach(([src, dst], index) => {
      /* v8 ignore next -- every painted hop has a recorded lane */
      const lane = laneOf[index] ?? 0
      const busRow = row + 1 + lane
      // Source stub down to its bus lane.
      for (let r = row; r <= busRow; r += 1) {
        canvas.put(r, src, '│')
      }
      // Bus.
      const [lo, hi] = src < dst ? [src, dst] : [dst, src]
      if (lo !== hi) {
        for (let column = lo; column <= hi; column += 1) {
          canvas.put(busRow, column, '─')
        }
        canvas.put(busRow, src, src < dst ? '└' : '┘')
        canvas.put(busRow, dst, src < dst ? '┐' : '┌')
      }
      // Descent from the bus to the landing row.
      for (let r = busRow + 1; r < row + 1 + laneCount + 1; r += 1) {
        canvas.put(r, dst, '│')
      }
      canvas.put(row + laneCount + 1, dst, '▼')
    })
    row += laneCount + 2
  }

  const legend = '✓ achieved  ▶ running  ○ ready  · waiting  ✗ failed  ⊘ blocked'
  return [
    `Graph: ${snapshot.objective} (plan v${snapshot.planVersion})`,
    '',
    canvas.render(),
    '',
    legend,
  ].join('\n')
}

/** Direct error for an operation that requires a current graph. */
function noGraph(action: string): CommandResult {
  return {
    kind: 'error',
    text: `No graph is set; /graph ${action} requires one.\n${USAGE}`,
  }
}

/** Execute one parsed human command through the engine that owns the graph. */
async function executeGraphCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseGraphCommand(invocation.rawInput)
  const agent = invocation.agent
  try {
    switch (command.kind) {
      case 'status': {
        const current = await ctx.workGraph.status(agent)
        return current === null
          ? { kind: 'success', text: `No graph is set.\n${USAGE}` }
          : { kind: 'success', text: renderStatus(current) }
      }
      case 'show': {
        const current = await ctx.workGraph.status(agent)
        return current === null
          ? { kind: 'success', text: `No graph is set.\n${USAGE}` }
          : { kind: 'success', text: renderShow(current) }
      }
      case 'pause': {
        const current = await ctx.workGraph.status(agent)
        if (current === null) return noGraph('pause')
        await ctx.workGraph.pause(agent, 'Paused via /graph pause.')
        // Re-read after bounded child settlement: the drive's demote lands
        // before quiescence, so the render shows the settled view.
        const settled = await ctx.workGraph.status(agent)
        return { kind: 'success', text: renderStatus(settled ?? current) }
      }
      case 'resume': {
        const current = await ctx.workGraph.status(agent)
        if (current === null) return noGraph('resume')
        const resumed = await ctx.workGraph.dispatchResume(
          agent,
          command.budget === undefined ? undefined : { budget: command.budget },
        )
        return { kind: 'success', text: renderDispatch(resumed) }
      }
      case 'retry': {
        const current = await ctx.workGraph.status(agent)
        if (current === null) return noGraph('retry')
        if (command.node === undefined) {
          const before = current.nodes.filter(node => node.state === 'failed').length
          if (before === 0) return { kind: 'success', text: 'No failed nodes to retry.' }
          const retried = await ctx.workGraph.dispatchRetryAll(agent)
          return {
            kind: 'success',
            text: `Retried ${before} failure chain(s).\n${renderDispatch(retried)}`,
          }
        }
        const retried = await ctx.workGraph.dispatchRetry(agent, command.node as never)
        return { kind: 'success', text: renderDispatch(retried) }
      }
      case 'clear': {
        const current = await ctx.workGraph.status(agent)
        if (current === null) return { kind: 'success', text: 'No graph to clear.' }
        await ctx.workGraph.clear(agent)
        return { kind: 'success', text: 'Graph cleared.' }
      }
      case 'set': {
        const snapshot = await ctx.workGraph.dispatchSet(agent, {
          objective: command.objective,
          ...(command.budget === undefined ? {} : { tokenBudget: command.budget }),
        })
        return { kind: 'success', text: renderDispatch(snapshot) }
      }
      /* v8 ignore next 2 -- GraphCommand is closed and every member is handled above */
      default: return assertNever(command, 'graph command')
    }
  } catch (error: unknown) {
    if (error instanceof WorkGraphError) {
      return { kind: 'error', text: error.message }
    }
    throw error
  }
}

/** Register the `/graph` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'graph',
    description: 'turn an objective into a dependency graph of autonomous, self-verifying nodes',
    input: { hint: '<objective> [--budget <tokens>] | status | show | pause | resume [--budget <tokens>] | retry [node] | clear' },
    handler: invocation => executeGraphCommand(ctx, invocation),
  })
}
