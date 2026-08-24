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
import { LAST_DAY, NEED_KEYS } from '../src/engine/clock.ts'
import { DEPRIVATION_STAGES, quoteSuppuration, needsHazard } from '../src/engine/body.ts'
import { staminaFor } from '../src/engine/map.ts'
import {
  CLEAN, FADE_GRACE_DAYS, FADE_PER_DAY, HOT_MEAL_WARMTH, SHELTER, fadeRelations, fatigueMul,
} from '../src/engine/mind.ts'
import {
  attemptKey, attemptsLeft, canTalk, initialState, quoteHireChance, quoteMinutes, reduce,
  workBlock, type Action,
} from '../src/engine/reduce.ts'
import { rand } from '../src/engine/rng.ts'
import { eventText } from '../src/engine/events.ts'
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

/**
 * ⑩ ★★ reducer 必須守住【自己的】地理前置條件，不能靠介面擋。
 *
 * 這是本專案第三次踩到同一個形狀：
 *   · case 'work' 不檢查 job.when —— 時段限制只存在於 App.tsx，
 *     reducer 會接受凌晨三點上工
 *   · treat/herbs 不管站在哪裡都用 1 銅買到藥膏 —— 而那味藥只在市集賣，
 *     順帶讓 8 銅的私煉灰膏變成永遠不會有人買的死物品
 *   · case 'buy' 不檢查 here.sells、case 'sell' 不檢查 here.buys ——
 *     node.buys 這份資料一直都在，而【只有介面在讀它】
 *
 * 介面擋得住玩家，擋不住跑分腳本、存讀檔重播、與未來的任何新介面。
 * 所以這一項不驗「介面有沒有藏按鈕」，它直接對 reducer 下不該成立的 action。
 */
{
  const problems: string[] = []
  const rich = (at: string) => ({
    ...initialState('geo', at as never, [], IDX),
    purse: { copper: 500 },
    carry: [{ item: 'item-keys' as never, count: 1 }],
  })
  // 買：蒸發池什麼都不賣（canon：城外的鹽田，沒有攤子）
  {
    const before = rich('bh:pans')
    const after = reduce(before, { t: 'buy', item: 'item-rye-bread' as never }, IDX).s
    if (after.purse.copper !== before.purse.copper) {
      problems.push('在不賣麵包的蒸發池竟然買到了麵包（reducer 沒守 here.sells）')
    }
  }
  // 買：市集有賣麵包 —— 這一格必須成立，否則是誤擋
  {
    const before = rich('bh:market')
    const after = reduce(before, { t: 'buy', item: 'item-rye-bread' as never }, IDX).s
    if (after.purse.copper >= before.purse.copper) problems.push('市集有賣麵包卻買不到（誤擋）')
  }
  // 賣：蒸發池不收鑰匙鋼
  {
    const before = rich('bh:pans')
    const after = reduce(before, { t: 'sell', item: 'item-keys' as never }, IDX).s
    if (after.purse.copper !== before.purse.copper) {
      problems.push('在池壁邊把現代硬化鋼賣掉了（reducer 沒守 here.buys）')
    }
  }
  // 賣：石窟街收鑰匙鋼 —— 必須成立
  {
    const before = rich('bh:grotto')
    const after = reduce(before, { t: 'sell', item: 'item-keys' as never }, IDX).s
    if (after.purse.copper <= before.purse.copper) problems.push('石窟街收鑰匙卻賣不掉（誤擋）')
  }
  T(10, '★ reducer 自己守住買賣的地理前置（不靠介面擋）',
    problems.length === 0,
    problems.length ? problems.join('；') : '不賣的地方買不到、不收的地方賣不掉，而該成交的地方照樣成交')
}

/**
 * ⑪ ★★★ 遊戲【親口告訴玩家】的結局條件，必須與程式實際判定的一致。
 *
 * 這一項的來由是一個真的踩到的缺陷，而且是最傷的一種：
 *
 *   第五章開場 ev-ch5-aim 讓玩家宣告目標，並在 resultText 裡逐條列出
 *   那條結局要什麼。而我在另一輪把「平凡」的條件從
 *   「三個人認得她」改成「四個人 ＋ 至少一個在不發工錢的地方」時，
 *   只更新了「還沒有」畫面上的 asks，【沒有更新宣告當下那段話】。
 *
 *   結果：遊戲告訴玩家要三個人（實際四個）、要冊子上有名字（沒這條）、
 *   要給出去三次（沒這條，而且我明確決定過不拿它當門票），
 *   而真正決定成敗的 npcOffWage 一個字都沒提。
 *
 *   ★ 照遊戲自己講的條件去玩，會準確地撞上「還沒有」。
 *     那比一個藏起來的條件更傷——它是遊戲主動給了錯的指示。
 *
 * ★★ 方向很重要，而我第一版寫反了。
 *
 *   寫反的版本：「文本裡提到的每一個數字，都必須是一個門檻」。
 *   那會被敘事數字誤觸——安家那段講「老鹽街的單間，一輪六十銅……所以是一百二十」，
 *   而 120 不是任何一條 requires 的數字，它只是一句話。第一版因此吐出八個假警報。
 *
 *   正確的方向：「requires 裡的每一個【玩家該知道的門檻】，都必須在文本裡被講出來」。
 *     · 不會被敘事數字誤觸（它不管文本多講了什麼）
 *     · 而且正好抓到這次的缺陷：atLeast 從 3 改成 4，而文本還寫著「三個人」，
 *       於是「4」在文本裡找不到 → 紅
 *
 * ★ 只查【玩家該知道的】那幾個謂詞（人數、上工日數、被指名次數）。
 *   day: '>=28' 不查——那是截止日，敘事上講的是「第三十日」而不是 28。
 *   flag 也不查——旗標的名字不是給玩家看的東西。
 *   （比照單元測試 ⑧ 對 conditions.json 的做法：文件也要被測試。）
 *
 * ★★ 誠實的界線：它是一道 lint，不是證明。
 *   它只確認那個數字【出現在文本某處】，不確認它接在正確的那句話上——
 *   散文與條件的一致性沒辦法全自動驗證。
 *   但它抓得到真正的失敗模式：【改了條件而忘了改文本】，
 *   因為那時那個數字會從文本裡完全消失。這次的缺陷正是這個形狀。
 */
{
  const problems: string[] = []
  const aim = IDX.event.get('ev-ch5-aim')
  if (!aim) {
    problems.push('找不到 ev-ch5-aim —— 三條結局的唯一宣告入口不見了')
  } else {
    /** 阿拉伯數字 → 中文寫法（宣告文本用「四個人」「十八天」這種寫法） */
    const cn = (n: number): string[] => {
      const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
      if (n < 10) return [d[n]!, ...(n === 2 ? ['兩'] : [])]
      if (n < 20) return [n === 10 ? '十' : `十${d[n - 10]}`]
      if (n % 10 === 0) return [`${d[Math.floor(n / 10)]}十`]
      return [`${d[Math.floor(n / 10)]}十${d[n % 10]}`]
    }
    /**
     * 玩家該知道的門檻。
     * ★ 刻意只有這三個：人數、上工日數、被指名次數——
     *   它們是玩家可以【主動去湊】的數字，所以遊戲有義務講清楚。
     */
    const thresholds = (c: unknown, out: Array<{ what: string; n: number }> = []) => {
      if (!c || typeof c !== 'object') return out
      const o = c as Record<string, unknown>
      const cmpNum = (v: unknown) => {
        const m = /(\d+)/.exec(String(v ?? ''))
        return m ? Number(m[1]) : null
      }
      const npcCount = o.npcCount as { atLeast?: number } | undefined
      const npcOffWage = o.npcOffWage as { atLeast?: number } | undefined
      if (npcCount?.atLeast !== undefined) out.push({ what: '認得她的人數', n: npcCount.atLeast })
      if (npcOffWage?.atLeast !== undefined) out.push({ what: '在不發工錢的地方認得她的人數', n: npcOffWage.atLeast })
      if (o.wageDays !== undefined) { const n = cmpNum(o.wageDays); if (n !== null) out.push({ what: '上工日數', n }) }
      if (o.namedAsks !== undefined) { const n = cmpNum(o.namedAsks); if (n !== null) out.push({ what: '被指名次數', n }) }
      for (const k of ['all', 'any'] as const) {
        if (Array.isArray(o[k])) for (const sub of o[k] as unknown[]) thresholds(sub, out)
      }
      if (o.not) thresholds(o.not, out)
      return out
    }
    for (const ch of aim.choices) {
      const flags = [ch.gain?.flag ?? []].flat() as string[]
      const aimFlag = flags.find((f) => f.startsWith('aim-'))
      if (!aimFlag) { problems.push(`ev-ch5-aim 的選項「${ch.label}」沒有設任何 aim-* 旗標`); continue }
      const def = [...IDX.ending.values()].find((e) => e.aim === aimFlag)
      if (!def) { problems.push(`宣告了 ${aimFlag} 卻沒有對應的結局`); continue }
      const text = ch.resultText ?? ''
      /**
       * ★ 同一種門檻只查【最低的那一個】。
       *   立業的替代分支要 namedAsks >= 3，而主路徑只要 >= 2——
       *   玩家該知道的是可行動的那個目標（2），
       *   替代分支的較高門檻不需要預先規劃，寫進宣告文只會讓那段話變成規則表。
       */
      const minBy = new Map<string, number>()
      for (const { what, n } of thresholds(def.requires)) {
        const cur = minBy.get(what)
        if (cur === undefined || n < cur) minBy.set(what, n)
      }
      for (const [what, n] of minBy) {
        const forms = [String(n), ...cn(n)]
        if (forms.some((f) => text.includes(f))) continue
        problems.push(`${def.id} 要求「${what} ${n}」，但宣告「${ch.label}」時的文本`
          + `【沒有把這個數字告訴玩家】（找過 ${forms.join('／')}）`
          + ` —— 照遊戲講的去玩會撞上「還沒有」`)
      }
    }
  }
  T(11, '★★ 遊戲親口講的結局條件，數字必須對得上程式實際判定的',
    problems.length === 0,
    problems.length ? problems.join('；')
      : '三條結局的每一個玩家該知道的門檻，宣告當下都真的講了出來')
}

/**
 * ⑫ ★★ 寫了幾則變體，玩家就要抽得到幾則。
 *
 * 這是一道【反向驗證器】，與既有三道同一家族：
 * 既有的檢查都在問「這個引用指得到東西嗎」（抓拼錯），
 * 反向的在問「這個東西有沒有人用得到」（抓白寫）。
 *
 * 為什麼非要有這一道：`eventText` 用 `floor(rand(...) * pool.length)` 選則。
 * 只要有人把選則邏輯改成取模、或改用只有兩三種取值的 salt，
 * 尾巴那幾則就會【永遠抽不到】——而畫面上一切正常，
 * 沒有任何既有的閘會變紅，我也永遠不會知道自己白寫了那幾百個字。
 *
 * 順帶檢查兩件同樣不會自己現形的事：
 *   · 池子裡不得有兩則一模一樣（複製貼上寫壞了，玩家照樣讀到重複）
 *   · 同一個時空必須永遠得到同一則（若哪天被搬進 UI 抽數，
 *     玩家縮放視窗或存檔重讀，文字會自己變——那是看不見卻很傷的 bug）
 *
 * ★ 公平性不在這一道的守備範圍，因為結構上不可能破：
 *   `tell`（致命警告）是獨立欄位、獨立渲染，變體換的只有 text，吃不掉警告。
 */
function testVariantsReachable() {
  const problems: string[] = []
  const withVar = [...IDX.event.values()].filter((e) => e.variants && e.variants.length > 0)

  for (const ev of withVar) {
    const pool = [ev.text, ...(ev.variants ?? [])]

    // (a) 池子裡不得有重複
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (pool[i] === pool[j]) {
          problems.push(`${ev.id} 的第 ${i} 則與第 ${j} 則一字不差 —— 玩家照樣會讀到重複`)
        }
      }
    }

    // (b) 每一則都要抽得到。掃真實的 (seed, 日, 分, 地點) 空間，不是抽樣猜。
    const wheres = NODES
    const hit = new Set<number>()
    for (const seed of ['v-1', 'v-2', 'v-3']) {
      for (let day = 1; day <= LAST_DAY; day++) {
        for (let minute = 0; minute < 1440; minute += 10) {
          for (const at of wheres) {
            const s = { meta: { seed }, clock: { day, minute }, at } as unknown as GameState
            hit.add(pool.indexOf(eventText(ev, s)))
          }
        }
      }
    }
    for (let i = 0; i < pool.length; i++) {
      if (!hit.has(i)) {
        problems.push(`${ev.id} 的第 ${i} 則【任何時空都抽不到】`
          + ` —— 那幾百個字是白寫的，而畫面上看不出來`)
      }
    }

    // (d) ★ 同一天、同一個地點之內也必須會變。
    //
    // 這一條與 (b) 問的是【相反的問題】，所以量尺也必須不同：
    //   (b) 問「這一則在整個時空裡有沒有人抽得到」→ 要掃【最寬】的空間
    //   (d) 問「同一天回到同一口井，讀到的會不會一樣」→ 只能掃【一天之內】
    // 用 (b) 的寬空間去回答 (d) 會永遠是綠的：把 salt 裡的 minute 整個拿掉，
    // 每一則照樣抽得到（跨 30 天足夠打散），但玩家同一天排三次隊會讀到三次同一段字——
    // 而那正是這一輪要修掉的東西。這個偽綠燈是自測注入實際撞出來的，不是假想。
    {
      const want = Math.min(pool.length, 3)
      for (const [seed, day, at] of [['v-1', 3, 'bh:market'], ['v-2', 17, 'bh:quays']] as const) {
        const inDay = new Set<string>()
        for (let minute = 0; minute < 1440; minute += 30) {
          inDay.add(eventText(ev, { meta: { seed }, clock: { day, minute }, at } as unknown as GameState))
        }
        if (inDay.size < want) {
          problems.push(`${ev.id} 在同一天（seed=${seed} 第 ${day} 日 ${at}）只變得出 ${inDay.size} 種`
            + `，至少要有 ${want} 種 —— 同一天回到同一個地方會讀到一字不差的重複`)
        }
      }
    }

    // (c) 同一個時空必須永遠是同一則
    const s0 = { meta: { seed: 'v-1' }, clock: { day: 7, minute: 540 }, at: 'bh:market' } as unknown as GameState
    if (eventText(ev, s0) !== eventText(ev, s0)) {
      problems.push(`${ev.id} 的 eventText 不是純函數 —— 同一時空兩次呼叫給出不同文字`)
    }
  }

  T(12, '★★ 每一則敘事變體都真的抽得到（寫了就要有人讀到）',
    problems.length === 0,
    problems.length ? problems.join('；')
      : `${withVar.length} 幕共 ${withVar.reduce((a, e) => a + (e.variants?.length ?? 0), 0)} 則變體`
        + `，每一則在真實時空裡都抽得到；同一天同一地點至少變得出三種；無重複；抽選為純函數`)
}
testVariantsReachable()

/**
 * ⑬ ★★★ reducer 接受一份工，若且唯若 workBlock 說沒擋。
 *
 * 這一項守的是【一個判斷只能有一份實作】，而它的由來是一個真的踩到的缺陷：
 *
 *   「這份工現在做得了嗎」原本有三份答案。reducer 一份、App.tsx 一份、
 *   跑分腳本用 `attemptsLeft(s, j) > 0` 當第三種近似——而 attemptsLeft
 *   只數今天試了幾次，不看 job.requires。
 *
 *   於是跑分政策會挑上 job-cinder-drill（要旗標 ladder-prentice-in），
 *   reducer 拒絕且【不花時間】，政策下一步再挑同一份，無窮迴圈。
 *   balance.ts 的 step() 有防死鎖會補 wait 30，所以它不會當掉，
 *   只會靜默地把時間燒掉——一局實際只跑到第 2 日，而沒有任何一道閘看得見。
 *
 *   而玩家看得見的那一半：介面在 requires 擋住時顯示「現在不行（6:00–19:00）」，
 *   一句在早上十點明顯為假的話。
 *
 * 所以這裡不測「某個情境下應該拒絕」——那只會證明每條路徑符合它自己的預期。
 * 測的是【兩條路徑的位元一致性】：對隨機狀態，reducer 的實際行為
 * 必須與 workBlock 的宣告完全同號。
 */
function testWorkBlockAgreement() {
  const problems: string[] = []
  const jobs = [...IDX.job.values()]
  let checked = 0
  for (let i = 0; i < 4000 && problems.length < 5; i++) {
    const job = jobs[i % jobs.length]!
    const seed = `wb-${i}`
    const at = job.at
    let s: GameState = initialState(seed, at, ['item-bandaid'], IDX)
    // 隨機時空與狀態：時段、旗標、疲勞、當日已試次數，四個軸都要掃到
    const hour = Math.floor(rand(seed, 'flavor', 'h') * 24)
    const day = 1 + Math.floor(rand(seed, 'flavor', 'd') * LAST_DAY)
    const flags: Record<string, boolean> = {}
    if (rand(seed, 'flavor', 'f') < 0.5) flags['ladder-prentice-in'] = true
    const used = rand(seed, 'flavor', 'u') < 0.35 ? job.maxPerDay : 0
    s = {
      ...s, at, clock: { day, minute: hour * 60 }, flags,
      npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id, {
        acquaintance: rand(seed, 'flavor', 'a', id) * 100, trust: 50, affection: 50,
        lastSeenDay: null, knownFacts: [],
      }])),
      stats: { ...s.stats, jobAttempts: { [attemptKey(day, job.id)]: used } },
    }
    const declared = workBlock(s, job, IDX) === null
    const before = s.stats.jobAttempts[attemptKey(day, job.id)] ?? 0
    const after = reduce(s, { t: 'work', job: job.id }, IDX).s
    const actual = (after.stats.jobAttempts[attemptKey(day, job.id)] ?? 0) > before
    checked++
    if (declared !== actual) {
      problems.push(`${job.id} 在第 ${day} 日 ${hour}:00：`
        + `workBlock 說「${declared ? '可以' : '擋住'}」，而 reducer 實際「${actual ? '受理了' : '拒絕了'}」`
        + ` —— 兩條路徑分歧，而分歧的那一半沒有人在看`)
    }
  }
  /**
   * ★★ 第二半：這一份共用實作【自己】對不對。
   *
   * 上半段問的是「兩條路徑一不一致」，而那需要一個共同參照——
   * 於是它拿 workBlock 當標準答案。統一之後這變成一個自我指涉的問題：
   * workBlock 少看一條，reducer 也跟著少看一條，兩邊照樣完全一致。
   * （這是閘門自測注入時實際撞出來的：反方向的注入【沒有被擋下】。）
   *
   * 所以第二半必須用【另一把尺】：完全不提 workBlock，
   * 只用資料（job.when、job.requires）與可觀察量（時間有沒有走）來陳述。
   * 兩個相反的問題各用一把能回答它的尺——本專案第五次套用這條規矩。
   */
  const advanced = (s0: GameState, jid: string) => {
    const t0 = s0.clock.day * 1440 + s0.clock.minute
    const s1 = reduce(s0, { t: 'work', job: jid }, IDX).s
    return s1.clock.day * 1440 + s1.clock.minute !== t0
  }
  for (const job of jobs) {
    const base: GameState = {
      ...initialState(`win-${job.id}`, job.at, [], IDX),
      clock: { day: 5, minute: 0 },
      flags: { 'ladder-prentice-in': true },
      knownRoutes: [...IDX.edge.keys()],
      purse: { copper: 50 },
      npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id,
        { acquaintance: 100, trust: 100, affection: 100, lastSeenDay: null, knownFacts: [] }])),
    }
    // (a) 時段之外一律不得受理 —— 掃過全部 24 個整點
    for (let h = 0; h < 24; h++) {
      const inside = h >= job.when[0] && h < job.when[1]
      if (inside) continue
      const s0 = { ...base, clock: { day: 5, minute: h * 60 } }
      if (advanced(s0, job.id)) {
        problems.push(`${job.id} 的時段是 ${job.when[0]}:00–${job.when[1]}:00，`
          + `而 reducer 在 ${h}:00 受理了 —— 時段守衛不見了`)
      }
    }
    /**
     * (b) requires 不成立時一律不得受理。
     *
     * ★ 只挑條件裡真的有【旗標】或【關係門檻】的工作，並依那個門檻構造狀態——
     *   這樣「條件為假」是從資料的形狀直接讀出來的，不必去問求值器，
     *   於是這一半不會繞回 workBlock。
     *   （第一版對每一份工都清空 flags 就斷言，結果誤告三份：
     *   碼頭／鹽池／跑腿的條件是體力與已知路線，清 flags 根本不影響它們。）
     */
    const gates = { flags: [] as string[], npcAxes: false }
    const scan = (c: unknown) => {
      if (!c || typeof c !== 'object') return
      const o = c as Record<string, unknown>
      if (typeof o.flag === 'string') gates.flags.push(o.flag)
      if (o.npc) gates.npcAxes = true
      for (const k of ['all', 'any']) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(scan)
      if (o.not) scan(o.not)
    }
    scan(job.requires)
    if (gates.flags.length > 0 || gates.npcAxes) {
      for (let h = job.when[0]; h < job.when[1]; h++) {
        const s0: GameState = { ...base, clock: { day: 5, minute: h * 60 }, flags: {},
          npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id,
            { acquaintance: 0, trust: 0, affection: 0, lastSeenDay: null, knownFacts: [] }])) }
        if (advanced(s0, job.id)) {
          problems.push(`${job.id} 要的是`
            + `${gates.flags.length ? `旗標 ${gates.flags.join('／')}` : ''}`
            + `${gates.flags.length && gates.npcAxes ? '與' : ''}`
            + `${gates.npcAxes ? '有人認得她' : ''}`
            + `，而兩者都不成立時 reducer 在 ${h}:00 仍受理了 —— requires 守衛不見了`)
          break
        }
      }
    }
  }

  T(13, '★★★ reducer 接受一份工，若且唯若 workBlock 說沒擋；而那份判斷本身也對',
    problems.length === 0,
    problems.length ? problems.join('；')
      : `${checked} 組隨機時空×狀態兩條路徑完全同號；`
        + `另以資料獨立驗證 ${jobs.length} 份工的時段與 requires 守衛都還在`)
}
testWorkBlockAgreement()

/**
 * ⑭ ★★ 久不見的關係衰減：只退現在式、退得完、而且退得回來。
 *
 * design/01_architecture.md §8 從第一天就寫著「lastSeenDay —— 久不見會衰減」，
 * 而那件事【從來沒有實作過】：那個欄位被寫入三處，唯一讀取端是孤立感。
 * 這一項是它上線之後的驗收，守三條它不可以違反的界線：
 *
 *   (a) acquaintance 一點都不能動 —— 三軸的定義寫在 types.ts／cond.ts 裡，
 *       acquaintance 是「他認得你的臉」。認得一張臉不會在一個月內失效。
 *       （而「平凡」整條結局都掛在 acquaintance 上，動它等於偷偷改結局門檻。）
 *   (b) 退得完但不會變成負的，也不會退過寬限期之前的量。
 *   (c) ★ 退得回來 —— 06_lifelong.md 禁忌 8【禁止單向崩壞】。
 *       見一次面就把 lastSeenDay 推回今天，衰減必須立刻停止。
 *
 * ★ 這一項是被一次【我自己的量測錯誤】逼出來的：第一次驗收時我數
 *   `ledger.kind === '關係'`，而 kind 只有 'action' | 'body'，「關係」是
 *   放在 action 欄位。於是我量到「150 局裡 0 局發生衰減」，差一點就把
 *   一個正常運作的機制當成沒接上而去改它。純函式的直接斷言不會有這種事。
 */
function testRelationFade() {
  const problems: string[] = []
  const mk = (lastSeenDay: number | null, trust = 40, affection = 20, acq = 55) => ({
    clock: { day: 20, minute: 0 },
    npcs: { x: { acquaintance: acq, trust, affection, lastSeenDay, knownFacts: [] } },
  } as unknown as GameState)

  // (a) 寬限期之內一律不動
  for (let away = 0; away <= FADE_GRACE_DAYS; away++) {
    if (fadeRelations(mk(20 - away)).length > 0) {
      problems.push(`才 ${away} 天沒見就開始退（寬限期是 ${FADE_GRACE_DAYS} 天）`)
    }
  }
  // 寬限期一過就要開始退，而且第一天要標 startedFading（ledger 只報這一次）
  const first = fadeRelations(mk(20 - (FADE_GRACE_DAYS + 1)))
  if (first.length !== 1 || !first[0]!.startedFading) {
    problems.push(`第 ${FADE_GRACE_DAYS + 1} 天沒見時應該開始退並標記 startedFading`)
  }
  if (fadeRelations(mk(20 - (FADE_GRACE_DAYS + 2)))[0]?.startedFading) {
    problems.push('startedFading 應該只在寬限期剛過的那一天為真（否則 ledger 每天洗版）')
  }

  // (b) 一天最多退 FADE_PER_DAY，且退不成負的
  const big = fadeRelations(mk(1, 100, 100))[0]!
  if (big.trust > FADE_PER_DAY || big.affection > FADE_PER_DAY) {
    problems.push(`一天退超過 ${FADE_PER_DAY}（trust ${big.trust}／affection ${big.affection}）`)
  }
  const empty = fadeRelations(mk(1, 0, 0))
  if (empty.length > 0) problems.push('已經是 0 還在退 —— 會退成負數')
  const tiny = fadeRelations(mk(1, 0.3, 0))[0]!
  if (tiny.trust > 0.3) problems.push('退的量超過剩下的量 —— 會退成負數')

  // (a) acquaintance 絕對不動：跑一整局，比對「只靠說話與事件」推得動的軸
  {
    let s = initialState('fade-inv', 'bh:alley', [], IDX)
    s = {
      ...s, clock: { day: 1, minute: 8 * 60 },
      npcs: { 'npc-alley-neighbour': {
        acquaintance: 62, trust: 55, affection: 30, lastSeenDay: 1, knownFacts: [],
      } },
    } as GameState
    /**
     * 什麼都不做，只讓時間走 20 天。
     * ★ 每小時把需求撐回去 —— 這一項測的是【關係】不是存活。
     *   第一版沒撐，她在第 3–4 日就渴死，`!s.dead` 提前跳出，
     *   於是測試回報「衰減根本沒接上」而其實是它自己沒走到那一天。
     */
    for (let i = 0; i < 20 * 24 && !s.dead; i++) {
      s = { ...s, needs: { ...s.needs, satiety: 90, hydration: 90, stamina: 90, warmth: 90 },
        deprivation: { thirstMinutes: 0, starveMinutes: 0, coldMinutes: 0 } } as GameState
      s = reduce(s, { t: 'wait', minutes: 60 }, IDX).s
    }
    const st = s.npcs['npc-alley-neighbour']
    if (st && Math.abs(st.acquaintance - 62) > 0.001) {
      problems.push(`放著不管 20 天之後 acquaintance 從 62 變成 ${st.acquaintance.toFixed(1)}`
        + ' —— 那是「他認得你的臉」，不該退，而且「平凡」整條結局都掛在它上面')
    }
    if (st && st.trust >= 55) {
      problems.push(`放著不管 20 天，trust 卻沒有退（${st.trust.toFixed(1)}）—— 衰減根本沒接上`)
    }
    if (st && (st.trust < 0 || st.affection < 0)) {
      problems.push(`退成負數：trust ${st.trust}／affection ${st.affection}`)
    }
  }

  // (c) 退得回來：見一次面就停（禁忌 8 禁止單向崩壞）
  {
    let s = initialState('fade-back', 'bh:alley', [], IDX)
    s = {
      ...s, clock: { day: 12, minute: 9 * 60 },
      npcs: { 'npc-alley-neighbour': {
        acquaintance: 40, trust: 30, affection: 10, lastSeenDay: 1, knownFacts: [],
      } },
    } as GameState
    const before = s.npcs['npc-alley-neighbour']!.trust
    s = reduce(s, { t: 'talk', npc: 'npc-alley-neighbour' }, IDX).s
    const afterTalk = s.npcs['npc-alley-neighbour']!.trust
    if (afterTalk <= before) problems.push('見了面信任卻沒有回升 —— 衰減不可逆的話就是單向崩壞')
    // 見面之後接著過三天（仍在寬限內），不該再退
    const t0 = s.npcs['npc-alley-neighbour']!.trust
    for (let i = 0; i < 3 * 24 && !s.dead; i++) {
      s = { ...s, needs: { ...s.needs, satiety: 90, hydration: 90, stamina: 90, warmth: 90 },
        deprivation: { thirstMinutes: 0, starveMinutes: 0, coldMinutes: 0 } } as GameState
      s = reduce(s, { t: 'wait', minutes: 60 }, IDX).s
    }
    if (s.npcs['npc-alley-neighbour']!.trust < t0 - 0.001) {
      problems.push('見過面之後的寬限期內仍然在退 —— lastSeenDay 沒有被推回今天')
    }
  }

  T(14, '★★ 久不見的關係衰減：只退現在式、退不成負數、而且見一面就停',
    problems.length === 0,
    problems.length ? problems.join('；')
      : `寬限 ${FADE_GRACE_DAYS} 日、每日 −${FADE_PER_DAY}；`
        + 'acquaintance 放著 20 天分毫未動，trust／affection 退得完退不成負數，見一次面即止')
}
testRelationFade()

// ── 輸出 ──
console.log('=== 無籍者 · 單元／性質測試 ===\n')
let pass = true
for (const r of results) {
  if (!r.ok) pass = false
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}. ${r.name}`)
  if (r.note) console.log(`         ${r.note}`)
}
// ★ 項數由 results.length 導出，不寫死（smoke.ts 曾經寫死「30 項」而實際已是 33）
console.log(pass ? `\n[PASS] ${results.length} 項單元測試全數通過。` : '\n[FAIL] 有項目未通過。')
process.exit(pass ? 0 : 1)
