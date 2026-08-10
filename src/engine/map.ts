/**
 * 路網與路線列舉。
 *
 * ★ 本模組是本作對 DoL 的主賣點。若只實作一個 Dijkstra，這一輪等於白做。
 *
 * DoL 的地圖：靜態底圖點一下就瞬移、相鄰沒有意義、地圖不隨世界改變、只有能去/不能去。
 * 本作：
 *   ① 邊是真的路（時間／體力／風險／高程）
 *   ② 路線選擇是真決策 —— 不自動走最短路，列出【Pareto 最優】的數條供選
 *   ③ 世界改變【圖本身】—— 漲潮讓某些邊從圖上消失，不是調整權重
 *   ④ 知識模型 —— 捷徑本來就存在，你只是不知道
 */

import type { EdgeId, GameState, Index, NodeId, Tide, WorldEdge } from './types.ts'
import { inHours } from './cond.ts'

/**
 * 體力消耗：平路每 10 分鐘 1.5；每爬升 5 公尺額外 4（再乘該路段的 climbFactor，階梯遠貴於坡道）。
 *
 * ★ 負重【只放大爬升項】，不等比放大整條路。
 *   若等比放大，所有路線同倍率縮放 → Pareto 排序永遠不變 → 負重對決策毫無影響。
 *   物理上也是如此：扛一袋鹽走平路只是慢，扛一袋鹽爬一百級石階是另一回事。
 *   這一條讓「扛完一天鹽之後，最快的那條路你走不動了」成為真的機制。
 */
/**
 * 體力成本。
 * @param fatigue 疲憊乘數（理智低 → 更累）。★ 刻意設成【顯式參數】而不是在函式內部讀 state，
 *   因為路線卡（offerRoutes）與實際移動（reduce case travel）必須傳入同一個值——
 *   否則 UI 顯示的體力就會與實扣不同，那是一個新的 UI 謊言。
 */
export function staminaFor(e: WorldEdge, from: NodeId, encumbrance: number, fatigue = 1): number {
  const climb = from === e.a ? e.elevationDelta : -e.elevationDelta
  const flat = (e.minutes / 10) * 1.5 * (1 + encumbrance * 0.15)
  const up = (Math.max(0, climb) / 5) * 4 * (e.climbFactor ?? 1) * (1 + encumbrance * 0.6)
  return Math.round((flat + up) * fatigue * 10) / 10
}

/** 該時刻的通行風險 */
export function riskFor(e: WorldEdge, minute: number): number {
  // 夜＝20:00–06:00
  return inHours(minute, 20, 6) ? e.riskNight : e.riskDay
}

/** 這條邊此刻是否存在於圖上（★ 世界改變的是圖本身） */
export function edgeAvailable(
  e: WorldEdge,
  s: GameState,
  tide: Tide
): { ok: true } | { ok: false; why: string } {
  if (e.knowledge === 'learned' && !s.knownRoutes.includes(e.id)) {
    return { ok: false, why: '你不知道這條路' }
  }
  if (e.requiresTide && e.requiresTide !== tide) {
    return { ok: false, why: e.requiresTide === 'ebb' ? '漲潮，此路不通' : '退潮，此路不通' }
  }
  return { ok: true }
}

export interface Route {
  edges: EdgeId[]
  nodes: NodeId[]
  minutes: number
  stamina: number
  /** 1 − Π(1−pₑ)：整條路至少發生一次危險的機率 */
  risk: number
  /** 是否卡宵禁／通行證 */
  gated: boolean
  /**
   * ★ 體力不足以走完這條路。
   * 這才是「疲勞把選項關掉」的正確模型 —— 不是 Pareto 支配關係翻轉，
   * 而是可行性約束：扛完一天鹽之後，百階梯不是變差，是你走不上去。
   */
  exhausting: boolean
  tells: string[]
  label: string
}

/** 目前體力下這條路可不可行（留 8 點餘裕，走到一半虛脫比走不到更糟） */
export function affordable(r: Route, stamina: number): boolean {
  return r.stamina <= stamina - 8
}

/** DFS 全枚舉無環路徑。6 節點 14 邊只有幾百條，毫秒級，不需要任何演算法庫。 */
export function enumerateRoutes(
  s: GameState,
  idx: Index,
  tide: Tide,
  to: NodeId,
  encumbrance = 0,
  fatigue = 1,
  maxHops = 5
): Route[] {
  const out: Route[] = []
  const from = s.at
  if (from === to) return out

  const walk = (at: NodeId, seen: Set<NodeId>, edges: WorldEdge[], nodes: NodeId[]) => {
    if (edges.length > maxHops) return
    if (at === to) {
      let minutes = 0
      let stamina = 0
      let survive = 1
      const tells: string[] = []
      let cur = from
      let clockMin = s.clock.minute
      for (const e of edges) {
        minutes += e.minutes
        stamina += staminaFor(e, cur, encumbrance, fatigue)
        survive *= 1 - riskFor(e, clockMin)
        if (e.tell) tells.push(e.tell)
        clockMin = (clockMin + e.minutes) % 1440
        cur = cur === e.a ? e.b : e.a
      }
      out.push({
        edges: edges.map((e) => e.id),
        nodes: [...nodes],
        minutes,
        stamina: Math.round(stamina * 10) / 10,
        risk: Math.round((1 - survive) * 1000) / 1000,
        gated: false,
        exhausting: Math.round(stamina * 10) / 10 > s.needs.stamina - 8,
        tells,
        label: edges.map((e) => e.name).join(' → '),
      })
      return
    }
    for (const e of idx.adj.get(at) ?? []) {
      const next = at === e.a ? e.b : e.a
      if (seen.has(next)) continue
      if (!edgeAvailable(e, s, tide).ok) continue
      seen.add(next)
      edges.push(e)
      nodes.push(next)
      walk(next, seen, edges, nodes)
      edges.pop()
      nodes.pop()
      seen.delete(next)
    }
  }
  walk(from, new Set([from]), [], [from])
  return out
}

/** a 是否在所有維度上都不劣於 b，且至少一維嚴格更優 */
function dominates(a: Route, b: Route): boolean {
  const le = a.minutes <= b.minutes && a.stamina <= b.stamina && a.risk <= b.risk
  const lt = a.minutes < b.minutes || a.stamina < b.stamina || a.risk < b.risk
  return le && lt
}

export function paretoFront(routes: Route[]): Route[] {
  return routes.filter((r) => !routes.some((o) => o !== r && dominates(o, r)))
}

/** 兩條路線是否至少有一維相差 ≥25%（避免呈現三條「感覺一樣」的路） */
function distinctEnough(a: Route, b: Route): boolean {
  const rel = (x: number, y: number) => {
    const m = Math.max(x, y)
    return m === 0 ? 0 : Math.abs(x - y) / m
  }
  return rel(a.minutes, b.minutes) >= 0.25 || rel(a.stamina, b.stamina) >= 0.25 || rel(a.risk, b.risk) >= 0.25
}

/**
 * 供 UI 呈現的路線選項：Pareto 前緣 → 去除過於相似者 → 最多 3 條。
 * ★ 若前緣只有 1 條，就誠實只給 1 條，不硬湊三個假選項。
 */
export function offerRoutes(
  s: GameState,
  idx: Index,
  tide: Tide,
  to: NodeId,
  encumbrance = 0,
  fatigue = 1
): Route[] {
  const front = paretoFront(enumerateRoutes(s, idx, tide, to, encumbrance, fatigue))
  front.sort((a, b) => a.minutes - b.minutes)
  const picked: Route[] = []
  for (const r of front) {
    if (picked.length >= 3) break
    if (picked.every((p) => distinctEnough(p, r))) picked.push(r)
  }
  return picked.length > 0 ? picked : front.slice(0, 1)
}

/** 目前可直達的鄰居（供 UI 列出「可以去哪」） */
export function reachable(s: GameState, idx: Index, tide: Tide): NodeId[] {
  const set = new Set<NodeId>()
  for (const n of idx.node.keys()) {
    if (n === s.at) continue
    if (enumerateRoutes(s, idx, tide, n).length > 0) set.add(n)
  }
  return [...set]
}
