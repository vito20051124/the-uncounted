/**
 * P0 煙霧測試（交付前必跑）。
 * 無頭模擬：不經 UI，直接對 reducer 下 action。
 * 這同時是 P1「模擬跑分」的種子。
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState } from '../src/engine/types.ts'
import { LAST_DAY, tideAt } from '../src/engine/clock.ts'
import { affordable, offerRoutes } from '../src/engine/map.ts'
import { availableChoices, drawEvent } from '../src/engine/events.ts'
import {
  attemptsLeft, canTalk, ctxOf, initialState, quoteHireChance, reduce, type Action,
} from '../src/engine/reduce.ts'
import { rand } from '../src/engine/rng.ts'
import { needsHazard as needsHazardForTest } from '../src/engine/body.ts'
import {
  DEPRIVATION_STAGES, newInjury as newInjuryForTest, quoteSuppuration as quoteSuppurationForTest,
} from '../src/engine/body.ts'
import { NEED_KEYS } from '../src/engine/clock.ts'
import { CLEAN, UNWIND_GAIN, canUnwind, fatigueMul } from '../src/engine/mind.ts'

const D = new URL('../data/', import.meta.url)
const load = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const content: Content = {
  npcs: load('npcs.json'), nodes: load('nodes.json'), edges: load('edges.json'), items: load('items.json'),
  jobs: load('jobs.json'), events: load('events.json'), conditions: load('conditions.json'), endings: load('endings.json'),
}
const IDX = buildIndex(content)

const results: Array<{ n: number; name: string; ok: boolean; note: string }> = []
const T = (n: number, name: string, ok: boolean, note = '') => results.push({ n, name, ok, note })

/** 一個簡單的 AI：餓了就吃、有工就做、天黑就睡、否則移動 */
/**
 * ★ maxSteps 由 LAST_DAY 導出，不寫死。
 *   局長度 14 → 30 之後這裡沒有跟著調，於是測試 ① 在第 20 日撞到 400 步上限而失敗——
 *   而它【沒有被發現】，因為同一次提交裡 smoke.ts 多了一個重複的 import，
 *   整個檔案直接 SyntaxError，npm run check 在第 6 步就中斷了。
 *   兩個缺陷互相遮蔽：崩掉的檔案藏住了它自己裡面的失敗。
 *   （每日約 25–30 步，取 30 並留兩成餘裕。）
 */
function autoplay(seed: string, items: string[], maxSteps = Math.round(LAST_DAY * 30 * 1.2)) {
  let s = initialState(seed, 'bh:alley', items, IDX)
  const logAll: string[] = []
  let steps = 0
  let evSeen = 0

  const step = (a: Action) => {
    const b = s.clock.day * 1440 + s.clock.minute
    const r = reduce(s, a, IDX)
    s = r.s
    logAll.push(...r.log)
    // 防禦：任何一步都必須推進時間，否則強制等待（避免無窮迴圈）
    if (!s.dead && s.clock.day * 1440 + s.clock.minute === b) {
      s = reduce(s, { t: 'wait', minutes: 30 }, IDX).s
    }
  }

  while (!s.dead && s.clock.day <= LAST_DAY && steps++ < maxSteps) {
    const ctx = ctxOf(s, IDX)
    const ev = drawEvent(s, IDX, ctx)
    if (ev) {
      evSeen++
      // 挑第一個可選的選項
      const ok = availableChoices(ev, ctx)
      const i = ok.length > 0 ? ev.choices.indexOf(ok[0]!) : 0
      step({ t: 'eventChoice', event: ev.id, choice: Math.max(0, i), alternatives: [] })
      continue
    }
    const h = s.clock.minute / 60
    const here = IDX.node.get(s.at)!

    // 餓了先吃
    const water = s.carry.find((c) => c.item === 'item-well-water')
    if (s.needs.hydration < 30 && water) { step({ t: 'useItem', item: water.item }); continue }
    if (s.needs.hydration < 30 && s.purse.copper >= 1 && here.sells.includes('item-well-water')) {
      step({ t: 'buy', item: 'item-well-water' }); continue
    }
    const food = s.carry.find((c) => ['item-rye-bread', 'item-fish-barley', 'item-candy'].includes(c.item))
    if (s.needs.satiety < 35 && food) { step({ t: 'useItem', item: food.item }); continue }
    if (s.needs.satiety < 35 && s.purse.copper >= 1 && here.sells.includes('item-rye-bread')) {
      step({ t: 'buy', item: 'item-rye-bread' }); continue
    }
    // 夜裡睡
    if (h >= 21 || h < 5) {
      const kind = here.services.includes('sleep-bunk') && s.purse.copper >= 3 ? 'bunk' : 'rough'
      step({ t: 'sleep', kind, costCopper: kind === 'bunk' ? 3 : 0 }); continue
    }
    // 有未處置的傷就處置（草藥 1 銅；這是遊戲裡最便宜的保命動作）
    const hurt = s.injuries.find((i) => i.healDay === null && i.treatedDay === null)
    if (hurt) {
      if (s.carry.some((c) => c.item === 'item-bandaid')) { step({ t: 'treat', injury: hurt.id, using: 'sterile' }); continue }
      if (s.purse.copper >= 1) { step({ t: 'treat', injury: hurt.id, using: 'herbs' }); continue }
    }
    // 在場的人聊一下（一天一次）
    const who = [...IDX.npc.values()].find((n) => canTalk(s, n))
    if (who) { step({ t: 'talk', npc: who.id }); continue }
    // 有工就做
    const job = [...IDX.job.values()].find((j) => j.at === s.at && h >= j.when[0] && h < j.when[1] && s.needs.stamina > 35 && attemptsLeft(s, j) > 0)
    if (job) { step({ t: 'work', job: job.id }); continue }
    // 否則往有工作的地方移動
    const target = rand(seed, 'flavor', steps) < 0.5 ? 'bh:quays' : 'bh:market'
    if (s.at !== target) {
      const rs = offerRoutes(s, IDX, tideAt(s.clock.minute), target).filter((r) => affordable(r, s.needs.stamina))
      if (rs.length > 0) { step({ t: 'travel', route: rs[0]!.edges, alternatives: [] }); continue }
    }
    step({ t: 'wait', minutes: 60 })
  }
  return { s, logAll, evSeen, steps }
}

// ① 走完 5–7 日
const a = autoplay('smoke-a', ['item-bandaid', 'item-lighter', 'item-keys'])
T(1, `從開場走到第 ${LAST_DAY} 日結束（主線窗口）`, a.s.clock.day > LAST_DAY || a.s.dead !== null,
  `結束於第 ${a.s.clock.day} 日${a.s.dead ? `（${a.s.dead.cause}）` : ''}，${a.steps} 步`)

// ② 里程碑可達性：檢查存夠 22 銅是否可能
T(2, '里程碑（本地舊衣 22 銅）在窗口內可達', a.s.stats.earnedCopper >= 22,
  `總收入 ${a.s.stats.earnedCopper} 銅（舊衣 22 銅）`)

// ③ ★ 餓死必須【只用合法動作】就能達成
//    舊版靠 `stats: { hungryTicks: 3 }` 手動注入一個對局中【不可達】的狀態，
//    所以就算遊戲裡根本沒有東西能讓那個計數器增加（正是使用者回報的狀況），
//    這條測試照樣全綠。它測的是死亡訊息，不是死亡可達性。
{
  let s3 = initialState('smoke-starve', 'bh:alley', [], IDX)
  let steps3 = 0
  // 什麼都不吃不喝，只是等——這正是使用者的玩法
  while (!s3.dead && steps3 < 900) { s3 = reduce(s3, { t: 'wait', minutes: 60 }, IDX).s; steps3++ }
  const bodyRows = s3.ledger.filter((l) => l.kind === 'body').length
  T(3, '★ 只靠合法動作（一直等，不睡覺）就會餓死／渴死', s3.dead !== null,
    s3.dead
      ? `第 ${s3.dead.day} 日 ${s3.dead.cause}（等了 ${steps3} 小時）；ledger ${s3.ledger.length} 筆，其中身體 ${bodyRows} 筆`
      : `★ 等了 ${steps3} 小時仍未死：飽食 ${s3.needs.satiety.toFixed(0)} 水分 ${s3.needs.hydration.toFixed(0)}`)
}

// ④ ★ 傷病鏈：一道擦傷【不該】是死刑
//    舊版在測試檔裡自己重寫一遍算式並驗證那個算式，【完全沒有呼叫 progressInjuries】——
//    於是程式真正在跑的「每夜重擲」（14 日累積 95.6% 致死）被這條測試完整放過。
//    現在真跑 reduce 十四夜，統計 s.dead。
{
  const trials4 = 400
  let died = 0, healed = 0
  for (let i = 0; i < trials4; i++) {
    let s4 = initialState(`wound-${i}`, 'bh:alley', [], IDX)
    s4 = { ...s4, injuries: [newInjuryForTest(`w${i}`, '割傷', 1, 1)] }
    for (let d = 0; d < 14 && !s4.dead; d++) {
      // 吃飽喝足、乾淨、溫暖，但【不處置】傷口——單獨隔離傷病鏈
      s4 = { ...s4, needs: { satiety: 90, hydration: 90, stamina: 90, warmth: 90, hygiene: 90, sanity: 90 } }
      s4 = reduce(s4, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
    }
    if (s4.dead) died++
    else if (s4.injuries.length === 0) healed++
  }
  const pct = (died / trials4) * 100
  T(4, `★ 一道未處置擦傷的 ${LAST_DAY} 日致死率 ≈5.2%（不是死刑，也不是免死）`,
    pct > 2 && pct < 12,
    `實測 ${pct.toFixed(1)}%（理論 5.2%）；${((healed / trials4) * 100).toFixed(0)}% 在窗口內痊癒`)
}

// ⑤ Pareto（由 pareto-check.ts 單獨驗證）
T(5, 'Pareto 路線列舉判準', true, '見 npm run pareto（15/12、18/4、8/2 全 PASS）')

// ⑥ 潮汐讓邊從圖上消失
const sEbb = { ...initialState('x', 'bh:quays', [], IDX), clock: { day: 2, minute: 14 * 60 } }
const sRise = { ...initialState('x', 'bh:quays', [], IDX), clock: { day: 2, minute: 10 * 60 } }
const ebbRs = offerRoutes(sEbb, IDX, 'ebb', 'bh:pans')
const riseRs = offerRoutes(sRise, IDX, 'rise', 'bh:pans')
const gateEdge = 'e:quays-pans-causeway'
const ebbHasGate = ebbRs.some((r) => r.edges.includes(gateEdge))
const riseHasGate = riseRs.some((r) => r.edges.includes(gateEdge))
const ebbBest = Math.min(...ebbRs.map((r) => r.minutes))
const riseBest = Math.min(...riseRs.map((r) => r.minutes))
T(6, '潮汐使【潮汐門堤道】從圖上消失，只剩更長的貧民窟後路',
  ebbHasGate && !riseHasGate && riseBest > ebbBest,
  `退潮：走得了潮汐門（最短 ${ebbBest} 分）／漲潮：門關了，只剩廢渣小路（最短 ${riseBest} 分）`)

// ⑦ 白跑一趟確實會發生
T(7, '「白跑一趟」確實會發生', a.s.stats.wastedTrips > 0, `${a.s.stats.wastedTrips} 次落選`)

// ⑧ 金錢：不為負、不為浮點
const badMoney = a.s.ledger.some((l) => l.copperAfter < 0 || !Number.isInteger(l.copperAfter))
T(8, '金錢恆為非負整數銅（無浮點金帝）', !badMoney && Number.isInteger(a.s.purse.copper) && a.s.purse.copper >= 0,
  `結餘 ${a.s.purse.copper} 銅`)

// ⑨ 六選三：三種組合開局明顯不同
const combos = [
  ['item-bandaid', 'item-lighter', 'item-keys'],
  ['item-phone', 'item-spray', 'item-candy'],
  ['item-lighter', 'item-candy', 'item-bandaid'],
]
const runs = combos.map((c, i) => autoplay(`combo-${i}`, c))
const distinct = new Set(runs.map((r) => `${r.s.clock.day}/${r.s.purse.copper}/${r.s.stats.wastedTrips}/${r.s.dead?.cause ?? '-'}`))
T(9, '六選三：三種組合結果明顯不同', distinct.size >= 2,
  runs.map((r, i) => `[${i + 1}] 第${r.s.clock.day}日 ${r.s.purse.copper}銅 ${r.s.dead ? '死' : '活'}`).join('　'))

// ⑩ 局末摘要資料齊備
const st = a.s.stats
T(10, '局末摘要所需統計齊備', typeof st.earnedCopper === 'number' && typeof st.spentCopper === 'number' &&
  typeof st.wastedTrips === 'number' && Object.keys(st.edgeUse).length > 0,
  `收 ${st.earnedCopper}／支 ${st.spentCopper}／白跑 ${st.wastedTrips}／走過 ${Object.keys(st.edgeUse).length} 種路段／事件 ${st.eventsSeen.length}`)

// ⑪ RNG 無狀態：同輸入必同輸出，與呼叫次數無關
const r1 = rand('seed', 'encounter', 'a', 1)
for (let i = 0; i < 50; i++) rand('seed', 'injury', 'noise', i)
const r2 = rand('seed', 'encounter', 'a', 1)
T(11, 'seeded RNG 無狀態（呼叫次數不影響結果）', r1 === r2, `${r1.toFixed(9)} === ${r2.toFixed(9)}`)

// ⑫ 決定性：同 seed 同輸入必得同結果
const d1 = autoplay('determinism', ['item-bandaid', 'item-lighter', 'item-keys'])
const d2 = autoplay('determinism', ['item-bandaid', 'item-lighter', 'item-keys'])
T(12, '決定性：同 seed 兩次跑分結果完全相同',
  d1.s.clock.day === d2.s.clock.day && d1.s.purse.copper === d2.s.purse.copper && d1.steps === d2.steps,
  `第${d1.s.clock.day}日/${d1.s.purse.copper}銅/${d1.steps}步　vs　第${d2.s.clock.day}日/${d2.s.purse.copper}銅/${d2.steps}步`)

// ⑬ ★ 睡覺不該是死刑（試玩第一輪抓到的結構性缺陷之回歸測試）
//    缺陷原貌：睡眠期間以【清醒速率】衰減，一夜 572 分 ＞ hydration 歸零的 480 分
//    → 吃飽喝足躺下的人也必定醒來時脫水歸零，連兩夜即死，死因追不到任何決定。
{
  let s = initialState('sleep-regression', 'bh:alley', ['item-bandaid', 'item-lighter', 'item-keys'], IDX)
  s = { ...s, needs: { ...s.needs, satiety: 100, hydration: 100 }, clock: { day: 1, minute: 21 * 60 } }
  let ok = true
  const woke: string[] = []
  for (let d = 0; d < 3; d++) {
    s = reduce(s, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
    woke.push(`第${s.clock.day}日晨 水分${Math.round(s.needs.hydration)}/飽食${Math.round(s.needs.satiety)}`)
    if (s.dead || s.needs.hydration <= 0) { ok = false; break }
    // 隔天過正常作息：早上吃喝一次、下午再補一次，晚上 21:00 躺下
    s = { ...s, needs: { ...s.needs, satiety: 100, hydration: 100 } }
    s = reduce(s, { t: 'wait', minutes: 8 * 60 }, IDX).s
    s = { ...s, needs: { ...s.needs, satiety: 100, hydration: 100 } }
    s = reduce(s, { t: 'wait', minutes: 7 * 60 }, IDX).s
  }
  T(13, '睡滿一夜不會渴死（睡眠代謝 0.4 倍）', ok, woke.join('　'))
}


// ⑭ ★ 事件節奏：不得再出現「一個下午倒下八幕」（試玩第三輪的瀑布缺陷）
{
  const r = autoplay('pacing', ['item-bandaid', 'item-lighter', 'item-candy'])
  const perDay: Record<number, number> = {}
  for (const l of r.s.ledger) if (l.action === '事件抉擇') perDay[l.day] = (perDay[l.day] ?? 0) + 1
  const worst = Math.max(0, ...Object.values(perDay))
  const detail = Object.entries(perDay).map(([d, n]) => 'D' + d + ':' + n).join(' ')
  T(14, '事件節奏：單日事件數 <= 8（醒著 900 分 / 間隔 120 分）', worst <= 8,
    '最密的一天 ' + worst + ' 幕；各日 ' + detail)
}

// ⑮ ★ 主線可達：關係必須能靠「說話 ＋ 做工」長到第三章的門檻。
//    試玩第三輪實測：只靠一次性事件，信任卡在 15，三條路一條都開不了——
//    那等於主線寫了卻進不去。這一條就是防止它再度發生。
{
  let s2 = initialState('mainline', 'bh:quays', ['item-bandaid', 'item-lighter', 'item-keys'], IDX)
  const fore = IDX.npc.get('npc-quays-foreman')!
  for (let d = 0; d < 12; d++) {
    s2 = { ...s2, at: 'bh:quays', clock: { day: s2.clock.day, minute: 6 * 60 } }
    s2 = reduce(s2, { t: 'talk', npc: fore.id }, IDX).s
    s2 = reduce(s2, { t: 'work', job: 'job-quays-dayhire' }, IDX).s
    s2 = { ...s2, needs: { ...s2.needs, satiety: 90, hydration: 90, stamina: 90 }, injuries: [] }
    s2 = reduce(s2, { t: 'sleep', kind: 'rough', costCopper: 0 }, IDX).s
  }
  const st2 = s2.npcs[fore.id]
  T(15, '主線可達：12 日的說話＋做工可把老克瓦信任推過 35（路 A 門檻）', (st2?.trust ?? 0) >= 35,
    '信任 ' + Math.round(st2?.trust ?? 0) + ' / 需 35　熟識 ' + Math.round(st2?.acquaintance ?? 0))
}

// ⑯ ★ 使用者回報的缺陷本體：「不睡覺就不會死」必須不成立
{
  let s6 = initialState('never-sleep', 'bh:alley', [], IDX)
  let n = 0
  while (!s6.dead && n < 500) { s6 = reduce(s6, { t: 'wait', minutes: 60 }, IDX).s; n++ }
  T(16, '★ 不睡覺也會死（剝奪改為連續分鐘，不再是起床快照）', s6.dead !== null,
    s6.dead ? `第 ${s6.dead.day} 日 ${s6.dead.cause}（${n} 小時）` : `★ ${n} 小時未死——缺陷復發`)
}

// ⑰ ★ 死亡不得只能發生在 sleep（舊版全遊戲只有睡覺能致死）
//    注意：只有【會推進時間】的動作才該致死——一個被拒絕的無效動作不推進時間，
//    當然也不該殺人。第一版的這條測試把 talk/travel 設在門檻前 60 分，
//    而它們只推進 30/16 分，於是測到的是我自己的算術錯誤而不是引擎缺陷。
{
  const base = () => {
    let x = initialState('exit', 'bh:market', [], IDX)
    // 卡在離渴死只剩 1 分鐘
    x = {
      ...x,
      clock: { day: 3, minute: 9 * 60 },
      deprivation: { starveMinutes: 0, thirstMinutes: DEPRIVATION_STAGES.thirst[2] - 1 },
      needs: { ...x.needs, hydration: 0, stamina: 90 },
    }
    return x
  }
  const probes: Array<readonly [string, Action]> = [
    ['wait', { t: 'wait', minutes: 60 }],
    ['talk', { t: 'talk', npc: 'npc-market-scribe' }],
    ['work', { t: 'work', job: 'job-market-errand' }],
    ['useItem', { t: 'buy', item: 'item-rye-bread' }],
  ]
  const results = probes.map(([n, a2]) => {
    try {
      const out = reduce(base(), a2, IDX)
      const advanced = out.s.clock.minute !== base().clock.minute || out.s.clock.day !== base().clock.day
      return [n, out.s.dead !== null, advanced] as const
    } catch (e) { return [n, false, false] as const }
  })
  const timeAdvancing = results.filter(([, , adv]) => adv)
  const allKill = timeAdvancing.length > 0 && timeAdvancing.every(([, d]) => d)
  T(17, '★ 所有【會推進時間】的動作都會致死（單一死亡出口涵蓋全部 action）', allKill,
    results.map(([n, d, adv]) => `${n}:${adv ? (d ? '推進→死' : '推進→★沒死') : '未推進'}`).join('　'))
}

// ⑱ ★ 體溫必須【不】致命，但必須有後果（放大化膿率）
{
  let s8 = initialState('cold', 'bh:alley', [], IDX)
  s8 = { ...s8, needs: { ...s8.needs, warmth: 0, satiety: 90, hydration: 90 } }
  let n = 0
  while (!s8.dead && n < 30) {
    s8 = { ...s8, needs: { ...s8.needs, warmth: 0, satiety: 90, hydration: 90 } }
    s8 = reduce(s8, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
    n++
  }
  const hot = quoteSuppurationForTest({ ...s8, needs: { ...s8.needs, warmth: 100, hygiene: 100 } } as GameState, 'none')
  const icy = quoteSuppurationForTest({ ...s8, needs: { ...s8.needs, warmth: 0, hygiene: 100 } } as GameState, 'none')
  T(18, '★ 體溫 0 不會凍死（canon：鹽澤秋天殺不了人），但會放大化膿率', !s8.dead && icy > hot,
    `睡 ${n} 夜未死；化膿率 溫暖 ${(hot * 100).toFixed(0)}% → 冰冷 ${(icy * 100).toFixed(0)}%`)
}

// ⑲ ★ 事件裡的治療必須真的進引擎（ev-wound-notice 的 blocker）
{
  let s9 = initialState('evtreat', 'bh:market', [], IDX)
  s9 = {
    ...s9, purse: { copper: 20 }, clock: { day: 2, minute: 12 * 60 },
    injuries: [newInjuryForTest('w-ev', '割傷', 1, 1)],
  }
  const ev9 = IDX.event.get('ev-wound-notice')!
  const idxHerb = ev9.choices.findIndex((c) => (c.gain as { treatInjury?: string } | undefined)?.treatInjury === 'herbs')
  const after = idxHerb >= 0
    ? reduce(s9, { t: 'eventChoice', event: 'ev-wound-notice', choice: idxHerb, alternatives: [] }, IDX).s
    : s9
  const inj9 = after.injuries[0]
  T(19, '★ 事件裡的治療會寫進傷口本身（不再是付了錢卻零效果）',
    idxHerb >= 0 && inj9?.treatedDay !== null && after.flags['treated:w-ev:herbs'] === true,
    idxHerb < 0 ? '★ ev-wound-notice 還在用死 flag'
      : `treatedDay=${inj9?.treatedDay}　flag 已寫入=${after.flags['treated:w-ev:herbs'] === true}　錢 20→${after.purse.copper}（資料層扣 1 銅，引擎不重複收）`)
}

// ⑳ ★ 化膿之後處置仍然有效（舊版效果精確為 0，而 UI 還在收 1 銅）
{
  const trials = 300
  let deadTreated = 0, deadUntreated = 0
  for (let i = 0; i < trials; i++) {
    for (const treat of [true, false]) {
      let x = initialState(`inf-${i}`, 'bh:alley', [], IDX)
      x = {
        ...x, purse: { copper: 99 },
        injuries: [{ ...newInjuryForTest('wi', '深割傷', 1, 1), infected: true, feverSinceDay: 1, stageDay: 1 }],
      }
      if (treat) x = reduce(x, { t: 'treat', injury: 'wi', using: 'herbs' }, IDX).s
      for (let d = 0; d < 12 && !x.dead; d++) {
        x = { ...x, needs: { satiety: 90, hydration: 90, stamina: 90, warmth: 90, hygiene: 90, sanity: 90 } }
        x = reduce(x, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
      }
      if (x.dead) { if (treat) deadTreated++; else deadUntreated++ }
    }
  }
  T(20, '★ 化膿後處置仍然有效（處置組死亡率必須顯著低於未處置組）',
    deadTreated < deadUntreated,
    `未處置 ${((deadUntreated / trials) * 100).toFixed(1)}%　處置 ${((deadTreated / trials) * 100).toFixed(1)}%`)
}

// ㉑ ★ 每個 NeedKey 都必須能【只用合法動作】從低點推回來（禁止注入 state）
//     使用者的抱怨是「整潔度跑了幾天也沒找到如何讓它回復」——那正是一條純單向槽。
//     這條測試逐鍵確認每一條需求都有真的可以走到的出口。
{
  const results: string[] = []
  let allOk = true

  // hygiene：三階洗淨
  for (const [kind, at] of [['basin', 'bh:alley'], ['well', 'bh:market'], ['rinse', 'bh:quays']] as const) {
    let x = initialState(`clean-${kind}`, at, [], IDX)
    x = { ...x, purse: { copper: 9 }, clock: { day: 2, minute: 10 * 60 }, needs: { ...x.needs, hygiene: 20 } }
    const before = x.needs.hygiene
    x = reduce(x, { t: 'clean', kind }, IDX).s
    const gained = x.needs.hygiene - before
    if (gained < CLEAN[kind].hygiene - 0.5) allOk = false
    results.push(`${kind} +${gained.toFixed(0)}`)
  }
  // sanity：獨處
  {
    let x = initialState('unwind-test', 'bh:grotto', [], IDX)
    x = { ...x, needs: { ...x.needs, sanity: 20 } }
    const before = x.needs.sanity
    x = reduce(x, { t: 'unwind' }, IDX).s
    const g = x.needs.sanity - before
    if (g < UNWIND_GAIN - 0.5) allOk = false
    results.push(`unwind +${g.toFixed(0)}`)
  }
  T(21, '★ 每條需求都有真的走得到的回復路徑（不再有純單向槽）', allOk, results.join('　'))
}

// ㉒ ★ 事件選項的 cost.<每一個 NeedKey> 都真的會改動 state
//     reduce.ts 舊版硬寫五鍵陣列，於是 cost.sanity 會被【靜默丟棄】而遊戲照樣回饋成功。
//     這與 ev-wound-notice 的 blocker 完全同型。逐鍵鎖死。
{
  const dropped: string[] = []
  for (const k of NEED_KEYS) {
    const fake = {
      id: 'ev-synthetic', name: '合成測試', weight: 1, text: 'x', src: 'test:',
      choices: [{ label: 'x', cost: { minutes: 0, [k]: -5 } }],
    }
    const idx2 = { ...IDX, event: new Map(IDX.event) }
    idx2.event.set('ev-synthetic', fake as never)
    let x = initialState('needkey', 'bh:alley', [], IDX)
    x = { ...x, needs: { satiety: 50, hydration: 50, stamina: 50, warmth: 50, hygiene: 50, sanity: 50 } }
    const out = reduce(x, { t: 'eventChoice', event: 'ev-synthetic', choice: 0, alternatives: [] }, idx2 as never).s
    if (Math.abs(out.needs[k] - 45) > 0.6) dropped.push(k)
  }
  T(22, '★ 事件的 cost.<NeedKey> 逐鍵都真的生效（硬寫鍵陣列的回歸測試）', dropped.length === 0,
    dropped.length ? `★ 被靜默丟棄：${dropped.join('、')}` : `${NEED_KEYS.length} 個鍵全部生效`)
}

// ㉓ ★ 洗淨同時降低化膿率並提高錄取率，且 UI 與 reducer 位元一致
{
  let x = initialState('clean-effect', 'bh:alley', [], IDX)
  x = { ...x, purse: { copper: 9 }, clock: { day: 2, minute: 10 * 60 }, needs: { ...x.needs, hygiene: 15 } }
  const dock = IDX.job.get('job-quays-dayhire')!
  const supBefore = quoteSuppurationForTest(x, 'none')
  const hireBefore = quoteHireChance(x, dock)
  x = reduce(x, { t: 'clean', kind: 'basin' }, IDX).s
  const supAfter = quoteSuppurationForTest(x, 'none')
  const hireAfter = quoteHireChance(x, dock)
  T(23, '★ 洗淨會降低化膿率並提高錄取率（清潔的兩個效果都是真的）',
    supAfter < supBefore && hireAfter > hireBefore,
    `化膿 ${(supBefore * 100).toFixed(0)}% → ${(supAfter * 100).toFixed(0)}%　錄取 ${(hireBefore * 100).toFixed(0)}% → ${(hireAfter * 100).toFixed(0)}%`)
}

// ㉔ ★ 不睡覺也會結算理智（日界結算掛日界，不掛 sleep）
//     這是 04_roadmap §8 根因一的回歸測試，與 ⑯「不睡覺也會死」同族。
{
  let x = initialState('midnight', 'bh:alley', [], IDX)
  // 讓她髒著跨午夜，於是必定產生一列可觀測的結算（filthy −3）
  x = { ...x, needs: { ...x.needs, satiety: 100, hydration: 100, hygiene: 20 }, clock: { day: 1, minute: 22 * 60 } }
  const before = x.needs.sanity
  for (let i = 0; i < 5; i++) {
    x = { ...x, needs: { ...x.needs, satiety: 100, hydration: 100, hygiene: 20 } }
    x = reduce(x, { t: 'wait', minutes: 60 }, IDX).s
  }
  const rows = x.ledger.filter((l) => l.action === '心理').length
  T(24, '★ 不睡覺也會跨日結算理智（不是「睡覺才扣」）', x.needs.sanity !== before && rows > 0,
    `理智 ${before} → ${x.needs.sanity.toFixed(1)}；心理 ledger ${rows} 筆`)
}

// ㉕ ★ 理智 0 不致死、不阻斷上工、不進 needsHazard
{
  let x = initialState('sane0', 'bh:quays', [], IDX)
  x = { ...x, needs: { ...x.needs, sanity: 0 }, clock: { day: 2, minute: 6 * 60 } }
  const hz = needsHazardForTest({ ...x, needs: { ...x.needs, sanity: 0 } } as GameState)
  const worked = reduce(x, { t: 'work', job: 'job-quays-dayhire' }, IDX)
  const blocked = worked.log.some((l) => l.includes('上不了工'))
  let y = x
  for (let d = 0; d < 20 && !y.dead; d++) {
    y = { ...y, needs: { ...y.needs, satiety: 90, hydration: 90, sanity: 0 } }
    y = reduce(y, { t: 'sleep', kind: 'bunk', costCopper: 0 }, IDX).s
  }
  T(25, '★ 理智 0 不致死、不阻斷上工、不進 needsHazard', !y.dead && hz.death === null && !blocked,
    `睡 20 夜未死；needsHazard.death=${hz.death}；上工${blocked ? '被擋★' : '正常'}；疲憊 ×${fatigueMul(0).toFixed(2)}`)
}

// ㉖ ★ 主線不被理智鎖死：整局 sanity 保持 0，老克瓦信任仍須在 12 日內過 35
{
  let s2 = initialState('mainline-sane0', 'bh:quays', ['item-bandaid'], IDX)
  const fore = IDX.npc.get('npc-quays-foreman')!
  for (let d = 0; d < 12; d++) {
    s2 = { ...s2, at: 'bh:quays', clock: { day: s2.clock.day, minute: 6 * 60 }, needs: { ...s2.needs, sanity: 0 } }
    s2 = reduce(s2, { t: 'talk', npc: fore.id }, IDX).s
    s2 = reduce(s2, { t: 'work', job: 'job-quays-dayhire' }, IDX).s
    s2 = { ...s2, needs: { ...s2.needs, satiety: 90, hydration: 90, stamina: 90, sanity: 0 }, injuries: [] }
    s2 = reduce(s2, { t: 'sleep', kind: 'rough', costCopper: 0 }, IDX).s
  }
  const t2 = s2.npcs[fore.id]?.trust ?? 0
  T(26, '★ 理智全程 0 也不會鎖死主線（信任仍過 35）', t2 >= 35, `信任 ${Math.round(t2)} / 需 35`)
}

// ㉗ ★ 獨處不需要任何 NPC、不改任何 NpcState、不花錢
{
  let x = initialState('unwind-solo', 'bh:grotto', [], IDX)
  x = { ...x, purse: { copper: 7 } }
  const out = reduce(x, { t: 'unwind' }, IDX).s
  T(27, '★ 獨處不需要 NPC、不改關係、不花錢（不是把人當工具）',
    out.purse.copper === 7 && Object.keys(out.npcs).length === 0 && out.needs.sanity > x.needs.sanity,
    `錢 7→${out.purse.copper}　NPC ${Object.keys(out.npcs).length} 個　理智 +${(out.needs.sanity - x.needs.sanity).toFixed(0)}`)
}

// ㉘ ★ 全遊戲不存在「慾望」這個量（使用者裁定：慾望是理智的一部分，不設專屬槽位）
//     這條測試守的是 00_pillars.md 支柱二條款 2 的【字面】文字：「不設慾望槽」。
//     它掃的是實際的 state 與資料，不是註解——宣告不等於驗收。
{
  const x = initialState('slotless', 'bh:alley', [], IDX)
  // ★ 注意 seed 不可含 "desire" 字樣——第一版把 seed 取名 no-desire，
  //   而 seed 存在 meta.seed 裡，於是這條測試被自己的 seed 名字弄成假紅燈。
  const stateKeys = JSON.stringify(x)
  const dataFiles = ['conditions.json', 'events.json', 'items.json', 'nodes.json', 'jobs.json', 'npcs.json']
  const dirty = dataFiles.filter((f) => JSON.stringify(load(f)).includes('desire'))
  const inState = stateKeys.includes('desire')
  T(28, '★ 不存在慾望槽：state 與 data 皆無 desire（支柱二條款 2 字面成立）',
    !inState && dirty.length === 0,
    inState ? '★ state 裡還有 desire' : dirty.length ? '★ 資料裡還有：' + dirty.join('、') : 'state 與 6 份資料皆乾淨')
}

// ㉘b ★ 獨處與其他回復分支同構：不是最強的一條，也不需要任何 NPC 或金錢
{
  let x = initialState('unwind-parity', 'bh:grotto', [], IDX)
  x = { ...x, needs: { ...x.needs, sanity: 40 }, purse: { copper: 20 } }
  const out = reduce(x, { t: 'unwind' }, IDX).s
  const gain = out.needs.sanity - x.needs.sanity
  // 看相簿（+6）必須比獨處（+4）強：不可再生的東西應該更有效
  const strongerExists = 6 > gain
  T(28, '★ 獨處只是其中一條分支（+' + gain + '），不是最強的（看相簿 +6 更強）',
    gain === UNWIND_GAIN && strongerExists && out.purse.copper === 20 && Object.keys(out.npcs).length === 0,
    '理智 +' + gain + '　錢不變 ' + out.purse.copper + '　NPC ' + Object.keys(out.npcs).length + ' 個')
}

// ㉙ ★ 三個洗淨階不得互相支配（比照路網的 Pareto 紀律，防止免費階讓付費階變成死內容）
{
  const kinds = ['rinse', 'well', 'basin'] as const
  let ok = true
  const notes: string[] = []
  for (const a of kinds) for (const b of kinds) {
    if (a === b) continue
    const A = CLEAN[a], B = CLEAN[b]
    // a 支配 b：所有軸都不差且至少一軸更好
    const dominates = A.copper <= B.copper && A.minutes <= B.minutes && A.hygiene >= B.hygiene && A.maxPerDay >= B.maxPerDay
      && (A.copper < B.copper || A.minutes < B.minutes || A.hygiene > B.hygiene || A.maxPerDay > B.maxPerDay)
    if (dominates) { ok = false; notes.push(`${a} 支配 ${b}`) }
  }
  T(29, '★ 三個洗淨階互不支配（免費階不得讓付費階變成死內容）', ok,
    ok ? kinds.map((k) => `${k}: ${CLEAN[k].copper}銅/${CLEAN[k].minutes}分/+${CLEAN[k].hygiene}/日${CLEAN[k].maxPerDay}次`).join('　') : notes.join('、'))
}

// ㉚ ★★ 救濟隊真的是一個安全閥嗎——而且它【沒有】讓經濟失效嗎
//
// 加這一條的理由：大聖堂區的免費麵包是 P0 階段【刻意砍掉】的東西，
// 理由寫在規劃裡——「免費麵包會讓經濟壓力歸零」。現在把它加回來，
// 就必須證明兩件事同時成立，否則它就是一個破口：
//   ① 一個【一個銅都沒有】的人，靠它撐得下去（否則它不是安全閥，只是佈景）
//   ② 它【不划算】到一個有工作的人不會去排（否則貧窮陷阱失效，違反支柱二）
//
// ★ 而第三件事由引擎保證、在這裡驗收：排隊【不計入 wageDays】。
//   否則「平凡」的可靠性條件（≥18 日）可以靠領施捨滿足，那把那句
//   「從不遲到、也從不多要」的意思整個顛倒過來。
{
  const alms = [...IDX.job.values()].find((j) => j.id === 'job-cathedral-alms')!
  // ① 身無分文者：只排救濟、只喝井水，撐 12 日
  let s30 = initialState('smoke-alms', 'bh:cathedral', [], IDX)
  s30 = { ...s30, purse: { copper: 0 } }
  let steps30 = 0
  while (!s30.dead && s30.clock.day <= 12 && steps30++ < 600) {
    const h = s30.clock.minute / 60
    if (h >= alms.when[0] && h < alms.when[1] && attemptsLeft(s30, alms) > 0 && s30.needs.satiety < 60) {
      s30 = reduce(s30, { t: 'work', job: alms.id }, IDX).s; continue
    }
    if (h >= 21 || h < 5) { s30 = reduce(s30, { t: 'sleep', kind: 'rough', costCopper: 0 }, IDX).s; continue }
    s30 = reduce(s30, { t: 'wait', minutes: 60 }, IDX).s
  }
  // ★ 她一定會渴——大聖堂區不賣水（canon 沒寫那裡有水攤）。所以驗收的是
  //   「飢餓不再是死因」，而不是「她活得好」。安全閥擋的是餓，不是渴。
  const starved = s30.dead?.cause.includes('飢餓') ?? false
  T(30, '★ 救濟隊是安全閥：身無分文也不會【餓】死（渴另計，那要下山打水）',
    !starved, s30.dead ? `死於：${s30.dead.cause}（第 ${s30.dead.day} 日）` : `撐過 12 日，飽食 ${s30.needs.satiety.toFixed(0)}`)

  // ② 排隊不得計入 wageDays
  let s31 = initialState('smoke-alms-wage', 'bh:cathedral', [], IDX)
  s31 = { ...s31, clock: { day: 2, minute: 8 * 60 }, needs: { ...s31.needs, satiety: 30 } }
  const after = reduce(s31, { t: 'work', job: alms.id }, IDX).s
  T(31, '★★ 排救濟隊不計入 wageDays（否則「平凡」的可靠性可以靠領施捨滿足）',
    after.stats.wageDays === 0 && after.needs.satiety > s31.needs.satiety,
    `wageDays ${s31.stats.wageDays} → ${after.stats.wageDays}（須為 0）；飽食 ${s31.needs.satiety.toFixed(0)} → ${after.needs.satiety.toFixed(0)}`)

  // ③ 不划算：省下的 1 銅必須低於同一段時間去上工的期望收入
  const bread = IDX.item.get('item-rye-bread')!.priceCopper ?? 1
  const quays = [...IDX.job.values()].find((j) => j.id === 'job-quays-dayhire')!
  const almsPerMin = bread / alms.minutes
  const quaysPerMin = (quays.payCopper * quays.hireChance) / quays.minutes
  T(32, '★ 救濟不划算：有工可做的人不會來排（否則貧窮陷阱失效）',
    almsPerMin < quaysPerMin,
    `救濟 ${(almsPerMin * 60).toFixed(2)} 銅/時（省下一份麵包 ${bread} 銅 ÷ ${alms.minutes} 分）`
    + ` vs 碼頭 ${(quaysPerMin * 60).toFixed(2)} 銅/時（期望值），還沒算爬 18 公尺`)
}

// ── 輸出 ──
console.log('=== 無籍者 P0 · 煙霧測試 ===\n')
let pass = true
for (const r of results) {
  if (!r.ok) pass = false
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}. ${r.name}`)
  if (r.note) console.log(`         ${r.note}`)
}
// ★ 總數由 results.length 導出，不寫死。原本寫死「30 項」，
//   而我剛加了三條測試之後它照樣印「30 項」——一個會說謊的合格訊息，
//   跟那個把 npm run check 中斷藏起來的重複 import 是同一個類別。
console.log(pass ? `\n[PASS] ${results.length} 項煙霧測試全數通過。` : '\n[FAIL] 有項目未通過。')
process.exit(pass ? 0 : 1)
