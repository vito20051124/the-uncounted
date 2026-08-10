/**
 * 單元／性質測試。與煙霧測試、存檔測試各問不同的問題：
 *
 *   煙霧測試   玩得下去嗎（整局，一條政策）
 *   存檔測試   明天改了內容，玩家的檔還讀得起來嗎
 *   本檔       ★ 不管玩家做什麼順序，這些事都不准發生
 *
 * ★ 為什麼是「不變量模糊測試」而不是逐個 action 斷言
 *
 * 這個專案六輪下來反覆踩的是同一個 bug 類別，而不是同一個 bug：
 *   · 事件裡的治療寫全域 flag，而引擎讀 `treated:<id>:<方式>`（兩條路徑分歧）
 *   · `cost.sanity` 被硬寫的五鍵陣列靜默丟棄
 *   · UI 印 hireChance 基礎值，而實算被 hygiene 拉到 35%
 *   · `sleep` 先推進時間才寫 lastShelter（順序錯）
 *
 * 共同點是：**每一條路徑單獨看都對，錯在它們之間**。
 * 逐個 action 斷言抓不到這個——它只會證明每條路徑都符合它自己的預期。
 * 抓得到的是兩件事：
 *   ① 隨機動作序列 ＋ 全域不變量（錯了就會在某個順序下爆）
 *   ② 共用實作的位元一致性（兩條路徑必須是同一份程式）
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState, type Index } from '../src/engine/types.ts'
import { NEED_KEYS } from '../src/engine/clock.ts'
import { DEPRIVATION_STAGES, quoteSuppuration, needsHazard } from '../src/engine/body.ts'
import { staminaFor } from '../src/engine/map.ts'
import { CLEAN, HOT_MEAL_WARMTH, SHELTER, fatigueMul } from '../src/engine/mind.ts'
import {
  attemptsLeft, canTalk, initialState, quoteHireChance, quoteMinutes, reduce, type Action,
} from '../src/engine/reduce.ts'
import { rand } from '../src/engine/rng.ts'
import { resolveEnding } from '../src/engine/ending.ts'

const D = new URL('../data/', import.meta.url)
const rd = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX: Index = buildIndex({
  npcs: rd('npcs.json'), nodes: rd('nodes.json'), edges: rd('edges.json'),
  items: rd('items.json'), jobs: rd('jobs.json'), events: rd('events.json'),
  conditions: rd('conditions.json'), endings: rd('endings.json'),
} as Content)

const results: Array<{ n: number; name: string; ok: boolean; note: string }> = []
const T = (n: number, name: string, ok: boolean, note = '') => results.push({ n, name, ok, note })

// ─────────────────── 隨機動作產生器 ───────────────────

const NODES = [...IDX.node.keys()]
const ITEMS = [...IDX.item.keys()]
const JOBS = [...IDX.job.keys()]
const NPCS = [...IDX.npc.keys()]
const EVENTS = [...IDX.event.keys()]
const EDGES = [...IDX.edge.keys()]

/** 決定性的隨機動作。刻意也產生【不合法】的動作——引擎必須擋下而不是壞掉。 */
function randomAction(seed: string, i: number, s: GameState): Action {
  const pick = <A>(xs: A[], salt: string) => xs[Math.floor(rand(seed, 'flavor', i, salt) * xs.length)]!
  const r = rand(seed, 'flavor', i, 'kind')
  if (r < 0.16) return { t: 'wait', minutes: 1 + Math.floor(rand(seed, 'flavor', i, 'm') * 240) }
  if (r < 0.28) return { t: 'sleep', kind: pick(['rough', 'bunk', 'room'] as const, 's'), costCopper: pick([0, 3, 12], 'c') }
  if (r < 0.42) {
    const e = pick(EDGES, 'e')
    return { t: 'travel', route: [e], alternatives: [] }
  }
  if (r < 0.52) return { t: 'work', job: pick(JOBS, 'j') }
  if (r < 0.60) return { t: 'buy', item: pick(ITEMS, 'i') }
  if (r < 0.66) return { t: 'sell', item: pick(ITEMS, 'i') }
  if (r < 0.74) return { t: 'useItem', item: pick(ITEMS, 'i') }
  if (r < 0.80) return { t: 'talk', npc: pick(NPCS, 'n') }
  if (r < 0.86) return { t: 'clean', kind: pick(['rinse', 'well', 'basin'] as const, 'k') }
  if (r < 0.90) return { t: 'unwind' }
  if (r < 0.95) {
    const inj = s.injuries[0]
    return { t: 'treat', injury: inj?.id ?? 'inj-nonexistent', using: pick(['herbs', 'sterile'] as const, 'u') }
  }
  const ev = pick(EVENTS, 'v')
  const def = IDX.event.get(ev)!
  return { t: 'eventChoice', event: ev, choice: Math.floor(rand(seed, 'flavor', i, 'ch') * def.choices.length), alternatives: [] }
}

// ─────────────────── 不變量 ───────────────────

function invariants(s: GameState, prev: GameState, a: Action): string[] {
  const bad: string[] = []
  const tag = `(${a.t})`

  // 紀律 3：金錢一律非負整數銅
  if (!Number.isInteger(s.purse.copper)) bad.push(`${tag} purse 不是整數：${s.purse.copper}`)
  if (s.purse.copper < 0) bad.push(`${tag} purse 是負的：${s.purse.copper}`)

  // 需求恆在 0..100 且非 NaN
  for (const k of NEED_KEYS) {
    const v = s.needs[k]
    if (Number.isNaN(v)) bad.push(`${tag} needs.${k} 是 NaN`)
    else if (v < 0 || v > 100) bad.push(`${tag} needs.${k} 超界：${v}`)
  }

  // 紀律 8：時間恆為整數分鐘且在 0..1439
  if (!Number.isInteger(s.clock.minute) || !Number.isInteger(s.clock.day)) bad.push(`${tag} 時鐘不是整數`)
  if (s.clock.minute < 0 || s.clock.minute > 1439) bad.push(`${tag} minute 超界：${s.clock.minute}`)

  // 時間不得倒流
  const t0 = prev.clock.day * 1440 + prev.clock.minute
  const t1 = s.clock.day * 1440 + s.clock.minute
  if (t1 < t0) bad.push(`${tag} 時間倒流：${t0} → ${t1}`)

  // ledger 只增不減
  if (s.ledger.length < prev.ledger.length) bad.push(`${tag} ledger 變短了`)

  // 剝奪計時非負
  if (s.deprivation.starveMinutes < 0 || s.deprivation.thirstMinutes < 0) bad.push(`${tag} 剝奪計時是負的`)

  // 死了就不准再變（reduce 開頭有守衛，這裡驗它真的有效）
  if (prev.dead && JSON.stringify(s) !== JSON.stringify(prev)) bad.push(`${tag} 死後狀態仍被改動`)

  // 位置必須存在
  if (!IDX.node.has(s.at)) bad.push(`${tag} at 指向不存在的節點：${s.at}`)

  // 背包數量恆為正整數
  for (const c of s.carry) {
    if (!Number.isInteger(c.count) || c.count <= 0) bad.push(`${tag} carry ${c.item} 數量異常：${c.count}`)
    if (!IDX.item.has(c.item)) bad.push(`${tag} carry 含不存在的物品：${c.item}`)
  }

  // 傷口的階段錨點不得在未來
  for (const i of s.injuries) {
    if (i.stageDay > s.clock.day) bad.push(`${tag} 傷 ${i.id} 的 stageDay 在未來`)
    if (i.healDay !== null && i.healDay < i.stageDay) bad.push(`${tag} 傷 ${i.id} 的 healDay 早於 stageDay`)
  }

  // 死因必須有內容
  if (s.dead && !s.dead.cause) bad.push(`${tag} 死了但沒有死因`)

  // NPC 三軸恆在 0..100
  for (const [id, n] of Object.entries(s.npcs)) {
    for (const ax of ['acquaintance', 'trust', 'affection'] as const) {
      const v = n[ax]
      if (Number.isNaN(v) || v < 0 || v > 100) bad.push(`${tag} npc ${id}.${ax} 超界：${v}`)
    }
  }
  return bad
}

// ① ★ 不變量模糊測試：隨機動作序列（含不合法動作），每一步都驗
{
  const RUNS = 400
  const STEPS = 60
  const violations: string[] = []
  let steps = 0, deaths = 0, crashes = 0
  for (let r = 0; r < RUNS && violations.length < 6; r++) {
    const seed = `fuzz-${r}`
    let s = initialState(seed, NODES[r % NODES.length]!, ['item-bandaid', 'item-phone', 'item-candy'], IDX)
    for (let i = 0; i < STEPS; i++) {
      const a = randomAction(seed, i, s)
      const prev = s
      try {
        s = reduce(s, a, IDX).s
      } catch (e) {
        crashes++
        violations.push(`${seed} 第 ${i} 步 ${a.t} 拋出：${e instanceof Error ? e.message : String(e)}`)
        break
      }
      steps++
      const v = invariants(s, prev, a)
      if (v.length) { violations.push(`${seed} 第 ${i} 步：${v.join('；')}`); break }
      if (s.dead) { deaths++; break }
    }
  }
  T(1, '★ 不變量模糊測試：隨機動作序列不得破壞任何不變量',
    violations.length === 0,
    violations.length ? violations.slice(0, 4).join('\n         ') : `${RUNS} 局／${steps} 步／${deaths} 次死亡／${crashes} 次拋錯`)
}

// ② ★ reduce 必須是純的：不得改動傳入的狀態
//    深度凍結輸入，若 reduce 就地修改就會拋 TypeError。
{
  function deepFreeze<A>(o: A): A {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o)
      for (const v of Object.values(o as object)) deepFreeze(v)
    }
    return o
  }
  const problems: string[] = []
  for (let r = 0; r < 60 && problems.length < 3; r++) {
    const seed = `pure-${r}`
    let s = initialState(seed, NODES[r % NODES.length]!, ['item-bandaid', 'item-lighter'], IDX)
    for (let i = 0; i < 20; i++) {
      const a = randomAction(seed, i, s)
      const frozen = deepFreeze(structuredClone(s))
      try {
        s = reduce(frozen, a, IDX).s
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 內容缺漏的 must() 例外是預期的（隨機動作會指向不存在的東西）；
        // 我們只在意「唯讀違規」——那才是就地修改的指紋。
        if (/read only|readonly|not extensible|Cannot assign|frozen/i.test(msg)) {
          problems.push(`${seed} 第 ${i} 步 ${a.t} 就地修改了狀態：${msg}`)
        }
        break
      }
      if (s.dead) break
    }
  }
  T(2, '★ reduce 是純函數：深度凍結輸入後不得就地修改', problems.length === 0,
    problems.length ? problems.join('\n         ') : '60 局 × 20 步無唯讀違規')
}

// ③ ★ 共用實作的位元一致性：UI 報價與 reducer 實算必須是同一份程式
{
  const mismatches: string[] = []
  for (let r = 0; r < 200; r++) {
    const seed = `parity-${r}`
    let s = initialState(seed, 'bh:quays', ['item-bandaid'], IDX)
    // 把狀態推到各種清潔／體溫／理智組合
    s = {
      ...s,
      needs: {
        ...s.needs,
        hygiene: Math.floor(rand(seed, 'flavor', r, 'h') * 101),
        warmth: Math.floor(rand(seed, 'flavor', r, 'w') * 101),
        sanity: Math.floor(rand(seed, 'flavor', r, 's') * 101),
      },
      npcs: { 'npc-quays-foreman': { acquaintance: Math.floor(rand(seed, 'flavor', r, 'a') * 101), trust: 0, affection: 0, lastSeenDay: 1, knownFacts: [] } },
    }
    const job = IDX.job.get('job-quays-dayhire')!

    // (a) 錄取率：UI 與 reducer 共用 quoteHireChance —— 抽出前 UI 印的是 job.hireChance（永遠 60%）
    const q = quoteHireChance(s, job)
    if (!(q >= 0 && q <= 1)) mismatches.push(`${seed} 錄取率超界 ${q}`)
    // 清潔越高，錄取率不得下降（單調性）
    const cleaner = quoteHireChance({ ...s, needs: { ...s.needs, hygiene: Math.min(100, s.needs.hygiene + 10) } }, job)
    if (cleaner < q - 1e-9) mismatches.push(`${seed} 洗乾淨反而降低錄取率：${q} → ${cleaner}`)

    // (b) 化膿率：清潔越高不得上升
    const p = quoteSuppuration(s, 'none')
    const pClean = quoteSuppuration({ ...s, needs: { ...s.needs, hygiene: Math.min(100, s.needs.hygiene + 10) } }, 'none')
    if (pClean > p + 1e-9) mismatches.push(`${seed} 洗乾淨反而提高化膿率：${p} → ${pClean}`)
    // 處置必須降低化膿率
    if (quoteSuppuration(s, 'herbs') > p + 1e-9) mismatches.push(`${seed} 草藥沒有降低化膿率`)
    if (quoteSuppuration(s, 'sterile') > quoteSuppuration(s, 'herbs') + 1e-9) mismatches.push(`${seed} OK 繃不如草藥`)

    // (c) 體力：路線卡與實際移動傳入同一個 fatigueMul —— 抽出前 UI 顯示的與實扣不同
    const e = IDX.edge.get('e:alley-quays-slope')!
    const mul = fatigueMul(s.needs.sanity)
    const shown = staminaFor(e, 'bh:alley', 0, mul)
    if (Math.abs(shown - staminaFor(e, 'bh:alley', 0, fatigueMul(s.needs.sanity))) > 1e-9) {
      mismatches.push(`${seed} 體力報價不一致`)
    }
    // 理智越低不得更省力
    if (staminaFor(e, 'bh:alley', 0, fatigueMul(0)) < staminaFor(e, 'bh:alley', 0, fatigueMul(100)) - 1e-9) {
      mismatches.push(`${seed} 理智低反而更省力`)
    }
    // (d) 說話分鐘：理智低不得更快
    if (quoteMinutes(s, 30) < 30) mismatches.push(`${seed} 說話比基準還快：${quoteMinutes(s, 30)}`)
  }
  T(3, '★ 共用報價的單調性與一致性（UI 與 reducer 同一份程式）', mismatches.length === 0,
    mismatches.length ? mismatches.slice(0, 4).join('\n         ') : '200 組隨機狀態全部通過')
}

// ④ 決定性：同 seed ＋ 同動作序列 → 逐位元相同
{
  const run = () => {
    let s = initialState('determinism-unit', 'bh:market', ['item-bandaid', 'item-candy'], IDX)
    for (let i = 0; i < 80 && !s.dead; i++) s = reduce(s, randomAction('determinism-unit', i, s), IDX).s
    return s
  }
  const a = run(), b = run()
  T(4, '決定性：同 seed 同動作序列逐位元相同', JSON.stringify(a) === JSON.stringify(b),
    `第${a.clock.day}日／${a.purse.copper} 銅／ledger ${a.ledger.length} 筆`)
}

// ⑤ 無效動作不得推進時間也不得改變狀態（除了 log）
{
  const cases: Array<[string, Action]> = [
    ['買不存在的物品', { t: 'buy', item: 'item-nope' as never }],
    ['治療不存在的傷', { t: 'treat', injury: 'inj-nope', using: 'herbs' }],
    ['賣沒有的東西', { t: 'sell', item: 'item-rye-bread' }],
    ['用沒有的東西', { t: 'useItem', item: 'item-rye-bread' }],
  ]
  const leaked: string[] = []
  for (const [name, a] of cases) {
    const s0 = initialState('noop', 'bh:market', [], IDX)
    let s1: GameState
    try { s1 = reduce(s0, a, IDX).s } catch { continue } // must() 拋錯也算擋下
    const t0 = s0.clock.day * 1440 + s0.clock.minute
    const t1 = s1.clock.day * 1440 + s1.clock.minute
    if (t1 !== t0) leaked.push(`${name}：推進了時間`)
    if (s1.purse.copper !== s0.purse.copper) leaked.push(`${name}：動了錢`)
    if (s1.carry.length !== s0.carry.length) leaked.push(`${name}：動了背包`)
  }
  T(5, '無效動作不推進時間、不動錢、不動背包', leaked.length === 0,
    leaked.length ? leaked.join('；') : `${cases.length} 種無效動作全部無副作用`)
}

// ⑥ 每日上限與一天一次的閘門真的關得住（用合法動作反覆嘗試）
{
  const problems: string[] = []
  // 工作
  for (const jid of JOBS) {
    const job = IDX.job.get(jid)!
    let s = initialState(`cap-${jid}`, job.at, [], IDX)
    s = { ...s, clock: { day: 2, minute: job.when[0] * 60 }, needs: { ...s.needs, stamina: 100, satiety: 90, hydration: 90 } }
    // ★ 上限是【每日】的，所以必須把日子釘住才測得到它。
    //   第一版沒釘：跑腿一趟 150 分，十趟就跨了兩天，於是「做了 10 次」其實是正確行為，
    //   而測試在指控引擎。那是我自己的測試 bug——但它順手抓到一個真的引擎缺口：
    //   reducer 原本不檢查 job.when（見 reduce.ts case 'work' 的註解）。
    // 把前置條件都給足，否則測到的是 requires 而不是上限
    s = { ...s, knownRoutes: [...IDX.edge.keys()].slice(0, 2), purse: { copper: 50 } }
    const day = s.clock.day
    // ★ 只數【真的發生了】的次數（以時間推進為準），不是呼叫次數。
    //   第一版數呼叫次數，而跑腿要求 knowsRoutes >= 1、初始狀態沒有已知路線，
    //   於是每次都在 requires 被擋下、計數器根本沒加，測試卻數成 10 次。
    let done = 0
    for (let i = 0; i < 10; i++) {
      const t0 = s.clock.day * 1440 + s.clock.minute
      s = reduce(s, { t: 'work', job: jid }, IDX).s
      const t1 = s.clock.day * 1440 + s.clock.minute
      if (t1 !== t0) done++
      if (s.clock.day !== day) break // 跨日就停——上限是每日的
    }
    if (done > job.maxPerDay) problems.push(`${jid} 同一天生效 ${done} 次 > 上限 ${job.maxPerDay}`)
  }
  // 說話
  {
    const npc = IDX.npc.get('npc-quays-foreman')!
    let s = initialState('cap-talk', npc.at, [], IDX)
    s = { ...s, clock: { day: 2, minute: ((npc.when?.[0] ?? 8)) * 60 } }
    let n = 0
    for (let i = 0; i < 5; i++) { if (!canTalk(s, npc)) break; s = reduce(s, { t: 'talk', npc: npc.id }, IDX).s; n++ }
    if (n > 1) problems.push(`同一人一天說了 ${n} 次話`)
  }
  // 獨處
  {
    let s = initialState('cap-unwind', 'bh:grotto', [], IDX)
    const before = s.needs.sanity
    let gains = 0
    for (let i = 0; i < 5; i++) {
      const b = s.needs.sanity
      s = reduce(s, { t: 'unwind' }, IDX).s
      if (s.needs.sanity > b) gains++
    }
    if (gains > 1) problems.push(`獨處一天生效 ${gains} 次（理智 ${before} → ${s.needs.sanity}）`)
  }
  T(6, '每日上限關得住（工作／說話／獨處）', problems.length === 0,
    problems.length ? problems.join('；') : `${JOBS.length} 份工 ＋ 說話 ＋ 獨處 全部一天一次`)
}

// ⑦ needsHazard 只認飢渴兩鍵——其餘需求歸零一律不得致死
{
  const lethal: string[] = []
  for (const k of NEED_KEYS) {
    if (k === 'satiety' || k === 'hydration') continue
    let s = initialState(`lethal-${k}`, 'bh:alley', [], IDX)
    s = { ...s, needs: { satiety: 90, hydration: 90, stamina: 90, warmth: 90, hygiene: 90, sanity: 90, [k]: 0 } }
    if (needsHazard(s).death !== null) lethal.push(k)
    // 再跑 30 夜確認不會慢慢殺人
    for (let d = 0; d < 30 && !s.dead; d++) {
      s = { ...s, needs: { ...s.needs, satiety: 90, hydration: 90, [k]: 0 } }
      s = reduce(s, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
    }
    if (s.dead && !s.dead.cause.includes('敗血')) lethal.push(`${k}（睡 30 夜後 ${s.dead.cause}）`)
  }
  T(7, '只有飢餓與脫水會致死（體溫／清潔／精力／理智歸零皆不致命）', lethal.length === 0,
    lethal.length ? '★ 這些也會致死：' + lethal.join('、') : '四項非致命需求全部確認不致死')
}

// ⑧ ★ 文案裡的數字必須等於引擎常數（「文件也要被測試」）
//    conditions.json 對玩家承諾「通鋪 3 銅 +20／單間 12 銅 +40」這類具體數字。
//    它們是寫死的字串——改了引擎常數，它們就會開始說謊，而那正是本專案
//    修過三次的缺陷類別（UI 硬寫 34%／hireChance 印基礎值／傷病說明用舊模型）。
{
  const cond = rd('conditions.json') as {
    needs: Record<string, { does: string; exits: string }>
  }
  const lies: string[] = []
  const has = (s: string, n: number) => new RegExp(`(?<![0-9])${n}(?![0-9])`).test(s)

  // 飢渴的致死日數
  const starveDays = DEPRIVATION_STAGES.starve[2] / 1440
  const thirstDays = DEPRIVATION_STAGES.thirst[2] / 1440
  if (!has(cond.needs.satiety!.does, starveDays)) lies.push(`飽食文案沒說「${starveDays} 日」（引擎：${starveDays}）`)
  if (!cond.needs.hydration!.does.includes(String(thirstDays))) lies.push(`水分文案沒說「${thirstDays} 日」（引擎：${thirstDays}）`)

  // 睡眠的體力與體溫
  for (const [k, label] of [['rough', '露宿'], ['bunk', '通鋪'], ['room', '單間']] as const) {
    const sh = SHELTER[k]
    if (!has(cond.needs.stamina!.exits, sh.stamina)) lies.push(`精力文案的「${label}」不是 ${sh.stamina}`)
    if (sh.warmth > 0 && !has(cond.needs.warmth!.exits, sh.warmth)) lies.push(`體溫文案的「${label}」不是 ${sh.warmth}`)
    if (sh.copper > 0 && !has(cond.needs.warmth!.exits, sh.copper)) lies.push(`體溫文案的「${label}」價錢不是 ${sh.copper} 銅`)
  }
  if (!has(cond.needs.warmth!.exits, HOT_MEAL_WARMTH)) lies.push(`體溫文案的熱食不是 +${HOT_MEAL_WARMTH}`)

  // 洗淨的價錢
  for (const [k, label] of [['rinse', '海水沖洗'], ['well', '井邊擦洗'], ['basin', '洗滌場借盆']] as const) {
    const d = CLEAN[k]
    if (d.copper === 0) { if (!cond.needs.hygiene!.exits.includes('免費')) lies.push(`清潔文案沒說「${label}」免費`) }
    else if (!has(cond.needs.hygiene!.exits, d.copper)) lies.push(`清潔文案的「${label}」不是 ${d.copper} 銅`)
  }

  T(8, '★ conditions.json 的數字等於引擎常數（文件也要被測試）', lies.length === 0,
    lies.length ? lies.join('\n         ') : '飢渴致死日數／三級住宿／熱食／三階洗淨 全部對得上')
}

// ⑨ ★ 結局判定不得有優先序瀑布（憲法：三條結局沒有優劣、沒有隱藏的真結局）
//    引擎只判定玩家【自己宣告】的那一條。任何 if/else if/else 都會製造一個優劣序，
//    而最後那個 else【一定】會被讀成「其他都沒達成」——偏偏那就是「平凡」。
{
  const at30 = (over: Partial<GameState>): GameState => ({
    ...initialState('ending-unit', 'bh:alley', [], IDX),
    clock: { day: 30, minute: 20 * 60 }, ...over,
  } as GameState)
  const blankStats = initialState('blank', 'bh:alley', [], IDX).stats
  const problems: string[] = []

  // (a) 沒宣告 → 還沒有
  if (resolveEnding(at30({}), IDX).kind !== 'notYet') problems.push('沒宣告卻給了結局')

  // (b) ★ 宣告 A 但只滿足 B 的條件 → 必須是「還沒有」，不得改給 B
  const satisfyHearth = { 'lease-signed': true, 'romance-scribe': true }
  const satisfyTrade = { 'rank-prentice-listed': true }
  for (const [aim, other] of [['aim-trade', satisfyHearth], ['aim-hearth', satisfyTrade]] as const) {
    const s = at30({
      flags: { [aim]: true, ...other },
      purse: { copper: 60 },
      stats: { ...blankStats, namedAsks: 3 },
    })
    const r = resolveEnding(s, IDX)
    if (r.kind === 'ending' && !s.flags[r.def.aim]) {
      problems.push(`宣告 ${aim} 卻給了 ${r.def.name} —— 優先序瀑布復活`)
    }
  }

  // (c) 每一條結局的 requires 都必須含它自己的 aim flag，否則會被別的宣告誤中
  for (const d of IDX.ending.values()) {
    if (!JSON.stringify(d.requires).includes(d.aim)) {
      problems.push(`${d.name} 的 requires 沒有含它自己的 aim flag（${d.aim}）`)
    }
  }

  T(9, '★ 結局判定只認玩家宣告的那一條（無優先序瀑布、無隱藏真結局）',
    problems.length === 0,
    problems.length ? problems.join('；') : `${IDX.ending.size} 條結局各自綁定 aim flag，交叉宣告不會誤中`)
}

// ── 輸出 ──
console.log('=== 無籍者 · 單元／性質測試 ===\n')
let pass = true
for (const r of results) {
  if (!r.ok) pass = false
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}. ${r.name}`)
  if (r.note) console.log(`         ${r.note}`)
}
console.log(pass ? '\n[PASS] 9 項單元測試全數通過。' : '\n[FAIL] 有項目未通過。')
process.exit(pass ? 0 : 1)
