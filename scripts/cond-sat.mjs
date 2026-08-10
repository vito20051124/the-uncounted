/**
 * 條件的【可滿足性】判定 —— 只在「可證明恆假」時說話。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 設計約束：寧可漏判，絕不誤判（sound underapproximation）。
 *
 * 它的用途是擋下「條件寫了，但那個條件永遠不可能成立」的內容——
 * 那種東西通過全部既有驗收，因為每一條參照本身都合法，
 * 只是它們合起來永遠為假。實例（對抗式攻擊實際做出來的）：
 *   requires: { all: [ { hours: [6, 7] }, { hours: [20, 21] } ] }
 *   一個「早上六到七點」且「晚上八到九點」的事件，永遠抽不出來。
 *
 * 而它【必須】寧可漏判：一個會誤報的可滿足性判定會逼人去放寬它，
 * 放寬幾次之後它就什麼都抓不到了。所以下面每一條規則都只處理
 * 「不需要任何假設就能證明矛盾」的形狀，其餘一律回 null（＝可能為真）。
 *
 * ★ 刻意【不處理 not】的一般情形：not 底下的東西要做真正的邏輯否定，
 *   而那會立刻需要一個 SAT 求解器。只挑三個直接矛盾的形狀
 *   （has.item / knowsRoute / flag 的正反同時出現）。
 * ══════════════════════════════════════════════════════════════════
 */

/** 解析 '<15' '>=30' '=0' '!=0' → { op, n }；不認識就回 null（不猜） */
function parseCmp(expr) {
  const m = /^\s*(<=|>=|!=|<|>|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(expr))
  return m ? { op: m[1], n: Number(m[2]) } : null
}

/** 一個 cmp 在 [lo, hi] 這個整數閉區間裡有解嗎 */
function cmpHasSolutionIn(cmp, lo, hi) {
  const { op, n } = cmp
  switch (op) {
    case '>=': return hi >= n
    case '>': return hi > n
    case '<=': return lo <= n
    case '<': return lo < n
    case '=': return n >= lo && n <= hi
    case '!=': return !(lo === hi && lo === n)
    default: return true
  }
}

/** hours: [from, to] → 覆蓋的整數小時集合（from > to 視為跨午夜，比照 cond.ts 的 inHours） */
function hourSet(pair) {
  if (!Array.isArray(pair) || pair.length !== 2) return null
  const [from, to] = pair
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  const out = new Set()
  if (from <= to) { for (let h = from; h < to; h++) out.add(h % 24) }
  else { for (let h = from; h < 24; h++) out.add(h); for (let h = 0; h < to; h++) out.add(h) }
  return out
}

/**
 * 收集一個 `all` 鏈上的約束（含直接嵌在裡面的 all）。
 * any 底下不收集——那是聯集，不能當成必須同時成立的約束。
 */
function collect(cond, acc) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return
  for (const sub of cond.all ?? []) collect(sub, acc)

  if (cond.hours) { const s = hourSet(cond.hours); if (s) acc.hours.push({ set: s, raw: cond.hours }) }
  if (cond.at !== undefined) acc.at.push(new Set([].concat(cond.at)))
  if (cond.tide !== undefined) acc.tide.add(cond.tide)
  if (cond.day !== undefined) { const c = parseCmp(cond.day); if (c) acc.day.push(c) }
  if (cond.wageDays !== undefined) { const c = parseCmp(cond.wageDays); if (c) acc.wageDays.push(c) }
  if (cond.namedAsks !== undefined) { const c = parseCmp(cond.namedAsks); if (c) acc.namedAsks.push(c) }
  if (cond.npcCount?.atLeast !== undefined) acc.npcCountAtLeast.push(cond.npcCount.atLeast)
  if (cond.npcOffWage?.atLeast !== undefined) acc.npcOffWageAtLeast.push(cond.npcOffWage.atLeast)
  if (cond.has?.item) acc.hasItem.add(cond.has.item)
  if (cond.knowsRoute) acc.knowsRoute.add(cond.knowsRoute)
  if (typeof cond.flag === 'string') acc.flag.add(cond.flag)

  // ★ not 只挑三個「正反同時出現即矛盾」的形狀，其餘不下鑽
  const n = cond.not
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    if (n.has?.item) acc.notHasItem.add(n.has.item)
    if (n.knowsRoute) acc.notKnowsRoute.add(n.knowsRoute)
    if (typeof n.flag === 'string') acc.notFlag.add(n.flag)
  }
}

/**
 * @param cond 條件樹
 * @param env  { lastDay, npcTotal, offWageTotal }
 * @returns null（可能為真）| string（恆假的理由，人看得懂）
 */
export function unsat(cond, env = {}) {
  if (!cond || typeof cond !== 'object') return null
  const lastDay = env.lastDay ?? 30
  const npcTotal = env.npcTotal ?? Infinity
  const offWageTotal = env.offWageTotal ?? Infinity

  // any：只有【每一支都恆假】才算恆假
  if (Array.isArray(cond.any) && cond.any.length > 0) {
    const reasons = cond.any.map((c) => unsat(c, env))
    if (reasons.every(Boolean)) return `any 的每一支都恆假（${reasons[0]}…）`
    // 有一支可能為真 → 整個 any 可能為真；但外層 all 的約束仍要查
  }

  const acc = {
    hours: [], at: [], tide: new Set(), day: [], wageDays: [], namedAsks: [],
    npcCountAtLeast: [], npcOffWageAtLeast: [],
    hasItem: new Set(), knowsRoute: new Set(), flag: new Set(),
    notHasItem: new Set(), notKnowsRoute: new Set(), notFlag: new Set(),
  }
  collect(cond, acc)

  // ① 時窗交集為空
  if (acc.hours.length > 1) {
    let inter = acc.hours[0].set
    for (const h of acc.hours.slice(1)) inter = new Set([...inter].filter((x) => h.set.has(x)))
    if (inter.size === 0) {
      return `時窗交集為空：${acc.hours.map((h) => `[${h.raw.join('–')}]`).join(' ∩ ')}`
    }
  }
  // ② 地點交集為空
  if (acc.at.length > 1) {
    let inter = acc.at[0]
    for (const s of acc.at.slice(1)) inter = new Set([...inter].filter((x) => s.has(x)))
    if (inter.size === 0) return `at 交集為空：${acc.at.map((s) => [...s].join('|')).join(' ∩ ')}`
  }
  // ③ 潮汐不可能同時是兩種
  if (acc.tide.size > 1) return `同時要求 tide 為 ${[...acc.tide].join(' 與 ')}`
  /**
   * ④⑤ 數值型約束一律【收斂成區間】再看是否為空。
   *
   * ★ 第一版對每個 cmp 【各自】檢查是否落在 [1, lastDay] 內，
   *   於是 `all: [{day:'>=20'}, {day:'<5'}]` 兩條各自都有解、合起來矛盾 → 漏判。
   *   單元測試抓到的正是這一項（而且是漏判方向，不是誤報方向）。
   */
  const rangeUnsat = (cmps, lo0, hi0, label) => {
    if (cmps.length === 0) return null
    let lo = lo0, hi = hi0
    const nots = []
    for (const { op, n } of cmps) {
      switch (op) {
        case '>=': lo = Math.max(lo, n); break
        case '>': lo = Math.max(lo, n + 1); break
        case '<=': hi = Math.min(hi, n); break
        case '<': hi = Math.min(hi, n - 1); break
        case '=': lo = Math.max(lo, n); hi = Math.min(hi, n); break
        // ★ != 不能用來收斂區間（它挖掉一個點）。只在區間已塌成單點時才有判斷力。
        case '!=': nots.push(n); break
        default: break
      }
    }
    if (lo > hi) {
      return `${label} 的約束交集為空（收斂後 ${lo}..${hi}，可行範圍 ${lo0}..${hi0}）：`
        + cmps.map((c) => `${c.op}${c.n}`).join(' 且 ')
    }
    if (lo === hi && nots.includes(lo)) return `${label} 只剩 ${lo} 一個值，而它被 !=${lo} 排除`
    return null
  }
  const dayBad = rangeUnsat(acc.day, 1, lastDay, 'day')
  if (dayBad) return dayBad
  const wageBad = rangeUnsat(acc.wageDays, 0, lastDay, 'wageDays')
  if (wageBad) return wageBad
  const askBad = rangeUnsat(acc.namedAsks, 0, Infinity, 'namedAsks')
  if (askBad) return askBad
  // ⑥ 認得的人數超過名冊人數
  for (const k of acc.npcCountAtLeast) {
    if (k > npcTotal) return `npcCount.atLeast=${k} 超過名冊上的 ${npcTotal} 人`
  }
  for (const k of acc.npcOffWageAtLeast) {
    if (k > offWageTotal) return `npcOffWage.atLeast=${k} 超過「所在節點無工作」的 ${offWageTotal} 人`
  }
  // ⑦ 正反直接矛盾
  for (const it of acc.hasItem) if (acc.notHasItem.has(it)) return `同時要求持有與不持有 ${it}`
  for (const r of acc.knowsRoute) if (acc.notKnowsRoute.has(r)) return `同時要求知道與不知道 ${r}`
  for (const f of acc.flag) if (acc.notFlag.has(f)) return `同時要求 flag ${f} 成立與不成立`

  return null
}

/** 幾個 day 區間的交集是否為空（供 ④ 的雙向判定；目前僅內部使用） */
export const _internal = { parseCmp, hourSet, cmpHasSolutionIn }
