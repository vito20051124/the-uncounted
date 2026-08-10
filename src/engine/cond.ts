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

/**
 * ★★★ 全部合法的謂詞鍵。這是【執行期】的單一來源，
 * 而 validate-data 會斷言它與 types.ts 的 `Cond` 介面逐鍵相同——
 * 兩份清單分歧時建置失敗，所以它不會偷偷過期。
 *
 * ★ 為什麼需要它（這是本專案目前最嚴重的一個靜默缺陷）：
 *   evaluate 舊版對【不認識的鍵】不做任何事，然後最後 `return true`。
 *   於是把 `flag` 打成 `flagg`、或用一個根本不存在的謂詞名，
 *   後果【不是】那個事件永遠不觸發（那還算好，是死內容），
 *   而是那條門禁【整條消失】——事件變成無條件可觸發。
 *
 *   實測（乾淨的 HEAD）：
 *     evaluate({ at: 'bh:quays' }, ctx@alley)        → false  ✔
 *     evaluate({ arrivedFrom: 'bh:quays' }, ctx)     → true   ★ 門禁消失
 *     evaluate({ zzz: 1 }, ctx)                      → true   ★
 *     evaluate({ flagg: 'never-set' }, ctx)          → true   ★
 *
 *   而 reach-test 只守 16 個登記過的主線事件，其餘 48 個事件的
 *   「條件寫太鬆」完全沒有人在看。所以防線必須在【求值器自己】。
 */
export const COND_KEYS = new Set([
  'all', 'any', 'not',
  'at', 'onEdge', 'hours', 'day', 'tide', 'tideJustTurned',
  'needs', 'copper', 'has', 'injury',
  'canAfford', 'cannotAfford',
  'knowsRoutes', 'knowsRoute', 'rep', 'nodeSecurity',
  'npc', 'npcCount', 'npcOffWage', 'namedAsks', 'wageDays', 'givenAway',
  'flag',
])

export function evaluate(cond: Cond | undefined, ctx: Ctx): boolean {
  if (!cond) return true
  // ★ 大聲失敗，不靜默忽略。一個打錯的謂詞名必須在第一次求值時就炸，
  //   而不是變成一個「條件看起來寫了、其實不存在」的事件。
  for (const k of Object.keys(cond)) {
    if (!COND_KEYS.has(k)) {
      throw new Error(
        `[cond] 不認識的謂詞「${k}」。條件物件：${JSON.stringify(cond).slice(0, 120)}\n`
        + `　　舊版會【靜默忽略】它並回傳 true——也就是那條門禁整條消失、事件無條件觸發。`
        + `　　多半是拼錯（例如 flag 打成 flagg）。合法謂詞見 cond.ts 的 COND_KEYS。`,
      )
    }
  }
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
  /**
   * ★★ 「認得她的人裡，有幾個在【不發工錢的地方】」。
   *
   * 這一條存在的理由是一個量出來的發現：純領工資的玩家會【自動】認得
   * 老克瓦、穗爾、闕（各 100%），而完全不會認得灰姐與石啞（各 0%）——
   * 因為前三人所在的節點有工作，後兩人所在的節點沒有。
   * 於是任何純計數的條件（「認得 N 個人」）都在量錯的東西：
   * 它量的是她上了幾天工，而不是她有沒有去過一個不給她錢的地方。
   *
   * ★ 而它刻意【查工作表而不是寫死名字】。
   *   寫「灰姐或石啞」會在兩件事上壞掉：擴充 NPC 名冊時要手動維護，
   *   以及——更重要的——哪天灰棚巷加了一份工，認得灰姐就【不再證明】
   *   她去過不給錢的地方，而寫死名字的版本會繼續給分。
   *   查表的版本會自己失效，那才是對的。
   */
  if (cond.npcOffWage !== undefined) {
    const paid = new Set([...ctx.idx.job.values()].map((j) => j.at))
    const n = Object.entries(s.npcs).filter(([id, st]) => {
      if (!cmp(st[cond.npcOffWage!.axis], cond.npcOffWage!.is)) return false
      const who = ctx.idx.npc.get(id as never)
      return who !== undefined && !paid.has(who.at)
    }).length
    if (n < cond.npcOffWage.atLeast) return false
  }
  if (cond.namedAsks !== undefined && !cmp(s.stats.namedAsks, cond.namedAsks)) return false
  if (cond.wageDays !== undefined && !cmp(s.stats.wageDays, cond.wageDays)) return false
  if (cond.givenAway !== undefined && !cmp(s.stats.givenAway, cond.givenAway)) return false
  if (cond.flag !== undefined && !s.flags[cond.flag]) return false

  return true
}
