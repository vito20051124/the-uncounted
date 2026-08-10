/**
 * 紀律 7：所有條件走【同一個】求值器。
 * 引擎任何地方都禁止寫 inline 的 `if (state.needs.satiety < 20)`。
 */

import type { Cmp, Cond, EdgeId, GameState, Index, ItemId, NeedKey } from './types.ts'

export interface Ctx {
  s: GameState
  idx: Index
  /** 目前正走在哪條邊上（僅移動事件用） */
  onEdge?: EdgeId
  tide: import('./types.ts').Tide
  tideJustTurned?: import('./types.ts').Tide
}

/** 解析 '<15' '>=30' '=0' '!=0' 形式的比較式 */
export function cmp(value: number, expr: Cmp): boolean {
  const m = /^\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(expr)
  if (!m) throw new Error(`[cond] 無法解析的比較式：${expr}`)
  const n = Number(m[2])
  switch (m[1]) {
    case '<': return value < n
    case '<=': return value <= n
    case '>': return value > n
    case '>=': return value >= n
    case '=': return value === n
    case '!=': return value !== n
    default: throw new Error(`[cond] 未知運算子：${m[1]}`)
  }
}

/**
 * ★ 跨午夜時段。
 * hours: [5, 8]  → 05:00 ≤ t < 08:00
 * hours: [22, 4] → 22:00 ≤ t < 24:00 或 00:00 ≤ t < 04:00
 * from > to 一律視為跨午夜；天真的 `t>=from && t<to` 在此情況永遠為假。
 */
export function inHours(minute: number, from: number, to: number): boolean {
  const h = minute / 60
  return from <= to ? h >= from && h < to : h >= from || h < to
}

function countItem(s: GameState, item: ItemId): number {
  let n = 0
  for (const st of s.carry) if (st.item === item) n += st.count
  return n
}

function priceOf(ctx: Ctx, item: ItemId): number | null {
  return ctx.idx.item.get(item)?.priceCopper ?? null
}

export function evaluate(cond: Cond | undefined, ctx: Ctx): boolean {
  if (!cond) return true
  const { s } = ctx

  if (cond.all && !cond.all.every((c) => evaluate(c, ctx))) return false
  if (cond.any && !cond.any.some((c) => evaluate(c, ctx))) return false
  if (cond.not && evaluate(cond.not, ctx)) return false

  if (cond.at !== undefined) {
    const list = Array.isArray(cond.at) ? cond.at : [cond.at]
    if (!list.includes(s.at)) return false
  }
  if (cond.onEdge !== undefined && ctx.onEdge !== cond.onEdge) return false
  if (cond.hours && !inHours(s.clock.minute, cond.hours[0], cond.hours[1])) return false
  if (cond.tide !== undefined && ctx.tide !== cond.tide) return false
  if (cond.tideJustTurned !== undefined && ctx.tideJustTurned !== cond.tideJustTurned) return false

  if (cond.needs) {
    for (const k of Object.keys(cond.needs) as NeedKey[]) {
      const expr = cond.needs[k]
      if (expr && !cmp(s.needs[k], expr)) return false
    }
  }
  if (cond.copper !== undefined && !cmp(s.purse.copper, cond.copper)) return false
  if (cond.day !== undefined && !cmp(s.clock.day, cond.day)) return false

  if (cond.has && countItem(s, cond.has.item) < (cond.has.min ?? 1)) return false

  if (cond.injury) {
    const q = cond.injury
    const hit = s.injuries.some((inj) => {
      if (q.infected !== undefined && inj.infected !== q.infected) return false
      if (q.untreated !== undefined && (inj.treatedDay !== null) === q.untreated) return false
      if (q.minSeverity !== undefined && inj.severity < q.minSeverity) return false
      if (q.minAgeDays !== undefined && s.clock.day - inj.sinceDay < q.minAgeDays) return false
      return true
    })
    if (!hit) return false
  }

  // ★ 「窮」不是一個數字，是一個關係：引用物價表求值，而非寫死常數
  if (cond.canAfford !== undefined) {
    const p = priceOf(ctx, cond.canAfford)
    if (p === null || s.purse.copper < p) return false
  }
  if (cond.cannotAfford !== undefined) {
    const p = priceOf(ctx, cond.cannotAfford)
    if (p === null || s.purse.copper >= p) return false
  }

  if (cond.knowsRoutes !== undefined && !cmp(s.knownRoutes.length, cond.knowsRoutes)) return false
  if (cond.knowsRoute !== undefined && !s.knownRoutes.includes(cond.knowsRoute)) return false

  if (cond.rep) {
    const v = s.rep[cond.rep.faction] ?? 0
    if (!cmp(v, `${cond.rep.op}${cond.rep.value}`)) return false
  }
  if (cond.nodeSecurity !== undefined) {
    const n = ctx.idx.node.get(s.at)
    if (!n || !cmp(n.security, cond.nodeSecurity)) return false
  }
  if (cond.npc) {
    const st = s.npcs[cond.npc.id]
    const v = st ? st[cond.npc.axis] : 0
    if (!cmp(v, cond.npc.is)) return false
  }
  if (cond.npcCount !== undefined) {
    const n = Object.values(s.npcs).filter((x) => cmp(x[cond.npcCount!.axis], cond.npcCount!.is)).length
    if (n < cond.npcCount.atLeast) return false
  }
  if (cond.namedAsks !== undefined && !cmp(s.stats.namedAsks, cond.namedAsks)) return false
  if (cond.wageDays !== undefined && !cmp(s.stats.wageDays, cond.wageDays)) return false
  if (cond.givenAway !== undefined && !cmp(s.stats.givenAway, cond.givenAway)) return false
  if (cond.flag !== undefined && !s.flags[cond.flag]) return false

  return true
}
