/**
 * 純 reducer：(state, action) => state'
 *
 * 紀律 1：不 import 任何 UI 套件。
 * 紀律 5：每個 action 都寫 ledger —— 不做死亡回溯畫面可以，不記帳不行。
 *         ledger 不是除錯工具，是遊戲功能（支柱三：每次死亡都要能回溯到一個決定）。
 * 紀律 7：所有條件經 evaluate；本檔無 inline 條件判斷。
 */

import { advanceTime, tideAt, tideTurnedDuring, NEED_KEYS } from './clock.ts'
import {
  CLEAN, canUnwind, cleanBlocked, fatigueMul, settleDay,
  HOT_MEAL_WARMTH, SHELTER, UNWIND_GAIN, UNWIND_MINUTES, UNWIND_STAMINA, type CleanKind,
} from './mind.ts'
import { evaluate, type Ctx } from './cond.ts'
import {
  deprive, isIncapacitated, needsHazard, newInjury, progressInjuries,
  quoteSuppuration, stageOf, type Treatment,
} from './body.ts'
import { riskFor, staminaFor } from './map.ts'
import { roll } from './rng.ts'
import { SAVE_VERSION } from './save.ts'
import { must, type EdgeId, type GameState, type Index, type ItemId, type JobId, type NeedKey, type NodeId, type NpcDef, type NpcId } from './types.ts'

export type Action =
  | { t: 'travel'; route: EdgeId[]; alternatives: string[] }
  | { t: 'work'; job: JobId }
  | { t: 'useItem'; item: ItemId }
  | { t: 'buy'; item: ItemId }
  | { t: 'sell'; item: ItemId }
  | { t: 'treat'; injury: string; using: Treatment }
  | { t: 'sleep'; kind: 'rough' | 'bunk' | 'room'; costCopper: number }
  | { t: 'wait'; minutes: number }
  | { t: 'talk'; npc: NpcId }
  | { t: 'clean'; kind: CleanKind }
  | { t: 'unwind' }
  | { t: 'eventChoice'; event: string; choice: number; alternatives: string[] }

export interface StepResult {
  s: GameState
  log: string[]
}

const clamp = (v: number) => Math.max(0, Math.min(100, v))

export function ctxOf(s: GameState, idx: Index, onEdge?: EdgeId, justTurned?: ReturnType<typeof tideAt>): Ctx {
  return { s, idx, onEdge, tide: tideAt(s.clock.minute), tideJustTurned: justTurned }
}

function countItem(s: GameState, item: ItemId): number {
  let n = 0
  for (const st of s.carry) if (st.item === item) n += st.count
  return n
}

function addItem(s: GameState, item: ItemId, n = 1): GameState['carry'] {
  const carry = s.carry.map((x) => ({ ...x }))
  const hit = carry.find((x) => x.item === item)
  if (hit) hit.count += n
  else carry.push({ item, count: n })
  return carry
}

function removeItem(s: GameState, item: ItemId, n = 1): GameState['carry'] {
  const carry = s.carry.map((x) => ({ ...x }))
  const i = carry.findIndex((x) => x.item === item)
  if (i < 0) return carry
  const hit = carry[i]!
  hit.count -= n
  if (hit.count <= 0) carry.splice(i, 1)
  return carry
}

function ledger(
  s: GameState,
  before: GameState,
  action: string,
  detail: string,
  alternatives: string[],
  kind: 'action' | 'body' = 'action'
): GameState['ledger'] {
  return [
    ...s.ledger,
    {
      kind,
      day: before.clock.day,
      minute: before.clock.minute,
      at: before.at,
      action,
      detail,
      copperBefore: before.purse.copper,
      copperAfter: s.purse.copper,
      needsAfter: { ...s.needs },
      alternatives,
    },
  ]
}

/** 當日工作嘗試計數的鍵。日界一過自然歸零——不需要任何「跨日重設」邏輯。 */
export function attemptKey(day: number, jobId: string): string {
  return `${day}|${jobId}`
}

/** 這份工今天還剩幾次可以【嘗試】（含落選）。UI 用它決定按鈕能不能按。 */
export function attemptsLeft(s: GameState, job: { id: string; maxPerDay: number }): number {
  return job.maxPerDay - (s.stats.jobAttempts[attemptKey(s.clock.day, job.id)] ?? 0)
}

/**
 * 此刻能不能找這個人說話。
 * 條件：他在這裡、在他出現的時段內、而且今天還沒找過他。
 *
 * ★ 一天一次是刻意的。可無限重複的對話會退化成刷好感，
 *   而「刷」正是本作在反對的東西（`00_pillars.md` 反 DoL 條款一：不做無代價的重複點擊）。
 */
export function canTalk(s: GameState, npc: NpcDef): boolean {
  if (npc.at !== s.at) return false
  const h = s.clock.minute / 60
  if (npc.when && !(h >= npc.when[0] && h < npc.when[1])) return false
  return (s.stats.jobAttempts[attemptKey(s.clock.day, `talk:${npc.id}`)] ?? 0) === 0
}

/**
 * 說話的收益遞減：越熟，一次閒聊能推進的越少。
 * 熟識 0 → +8；熟識 60 → +3.2；熟識 90 → +0.8。
 * 這讓「認識一個人」很快，「被一個人信任」很慢——後者本來就該慢。
 */
function talkGain(cur: number, base: number): number {
  return Math.max(1, Math.round(base * (1 - cur / 100) * 10) / 10)
}

/**
 * 把身體發生的事寫進 ledger。
 * ★ 舊版 126 筆 ledger 裡含「傷／膿／燒／敗血」字樣者是 0 筆——
 *   死於敗血的玩家看不到自己是在哪一步受的傷、當時可以花多少錢避免。
 */
function bodyLog(s: GameState, detail: string, exits: string[]): GameState {
  return { ...s, ledger: ledger(s, s, '身體', detail, exits, 'body') }
}

/**
 * 推進時間。
 *
 * ★★ 分段推進是使用者回報「角色無法死亡」的修法核心。
 *
 * 舊版一次把 N 分鐘加完，而剝奪計數只在 case 'sleep' 用「起床快照」遞增，
 * 於是白天挨餓零代價、不睡覺就不死（實測遊蕩 16.7 天，飽食 0 水分 0 仍活著）。
 *
 * 新版切成 ≤60 分鐘的段（時間仍是整數分鐘，紀律 8 不破），逐段：
 *   推進時鐘 → 更新剝奪計時 → 檢查是否跨過致死門檻
 * 命中門檻就【把時鐘停在那一段】——於是「睡到半夜渴死」的時刻是真的，
 * 不再是黎明的快照。
 *
 * ★ 剝奪計時【不吃 SLEEP_DECAY_MUL】：脫水不會因為睡著而暫停。
 */
/**
 * 錄取率的【單一】計算處。
 *
 * ★ 舊版 App.tsx 印的是 job.hireChance 的基礎值（永遠 60%），
 *   而實際機率被 hygiene 拉到 35%、又被監工熟識度最多推高 30 個百分點。
 *   那是一條活著的 UI 謊話，而且它躲過了「UI 不得硬寫機率」的建置期檢查
 *   ——因為那一行含 Math.round 而被白名單放行。
 *   現在 UI 與 reducer 共用這個函式，比照 applyTreatment 的既有前例。
 */
export function quoteHireChance(s: GameState, job: {
  id: string; hireChance: number; hireModBy?: NeedKey; hireChanceAtZero?: number
}): number {
  let p = job.hireChance
  if (job.hireModBy && job.hireChanceAtZero !== undefined) {
    const v = s.needs[job.hireModBy]
    p = job.hireChanceAtZero + (job.hireChance - job.hireChanceAtZero) * (v / 100)
  }
  const fore = s.npcs['npc-quays-foreman']
  if (job.id === 'job-quays-dayhire' && fore) p = Math.min(0.95, p + (fore.acquaintance / 100) * 0.3)
  return p
}

/** 理智低 → 找人說話也更花時間。UI 的按鈕印這個值，reducer 也用這個值。 */
export function quoteMinutes(s: GameState, base: number): number {
  return Math.round(base * fatigueMul(s.needs.sanity))
}

function applyMinutes(s: GameState, minutes: number, mode: 'awake' | 'asleep' = 'awake'): GameState {
  let cur = s
  let left = minutes
  while (left > 0) {
    const seg = Math.min(60, left)
    const { clock, needs, crossedMidnight } = advanceTime(cur, seg, mode)
    const dep = deprive(cur.deprivation, seg, needs)
    cur = {
      ...cur, clock, needs, deprivation: dep,
      stats: {
        ...cur.stats,
        maxStarveMinutes: Math.max(cur.stats.maxStarveMinutes, dep.starveMinutes),
        maxThirstMinutes: Math.max(cur.stats.maxThirstMinutes, dep.thirstMinutes),
      },
    }
    left -= seg

    // ★ 日界結算。advanceTime 一直有回傳 crossedMidnight，而全 repo 從來沒有人讀它
    //   ——這是它第一次有用途。掛在日界而不是 sleep，否則就是 §8 根因一的原地復發。
    if (crossedMidnight) cur = settleMind(cur)

    // 跨過致死門檻就停在這一段，剩下的時間不再推進
    if (stageOf('thirst', dep.thirstMinutes) === 3 || stageOf('starve', dep.starveMinutes) === 3) break
  }
  return cur
}

/** 當日行為旗標一律用既有的 jobAttempts 日鍵，不新增任何 state。 */
const setDayFlag = (s: GameState, k: string, n = 1): GameState => ({
  ...s,
  stats: { ...s.stats, jobAttempts: { ...s.stats.jobAttempts, [`${s.clock.day}|${k}`]: n } },
})

/**
 * 跨過午夜時結算理智與慾望。
 * 注意：此刻 clock 已經是【新的一天】，而要結算的是【昨天】的行為旗標，
 * 故旗標用 day − 1 去讀。
 */
function settleMind(s: GameState): GameState {
  const y = s.clock.day - 1
  const had = (k: string) => (s.stats.jobAttempts[`${y}|${k}`] ?? 0) > 0
  const cleanedBonus = (s.stats.jobAttempts[`${y}|cleanBonus`] ?? 0)
  const res = settleDay(s, {
    workedToday: had('worked'),
    talkedToday: had('talked'),
    ateHotToday: had('hotMeal'),
    cleanedBonus,
  })
  let out: GameState = {
    ...s,
    needs: { ...s.needs, sanity: res.sanity },
    mind: { ...s.mind, lastShelter: null },
  }
  for (const row of res.rows) {
    out = { ...out, ledger: ledger(out, out, '心理', `${row.key}｜理智 ${row.delta > 0 ? '+' : ''}${row.delta}`, row.exits, 'body') }
  }
  return out
}

/**
 * 單一死亡出口。
 *
 * ★ 舊版把 checkDeath 散在 5 個 case 裡，而 travel/work/buy/sell/useItem/treat
 *   六個 case 完全沒有呼叫——加上剝奪計數只在 sleep 遞增，
 *   實際結果是【全遊戲只有睡覺能致死】。
 *   改成放在 switch 之後的單一出口：一次補齊六個缺席點，
 *   而且以後新增 action 自動涵蓋，不會再漏。
 */
function checkDeath(s: GameState, log: string[], idx: Index): GameState {
  if (s.dead) return s
  const hz = needsHazard(s)
  // 死亡的那一刻不再印另一項的倒數——否則畫面會出現
  // 「再 37 小時就會死」緊接著「死於脫水」，玩家會以為倒數是錯的。
  for (const w of hz.death ? [] : hz.warnings) {
    const t = idx.text.deprivation[w.key]
    if (!t) continue
    log.push(t.stages[w.stage - 1] ?? '')
    log.push(t.eta.replace('{h}', String(Math.max(1, Math.round(w.minutesToDeath / 60)))))
    // ★ 剝奪的每一次階段升級都要留在決策鏈上，否則死於脫水的人
    //   在回溯畫面上看不到自己是從哪一刻開始沒水喝的。
    const seen = `dep:${w.key}:${w.stage}`
    if (!s.flags[seen]) {
      s = { ...s, flags: { ...s.flags, [seen]: true } }
      s = { ...s, ledger: ledger(s, s, '身體',
        `${t.name}：進入第 ${w.stage} 階（離死 ${Math.round(w.minutesToDeath / 60)} 小時）`,
        w.key === 'thirst' ? ['花 1 銅打一皮袋井水'] : ['花 1 銅買兩磅黑麥麵包'], 'body') }
    }
  }
  if (hz.death) {
    log.push(`—— ${hz.death}。`)
    s = { ...s, ledger: ledger(s, s, '身體', `★ ${hz.death}`, [], 'body') }
    return { ...s, dead: { day: s.clock.day, cause: hz.death }, ended: true }
  }
  return s
}

/**
 * 只把「已處置」寫進傷口本身，【不收費】。
 *
 * ★ 事件選項的代價由資料宣告（ev-wound-notice 的 spend: { copper: 1 } / { item: 'item-bandaid' }），
 *   引擎若再收一次就是雙重收費。費用留在資料層＝鐵律「內容零邏輯」的正確分工：
 *   資料說「這要一銅」，引擎說「這會讓化膿率變成 X」。
 */
function markTreated(
  s: GameState, injuryId: string, using: 'herbs' | 'sterile', idx: Index
): { s: GameState; text: string } {
  const inj = s.injuries.find((i) => i.id === injuryId)
  if (!inj || inj.healDay !== null) return { s, text: '' }
  const pct = (p: number) => `${Math.round(p * 100)}%`
  const T = idx.text.treat
  const text = inj.infected
    ? (using === 'sterile' ? T.sterileInfected : T.herbsInfected) ?? ''
    : ((using === 'sterile' ? T.sterile : T.herbs) ?? '')
        .replace('{before}', pct(quoteSuppuration(s, 'none')))
        .replace('{after}', pct(quoteSuppuration(s, using)))
  return {
    s: {
      ...s,
      injuries: s.injuries.map((i) => (i.id === injuryId ? { ...i, treatedDay: s.clock.day } : i)),
      flags: { ...s.flags, [`treated:${injuryId}:${using}`]: true },
    },
    text,
  }
}

/** 決定性挑選要處置的目標傷口：最早受的、還沒處置的（sinceDay 最小，id 字典序 tiebreak） */
function pickTreatTarget(s: GameState) {
  return s.injuries
    .filter((i) => i.healDay === null && i.treatedDay === null)
    .sort((x, y) => x.sinceDay - y.sinceDay || x.id.localeCompare(y.id))[0]
}

/**
 * 處置一道傷口。★ case 'treat' 與事件的 gain.treatInjury 共用同一份實作——
 * 這是修 ev-wound-notice 那個 blocker 的關鍵：兩條路徑必須位元一致，
 * 否則就會再度出現「事件裡治療付了錢卻零效果」。
 */
function applyTreatment(
  s: GameState, injuryId: string, using: 'herbs' | 'sterile', idx: Index
): { s: GameState; ok: boolean; detail: string; text: string } {
  const inj = s.injuries.find((i) => i.id === injuryId)
  if (!inj || inj.healDay !== null) return { s, ok: false, detail: '', text: '' }

  let carry = s.carry
  let purse = s.purse.copper
  let detail = ''
  if (using === 'herbs') {
    const held = s.carry.find((c) => c.item === 'item-salve' && c.count > 0)
    if (held) { carry = removeItem(s, 'item-salve'); detail = '用掉一劑苦鹽苔藥膏' }
    else {
      const price = idx.item.get('item-salve')?.priceCopper ?? 1
      if (purse < price) return { s, ok: false, detail: '', text: '你買不起藥膏。' }
      purse -= price
      detail = `現買一劑藥膏 −${price} 銅`
    }
  } else {
    if (!s.carry.some((c) => c.item === 'item-bandaid' && c.count > 0)) {
      return { s, ok: false, detail: '', text: '你沒有 OK 繃了。' }
    }
    carry = removeItem(s, 'item-bandaid')
    detail = '用掉一片 OK 繃'
  }

  const before = quoteSuppuration(s, 'none')
  const after = quoteSuppuration(s, using)
  const pct = (p: number) => `${Math.round(p * 100)}%`
  const T = idx.text.treat
  const text = inj.infected
    ? (using === 'sterile' ? T.sterileInfected : T.herbsInfected) ?? ''
    : ((using === 'sterile' ? T.sterile : T.herbs) ?? '')
        .replace('{before}', pct(before)).replace('{after}', pct(after))

  const spent = s.purse.copper - purse
  return {
    s: {
      ...s, carry, purse: { copper: purse },
      injuries: s.injuries.map((i) => (i.id === injuryId ? { ...i, treatedDay: s.clock.day } : i)),
      flags: { ...s.flags, [`treated:${injuryId}:${using}`]: true },
      stats: { ...s.stats, spentCopper: s.stats.spentCopper + Math.max(0, spent) },
    },
    ok: true, detail, text,
  }
}

export function reduce(state: GameState, a: Action, idx: Index): StepResult {
  if (state.dead || state.ended) return { s: state, log: [] }
  const before = state
  const log: string[] = []
  let s: GameState = { ...state }

  switch (a.t) {
    case 'travel': {
      let cur = s.at
      let totalMin = 0
      let totalStam = 0
      const edgeUse = { ...s.stats.edgeUse }
      const injuries = [...s.injuries]
      const hurt: string[] = []

      for (const eid of a.route) {
        const e = must(idx.edge, eid, '路段')
        const enc = 0
        totalStam += staminaFor(e, cur, enc, fatigueMul(s.needs.sanity))
        const atMin = (s.clock.minute + totalMin) % 1440
        // 風險判定：發生在玩家已看到 tell 之後（tell 隨路線一起呈現）
        if (roll(s.meta.seed, 'encounter', riskFor(e, atMin), 'edge', e.id, s.clock.day, atMin)) {
          injuries.push(newInjury(`inj-${s.clock.day}-${e.id}`, `${e.name}上的意外`, 1, s.clock.day))
          log.push(`在${e.name}上出了事。你帶著傷走完了剩下的路。`)
          hurt.push(`${e.name}上的意外`)
        }
        totalMin += e.minutes
        edgeUse[eid] = (edgeUse[eid] ?? 0) + 1
        cur = cur === e.a ? e.b : e.a
      }

      s = applyMinutes(s, totalMin)
      s = {
        ...s,
        at: cur,
        injuries,
        needs: { ...s.needs, stamina: clamp(s.needs.stamina - totalStam) },
        stats: { ...s.stats, edgeUse },
      }
      const nodeName = must(idx.node, cur, '節點').name
      log.push(`你走了 ${totalMin} 分鐘，到了${nodeName}。`)
      s = { ...s, ledger: ledger(s, before, '移動', `${totalMin} 分鐘 → ${nodeName}`, a.alternatives) }
      for (const h of hurt) {
        s = { ...s, stats: { ...s.stats, injuriesTaken: s.stats.injuriesTaken + 1 } }
        s = bodyLog(s, `受傷：${h}（未處置）`, ['花 1 銅買苦鹽苔藥膏處理', '用一片 OK 繃', '不處理'])
      }
      break
    }

    case 'work': {
      const job = must(idx.job, a.job, '工作')
      const c = ctxOf(s, idx)
      // ★ 接線 isIncapacitated。感染的主要後果是【斷了收入】，不是骰死亡——
      //   這才是 00_pillars.md 憲法範例鏈的字面意思：不是骰子殺了你，是貧窮殺了你。
      //   舊版 DayProgress.incapacitated 自始存在卻從未被讀取，是死碼。
      if (isIncapacitated(s)) {
        log.push('你在發燒。手抬不起來，站著都在晃——今天上不了工。')
        break
      }
      // ★★ 時段必須由【reducer 自己】守。
      //   單元測試抓到：這個檢查原本只存在於 App.tsx，reducer 完全不看 job.when——
      //   碼頭挑人窗口是 05:00–08:00，而 reducer 會接受凌晨三點上工，只有介面在擋。
      //   這與本專案已修掉的三個 blocker 是同一個模式（兩條路徑分歧，
      //   每條單獨看都對，錯在它們之間）。reducer 必須守住自己的前置條件——
      //   跑分腳本、存讀檔、未來的介面改動都不該有機會繞過它。
      if (!evaluate({ hours: job.when }, c)) {
        log.push(`${job.name}現在不招人（${job.when[0]}:00–${job.when[1]}:00）。`)
        break
      }
      if (!evaluate(job.requires, c)) {
        log.push('你今天做不了這個。')
        break
      }
      // ★ 一天只挑一次人。落選也算用掉一次——否則 60% 錄取率會被「原地重試」磨平，
      //   而正典的「一年只有 80–160 天有工可做」這條推導就白寫了。
      if (attemptsLeft(s, job) <= 0) {
        log.push(`${job.name}今天已經沒有你的份了。明天請早。`)
        break
      }
      const akey = attemptKey(s.clock.day, job.id)
      s = { ...s, stats: { ...s.stats, jobAttempts: { ...s.stats.jobAttempts, [akey]: (s.stats.jobAttempts[akey] ?? 0) + 1 } } }
      // ★ 錄取不是必然的：正典的年收與日薪衝突，唯一自洽解是「一年只有 80–160 天有工可做」
      //   計算本身抽到 quoteHireChance —— UI 與這裡必須是同一份實作。
      const p = quoteHireChance(s, job)
      // 鹽帶入「第幾次嘗試」，讓可多次嘗試的工作（如跑腿）每一趟都是獨立的一次抽選；
      // 只能嘗試一次的工作（碼頭、鹽池）行為與先前完全相同。
      const nth = s.stats.jobAttempts[akey]!
      const hired = roll(s.meta.seed, 'job', p, job.id, s.clock.day, nth)
      if (!hired) {
        s = applyMinutes(s, 45)
        s = {
          ...s,
          stats: { ...s.stats, wastedTrips: s.stats.wastedTrips + 1 },
        }
        log.push(`${job.tell}\n——今天輪不到你。你白等了四十五分鐘。`)
        // ★ 落選要說原因。舊版只說「今天輪不到你」，從不說是因為你太髒。
        const why: string[] = ['去別處', '改做別的']
        if (job.hireModBy === 'hygiene' && s.needs.hygiene < 60) {
          const after = quoteHireChance({ ...s, needs: { ...s.needs, hygiene: 100 } }, job)
          why.unshift(`洗乾淨再來（錄取率 ${Math.round(p * 100)}% → ${Math.round(after * 100)}%）`)
        }
        s = { ...s, ledger: ledger(s, before, '找工', `${job.name}：落選（錄取率 ${Math.round(p * 100)}%）`, why) }
        break
      }

      const injuries = [...s.injuries]
      const jobHurt: string[] = []
      for (const r of job.risks ?? []) {
        if (roll(s.meta.seed, 'injury', r.chance, job.id, r.injury, s.clock.day)) {
          injuries.push(newInjury(`inj-${s.clock.day}-${r.injury}`, r.injury, 1, s.clock.day))
          log.push(r.tell)
          jobHurt.push(r.injury)
        }
      }
      s = applyMinutes(s, job.minutes)
      const needs = { ...s.needs }
      for (const k of Object.keys(job.costs) as NeedKey[]) {
        needs[k] = clamp(needs[k] + (job.costs[k] ?? 0))
      }
      s = {
        ...s,
        needs,
        injuries,
        purse: { copper: s.purse.copper + job.payCopper },
        stats: { ...s.stats, earnedCopper: s.stats.earnedCopper + job.payCopper },
      }
      // ★ 關係從她已經在做的事長出來：扛了一天貨，監工就多認得你一分。
      if (job.npcOnComplete) {
        const g = job.npcOnComplete
        const cur = s.npcs[g.id] ?? { acquaintance: 0, trust: 0, affection: 0, lastSeenDay: null, knownFacts: [] }
        s = {
          ...s,
          npcs: {
            ...s.npcs,
            [g.id]: {
              ...cur,
              acquaintance: clamp(cur.acquaintance + talkGain(cur.acquaintance, g.acquaintance ?? 0)),
              trust: clamp(cur.trust + talkGain(cur.trust, g.trust ?? 0)),
              affection: clamp(cur.affection + talkGain(cur.affection, g.affection ?? 0)),
              lastSeenDay: s.clock.day,
            },
          },
        }
      }
      s = setDayFlag(s, 'worked')
      // ★ wageDays 量的是【日數】不是次數——同一天做兩份工只算一天。
      if (!s.stats.wageDaySeen[String(s.clock.day)]) {
        s = {
          ...s,
          stats: {
            ...s.stats,
            wageDays: s.stats.wageDays + 1,
            wageDaySeen: { ...s.stats.wageDaySeen, [String(s.clock.day)]: true },
          },
        }
      }
      log.push(`你做完了一天的${job.name}，領到 ${job.payCopper} 銅。`)
      s = { ...s, ledger: ledger(s, before, '工作', `${job.name}：+${job.payCopper} 銅`, ['休息', '去別處找工']) }
      for (const h of jobHurt) {
        s = { ...s, stats: { ...s.stats, injuriesTaken: s.stats.injuriesTaken + 1 } }
        s = bodyLog(s, `受傷：${h}（未處置）`, ['花 1 銅買苦鹽苔藥膏處理', '用一片 OK 繃', '不處理'])
      }
      break
    }

    case 'buy': {
      const it = must(idx.item, a.item, '物品')
      if (it.priceCopper === null || s.purse.copper < it.priceCopper) {
        log.push(`你買不起${it.name}。`)
        break
      }
      s = applyMinutes(s, 10)
      s = {
        ...s,
        purse: { copper: s.purse.copper - it.priceCopper },
        carry: addItem(s, a.item),
        stats: { ...s.stats, spentCopper: s.stats.spentCopper + it.priceCopper },
      }
      log.push(`你買下了${it.name}（${it.priceCopper} 銅）。`)
      s = { ...s, ledger: ledger(s, before, '購買', `${it.name} −${it.priceCopper} 銅`, ['不買，留著錢']) }
      break
    }

    case 'sell': {
      const it = must(idx.item, a.item, '物品')
      const price = it.sellCopper ?? 0
      if (countItem(s, a.item) <= 0 || price <= 0) break
      s = applyMinutes(s, 15)
      s = {
        ...s,
        purse: { copper: s.purse.copper + price },
        carry: removeItem(s, a.item),
        stats: { ...s.stats, earnedCopper: s.stats.earnedCopper + price },
      }
      log.push(`你賣掉了${it.name}，換得 ${price} 銅。`)
      s = { ...s, ledger: ledger(s, before, '販賣', `${it.name} +${price} 銅`, ['留著它']) }
      break
    }

    case 'useItem': {
      const it = must(idx.item, a.item, '物品')
      if (countItem(s, a.item) <= 0) break
      s = applyMinutes(s, 5)
      const needs = { ...s.needs }
      if (a.item === 'item-rye-bread') needs.satiety = clamp(needs.satiety + 70)
      if (a.item === 'item-fish-barley') {
        needs.satiety = clamp(needs.satiety + 55)
        needs.warmth = clamp(needs.warmth + HOT_MEAL_WARMTH)
        s = setDayFlag(s, 'hotMeal')
      }
      if (a.item === 'item-candy') needs.satiety = clamp(needs.satiety + 25)
      if (a.item === 'item-well-water') needs.hydration = clamp(needs.hydration + 80)
      s = { ...s, needs, carry: removeItem(s, a.item) }
      log.push(`你用掉了${it.name}。`)
      s = { ...s, ledger: ledger(s, before, '使用', it.name, ['留著它']) }
      break
    }

    case 'treat': {
      const inj = s.injuries.find((i) => i.id === a.injury)
      if (!inj) break
      if (a.using === 'none') break
      // ★ 與事件的 gain.treatInjury 共用同一份實作，避免兩條路徑再度分歧
      const res = applyTreatment(s, a.injury, a.using, idx)
      if (!res.ok) { if (res.text) log.push(res.text); break }
      s = applyMinutes(res.s, 20)
      log.push(res.text)
      s = { ...s, ledger: ledger(s, before, '處理傷口', `${inj.type}｜${res.detail}`, [idx.text.alternatives.treatSkip ?? '不處理']) }
      break
    }

    case 'sleep': {
      if (s.purse.copper < a.costCopper) {
        log.push('你付不起住宿費。')
        break
      }
      const kindName = a.kind === 'room' ? '客棧單間' : a.kind === 'bunk' ? '廉價宿屋通鋪' : '露宿'
      const toDawn = ((6 * 60 - s.clock.minute) + 1440) % 1440 || 1440
      // ★ 順序要緊：lastShelter 必須在 applyMinutes 【之前】寫。
      //   睡眠會跨午夜而觸發日界結算，而結算要讀的正是「昨夜睡在哪」。
      //   寫在後面的話，住宿的加減永遠晚一夜才被算到——煙霧測試 ㉔ 抓到的就是這個。
      s = { ...s, mind: { ...s.mind, lastShelter: a.kind } }
      s = applyMinutes(s, toDawn, 'asleep')
      // ★ 體溫必須有【出口】。舊版 rough −25 而 bunk/room 都是 0，
      //   於是不帶打火機的人 warmth 只減不增，是一條純單向槽——
      //   而 UI 同時在紅框裡宣稱「再不處理會死」。付錢買分級遮蔽是正典行為
      //   （canon: pilgrimage-of-the-wound.md 防風棚 1 銅／乾淨床 3 銅）。
      const shelter = SHELTER[a.kind]
      s = {
        ...s,
        purse: { copper: s.purse.copper - a.costCopper },
        needs: {
          ...s.needs,
          stamina: clamp(s.needs.stamina + shelter.stamina),
          warmth: clamp(s.needs.warmth + shelter.warmth),
        },
        stats: { ...s.stats, spentCopper: s.stats.spentCopper + a.costCopper },
      }

      // ★ 露宿且體溫過低 → 可能受寒。讓 App.tsx 那句「連兩夜會生病」第一次兌現。
      //   機率沿用 data/events.json 的 ev-alley-rain（0.18），不新增數字。
      //   warmth 70 → 45 → 20，剛好第三夜進入門檻。
      if (a.kind === 'rough' && s.needs.warmth < 25) {
        if (roll(s.meta.seed, 'injury', 0.18, 'chill', String(s.clock.day))) {
          s = { ...s, injuries: [...s.injuries, newInjury(`inj-${s.clock.day}-chill`, '受寒', 1, s.clock.day)] }
          log.push(idx.text.injury.chill ?? '你在冷裡睡了一夜。')
          s = { ...s, stats: { ...s.stats, injuriesTaken: s.stats.injuriesTaken + 1 } }
          s = bodyLog(s, '受傷：受寒（露宿，體溫過低）', ['花 3 銅睡通鋪', '吃一碗熱的醃魚大麥飯'])
        }
      }

      const prog = progressInjuries(s)
      for (const e of prog.events) log.push(e.text)
      s = { ...s, injuries: prog.injuries }
      // 身體的每一步都要進得了死亡回溯
      for (const e of prog.events) {
        if (e.key === 'suppurate') s = { ...s, stats: { ...s.stats, injuriesInfected: s.stats.injuriesInfected + 1 } }
        if (e.key === 'healed') s = { ...s, stats: { ...s.stats, injuriesHealed: s.stats.injuriesHealed + 1 } }
        s = bodyLog(s, `${e.injury}：${({ suppurate: '化膿', worsen: '惡化為嚴重', crisis: '撐過危機', healed: '痊癒' })[e.key]}`,
          e.key === 'suppurate' ? ['現在處置仍可取消惡化判定'] : [])
      }
      // ★ 舊版在這裡用「起床快照」遞增 hungryTicks / thirstyTicks，
      //   那是「角色無法死亡」的根因——現已改為 applyMinutes 內的連續剝奪計時。
      if (prog.death) {
        log.push(`—— ${prog.death}。`)
        s = { ...s, dead: { day: s.clock.day, cause: prog.death }, ended: true }
      }
      log.push(`天亮了。第 ${s.clock.day} 日。`)
      s = { ...s, ledger: ledger(s, before, '睡眠', `${kindName}${a.costCopper > 0 ? ` −${a.costCopper} 銅` : '（免費）'}`, ['再撐一會', '換個地方睡']) }
      break
    }

    case 'talk': {
      const npc = must(idx.npc, a.npc, 'NPC')
      if (!canTalk(s, npc)) {
        log.push(`${npc.name}現在沒空。`)
        break
      }
      const k = attemptKey(s.clock.day, `talk:${npc.id}`)
      const cur = s.npcs[npc.id] ?? { acquaintance: 0, trust: 0, affection: 0, lastSeenDay: null, knownFacts: [] }
      // 理智低 → 連說話都更花時間（fatigueMul）。按鈕上印的是同一個函式的值。
      s = applyMinutes(s, quoteMinutes(s, 30))
      s = {
        ...s,
        npcs: {
          ...s.npcs,
          [npc.id]: {
            ...cur,
            acquaintance: clamp(cur.acquaintance + talkGain(cur.acquaintance, 8)),
            trust: clamp(cur.trust + talkGain(cur.trust, 3)),
            affection: clamp(cur.affection + talkGain(cur.affection, 2)),
            lastSeenDay: s.clock.day,
          },
        },
        stats: { ...s.stats, jobAttempts: { ...s.stats.jobAttempts, [k]: 1 } },
      }
      // 台詞在 data/npcs.json（鐵律 5：敘事文本不得纏進程式碼）。
      // 決定性挑選：同一天同一刻必得同一句，存讀檔不會漂移。
      const lines = npc.talkLines
      log.push(lines.length > 0
        ? lines[(s.clock.day * 1440 + s.clock.minute) % lines.length]!
        : `你和${npc.name}說了一會兒話。`)
      s = setDayFlag(s, 'talked')
      s = { ...s, ledger: ledger(s, before, '說話', npc.name, ['去做別的']) }
      break
    }

    case 'clean': {
      const def = CLEAN[a.kind]
      const node = must(idx.node, s.at, '節點')
      if (!node.services.includes(def.service)) { log.push('這裡沒有可以洗的地方。'); break }
      const blocked = cleanBlocked(s, a.kind)
      if (blocked) { log.push(idx.text.clean.blocked ?? '你身上有還沒處置的傷口。'); break }
      const key = `clean:${a.kind}`
      if ((s.stats.jobAttempts[attemptKey(s.clock.day, key)] ?? 0) >= def.maxPerDay) {
        log.push('今天這樣洗過了。')
        break
      }
      if (s.purse.copper < def.copper) { log.push('你付不起。'); break }
      const beforeP = quoteSuppuration(s, 'none')
      s = applyMinutes(s, def.minutes)
      s = {
        ...s,
        purse: { copper: s.purse.copper - def.copper },
        needs: {
          ...s.needs,
          hygiene: clamp(s.needs.hygiene + def.hygiene),
          stamina: clamp(s.needs.stamina - def.stamina),
          sanity: clamp(s.needs.sanity + def.sanity),
        },
        stats: {
          ...s.stats,
          spentCopper: s.stats.spentCopper + def.copper,
          jobAttempts: {
            ...s.stats.jobAttempts,
            [attemptKey(s.clock.day, key)]: (s.stats.jobAttempts[attemptKey(s.clock.day, key)] ?? 0) + 1,
            [`${s.clock.day}|cleanBonus`]: (s.stats.jobAttempts[`${s.clock.day}|cleanBonus`] ?? 0) + def.sanity,
          },
        },
      }
      const afterP = quoteSuppuration(s, 'none')
      log.push((idx.text.clean[a.kind] ?? '你把自己洗乾淨了。')
        .replace('{before}', `${Math.round(beforeP * 100)}%`)
        .replace('{after}', `${Math.round(afterP * 100)}%`))
      s = { ...s, ledger: ledger(s, before, '洗淨', `${a.kind}｜清潔 +${def.hygiene}`, ['不洗，省下時間']) }
      break
    }

    case 'unwind': {
      const node = must(idx.node, s.at, '節點')
      if (!canUnwind(s, node)) { log.push(idx.text.unwind.cannot ?? '這裡不夠安靜。'); break }
      const key = 'unwind'
      if ((s.stats.jobAttempts[attemptKey(s.clock.day, key)] ?? 0) >= 1) { log.push('今天已經這樣待過一次了。'); break }
      const g = UNWIND_GAIN
      s = applyMinutes(s, UNWIND_MINUTES)
      s = {
        ...s,
        needs: {
          ...s.needs,
          sanity: clamp(s.needs.sanity + g),
          stamina: clamp(s.needs.stamina - UNWIND_STAMINA),
        },
        mind: { ...s.mind, lastUnwindDay: s.clock.day },
        stats: { ...s.stats, jobAttempts: { ...s.stats.jobAttempts, [attemptKey(s.clock.day, key)]: 1 } },
      }
      log.push(idx.text.unwind.done ?? '你找了個沒有人的角落，待了一會兒。')
      s = { ...s, ledger: ledger(s, before, '獨處', `理智 +${g}`, ['找個人說話（免費）', '早點睡（3 銅通鋪）']) }
      break
    }

    case 'wait': {
      s = applyMinutes(s, a.minutes)
      log.push(`你等了 ${a.minutes} 分鐘。`)
      s = { ...s, ledger: ledger(s, before, '等待', `${a.minutes} 分鐘`, ['做點別的']) }
      break
    }

    case 'eventChoice': {
      const ev = must(idx.event, a.event, '事件')
      const ch = ev.choices[a.choice]
      if (!ch) break
      // ★ reducer 自己也要守：UI 會過濾不可選項，但引擎不能依賴 UI。
      //   （煙霧測試 ⑧ 抓到的真 bug：跳過此檢查會讓錢被扣成負數）
      if (!evaluate(ch.requires, ctxOf(s, idx))) {
        log.push('你做不到這件事。')
        break
      }
      if (ch.spend?.copper !== undefined && s.purse.copper < ch.spend.copper) {
        log.push('你付不起。')
        break
      }
      const mins = ch.cost?.minutes ?? 0
      s = applyMinutes(s, mins)
      const needs = { ...s.needs }
      // ★★ 這裡原本硬寫五個鍵，於是事件寫 cost.sanity 會被【靜默丟棄】，
      //    而 resultText 照樣回饋「你好一點了」——與 ev-wound-notice 那個
      //    blocker 完全同型（玩家付了時間、遊戲說成功、數值一點都沒動）。
      //    改讀 NEED_KEYS 這個單一真相來源；煙霧測試 ㉒ 逐鍵鎖死。
      for (const k of NEED_KEYS) {
        const d = ch.cost?.[k]
        if (d !== undefined) needs[k] = clamp(needs[k] + d)
      }
      let purse = s.purse.copper
      let carry = s.carry
      let known = s.knownRoutes
      const flags = { ...s.flags }
      const stats = { ...s.stats }
      if (ch.spend?.copper) { purse -= ch.spend.copper; stats.spentCopper += ch.spend.copper }
      if (ch.spend?.item) carry = removeItem({ ...s, carry }, ch.spend.item)
      if (ch.gain?.copper) { purse += ch.gain.copper; stats.earnedCopper += ch.gain.copper }
      if (ch.gain?.item) carry = addItem({ ...s, carry }, ch.gain.item)
      if (ch.gain?.learnRoute && !known.includes(ch.gain.learnRoute)) {
        known = [...known, ch.gain.learnRoute]
        log.push('你記住了這條路。')
      }
      // gain.flag 可為單一字串或陣列（見 types.ts 的註解）
      for (const f of [ch.gain?.flag ?? []].flat()) flags[f] = true
      // 三個具名計數器
      if (ch.gain?.namedAsk) stats.namedAsks += 1
      if (ch.gain?.giveAway) stats.givenAway += 1
      let npcs = s.npcs
      if (ch.gain?.npc) {
        const g = ch.gain.npc
        const cur = npcs[g.id] ?? { acquaintance: 0, trust: 0, affection: 0, lastSeenDay: null, knownFacts: [] }
        npcs = {
          ...npcs,
          [g.id]: {
            acquaintance: clamp(cur.acquaintance + (g.acquaintance ?? 0)),
            trust: clamp(cur.trust + (g.trust ?? 0)),
            affection: clamp(cur.affection + (g.affection ?? 0)),
            lastSeenDay: s.clock.day,
            knownFacts: g.fact && !cur.knownFacts.includes(g.fact) ? [...cur.knownFacts, g.fact] : cur.knownFacts,
          },
        }
      }

      const injuries = [...s.injuries]
      const evHurt: string[] = []
      for (const r of ch.risks ?? []) {
        if (roll(s.meta.seed, 'encounter', r.chance, ev.id, String(a.choice), s.clock.day)) {
          if (r.injury) { injuries.push(newInjury(`inj-${s.clock.day}-${ev.id}`, r.injury, 1, s.clock.day)); evHurt.push(r.injury) }
          if (r.loseCopper) { purse = Math.max(0, purse - r.loseCopper); stats.spentCopper += r.loseCopper }
          log.push(r.tell)
        }
      }
      // ★ 修 blocker：ev-wound-notice 的治療選項舊版只寫全域 flag `treated-herbs`，
      //   而 body.ts 讀的是 `treated:<傷口id>:<方式>` —— 玩家付了錢、燒掉 OK 繃，
      //   化膿率一點都沒降，而遊戲當場回饋「你成功了」。現改為走共用實作。
      if (ch.resultText) log.push(ch.resultText)
      const moved = ch.gain?.moveTo
      if (moved) log.push(`你到了${must(idx.node, moved, '節點').name}。`)
      s = {
        ...s,
        at: moved ?? s.at,
        needs,
        injuries,
        purse: { copper: Math.max(0, Math.round(purse)) },
        carry,
        knownRoutes: known,
        flags,
        npcs,
        stats: { ...stats, eventsSeen: stats.eventsSeen.includes(ev.id) ? stats.eventsSeen : [...stats.eventsSeen, ev.id] },
        eventHistory: { ...s.eventHistory, [ev.id]: s.clock.day * 1440 + s.clock.minute },
      }
      s = { ...s, ledger: ledger(s, before, '事件抉擇', `${ev.name}：${ch.label}`, a.alternatives) }

      // ★ 必須跑在上面那個大 spread【之後】。
      //   第一次修這個 blocker 時我把它放在前面，結果 injuries / flags / purse
      //   被 spread 整批覆蓋掉——錢扣了、傷口沒變，跟原本的 bug 一模一樣。
      if (ch.gain?.treatInjury) {
        const target = pickTreatTarget(s)
        if (target) {
          const tr = markTreated(s, target.id, ch.gain.treatInjury, idx)
          s = tr.s
          if (tr.text) log.push(tr.text)
          s = bodyLog(s, `${target.type}：已處置（${ch.label}）`, [idx.text.alternatives.treatSkip ?? '不處理'])
        }
      }

      for (const h of evHurt) {
        s = { ...s, stats: { ...s.stats, injuriesTaken: s.stats.injuriesTaken + 1 } }
        s = bodyLog(s, `受傷：${h}（未處置）`, ['花 1 銅買苦鹽苔藥膏處理', '用一片 OK 繃', '不處理'])
      }
      break
    }
  }

  // ★ 單一死亡出口：涵蓋所有 action，包含舊版完全沒檢查的
  //   travel / work / buy / sell / useItem / treat 六個。
  s = checkDeath(s, log, idx)

  return { s, log }
}

/** 潮汐轉變偵測（供事件 10「被潮水困住」） */
export function tideTurn(before: GameState, after: GameState) {
  return tideTurnedDuring(before.clock.minute, after.clock.minute)
}

export function initialState(seed: string, at: NodeId, items: ItemId[], idx?: Index): GameState {
  return {
    // ★ 版本號只有一個真相來源（save.ts）。第一版在這裡另寫了一個 2，
    //   而 SAVE_VERSION 升到 3 之後所有存檔測試立刻紅——正是兩個真相來源的典型症狀。
    meta: { schemaVersion: SAVE_VERSION, seed, startedAt: 'C.R. 837 枯收季' },
    clock: { day: 1, minute: 23 * 60 + 40 },
    at,
    // sanity 初值 50：invented:（正典零錨點）。她剛到，還沒被磨掉，但也已經不好。
    needs: { satiety: 55, hydration: 60, stamina: 70, warmth: 70, hygiene: 80, sanity: 50 },
    mind: { lastShelter: null, lastUnwindDay: null },
    deprivation: { starveMinutes: 0, thirstMinutes: 0 },
    injuries: [],
    purse: { copper: 0 },
    // ★ 消耗品次數：ItemDef.uses 與 carry 的 count 早就存在卻從未接上，
    //   於是「一盒無菌敷料·六條裡剩九片」按一次就整盒消失、「糖果三顆」按「吃一顆」全吃光。
    carry: items.map((i) => ({ item: i, count: idx?.item.get(i)?.uses ?? 1 })),
    knownRoutes: [],
    rep: {},
    npcs: {},
    flags: {},
    eventHistory: {},
    ledger: [],
    stats: {
      earnedCopper: 0, spentCopper: 0,
      maxStarveMinutes: 0, maxThirstMinutes: 0,
      injuriesTaken: 0, injuriesInfected: 0, injuriesHealed: 0,
      wastedTrips: 0, edgeUse: {}, eventsSeen: [], jobAttempts: {},
      namedAsks: 0, wageDays: 0, givenAway: 0, wageDaySeen: {},
    },
    dead: null,
    ended: false,
  }
}
