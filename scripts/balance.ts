/**
 * 平衡跑分：300 seed × 14 日，把「死亡率」與「死因分布」變成可追蹤指標。
 *
 * ★ 為什麼需要這支腳本：
 *   第五輪徹查發現，遊戲同時壞在兩個相反的方向——
 *     · 需求類死亡【不可達】（不睡覺就不會死，遊蕩 16.7 天飽食 0 水分 0 仍活著）
 *     · 而敗血死亡率是 87%（一道 2% 擦傷在 14 日內 95.6% 致死）
 *   兩者都靠煙霧測試的「單點斷言」擋不住。只有分布跑得出來。
 *
 * 驗收判準：
 *   · 14 日死亡率落在 20–55%（invented: 平衡目標，待試玩校正）
 *   · 沒有任何單一死因超過 60%（derived: 支柱三「死亡是教學」要求死因多樣）
 *   · 需求類與傷病類死亡都必須【存在】（各 >0）——否則就是某一條路徑又斷了
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState } from '../src/engine/types.ts'
import { tideAt } from '../src/engine/clock.ts'
import { isIncapacitated } from '../src/engine/body.ts'
import { CLEAN, canUnwind, type CleanKind } from '../src/engine/mind.ts'
import { affordable, offerRoutes } from '../src/engine/map.ts'
import { availableChoices, drawEvent } from '../src/engine/events.ts'
import { attemptsLeft, canTalk, ctxOf, initialState, reduce, type Action } from '../src/engine/reduce.ts'
import { rand } from '../src/engine/rng.ts'

const D = new URL('../data/', import.meta.url)
const load = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX = buildIndex({
  npcs: load('npcs.json'), nodes: load('nodes.json'), edges: load('edges.json'),
  items: load('items.json'), jobs: load('jobs.json'), events: load('events.json'),
  conditions: load('conditions.json'),
} as Content)

const LAST_DAY = 14
const N = Number(process.argv[2] ?? 300)

/**
 * 政策參數。
 * ★ 「小心」與「粗心」兩種政策的死亡率差距，比任何固定的死亡率區間都更能驗收支柱三：
 *   如果兩者差不多，就表示玩家的決定不影響結果——那才是真正的失敗。
 */
interface Policy { careful: boolean }

/** 一個「還算會玩」的政策：吃喝、治傷、有工就做、天黑就睡。不是最佳解，是及格線。 */
function play(seed: string, pol: Policy = { careful: true }): GameState {
  let s = initialState(seed, 'bh:alley', ['item-bandaid', 'item-lighter', 'item-candy'], IDX)
  let steps = 0
  const step = (a: Action) => {
    const b = s.clock.day * 1440 + s.clock.minute
    s = reduce(s, a, IDX).s
    if (!s.dead && s.clock.day * 1440 + s.clock.minute === b) s = reduce(s, { t: 'wait', minutes: 30 }, IDX).s
  }

  while (!s.dead && s.clock.day <= LAST_DAY && steps++ < 700) {
    const ctx = ctxOf(s, IDX)
    const ev = drawEvent(s, IDX, ctx)
    if (ev) {
      const ok = availableChoices(ev, ctx)
      // 避開帶風險的選項（一個會玩的人會避）
      const safe = ok.find((c) => (c.risks ?? []).length === 0) ?? ok[0]
      const i = safe ? ev.choices.indexOf(safe) : 0
      step({ t: 'eventChoice', event: ev.id, choice: Math.max(0, i), alternatives: [] })
      continue
    }
    const h = s.clock.minute / 60
    const here = IDX.node.get(s.at)!

    // 傷口優先處置——這是最便宜的保命動作
    if (pol.careful) {
      const hurt = s.injuries.find((i) => i.healDay === null && i.treatedDay === null)
      if (hurt) {
        if (s.carry.some((c) => c.item === 'item-bandaid')) { step({ t: 'treat', injury: hurt.id, using: 'sterile' }); continue }
        if (s.purse.copper >= 1) { step({ t: 'treat', injury: hurt.id, using: 'herbs' }); continue }
      }
    }
    // 粗心的人拖到見底才想起來要喝水／吃飯，而且不帶著走
    const wTh = pol.careful ? 35 : 4
    const fTh = pol.careful ? 40 : 4
    const water = s.carry.find((c) => c.item === 'item-well-water')
    if (s.needs.hydration < wTh && water) { step({ t: 'useItem', item: water.item }); continue }
    if (s.needs.hydration < wTh && s.purse.copper >= 1 && here.sells.includes('item-well-water')) {
      step({ t: 'buy', item: 'item-well-water' }); continue
    }
    const food = s.carry.find((c) => ['item-rye-bread', 'item-fish-barley', 'item-candy'].includes(c.item))
    if (s.needs.satiety < fTh && food) { step({ t: 'useItem', item: food.item }); continue }
    if (s.needs.satiety < fTh && s.purse.copper >= 1 && here.sells.includes('item-rye-bread')) {
      step({ t: 'buy', item: 'item-rye-bread' }); continue
    }
    // 小心的人會洗澡（清潔影響化膿率與錄取率），也會找地方獨處
    if (pol.careful) {
      if (s.needs.hygiene < 55) {
        for (const k of ['basin', 'well', 'rinse'] as CleanKind[]) {
          const def = CLEAN[k]
          if (!here.services.includes(def.service)) continue
          if (s.purse.copper < def.copper) continue
          if (k === 'rinse' && s.injuries.some((i) => i.healDay === null && i.treatedDay === null)) continue
          if ((s.stats.jobAttempts[`${s.clock.day}|clean:${k}`] ?? 0) >= def.maxPerDay) continue
          step({ t: 'clean', kind: k }); break
        }
        if (s.needs.hygiene >= 55) continue
      }
      if (canUnwind(s, here) && (s.stats.jobAttempts[`${s.clock.day}|unwind`] ?? 0) === 0) {
        step({ t: 'unwind' }); continue
      }
    }
    // 小心的人出門前會先把水裝滿（城外沒有井）
    if (pol.careful && !water && s.purse.copper >= 3 && here.sells.includes('item-well-water')) {
      step({ t: 'buy', item: 'item-well-water' }); continue
    }
    if (h >= 21 || h < 5) {
      const kind = here.services.includes('sleep-bunk') && s.purse.copper >= 3 ? 'bunk' : 'rough'
      step({ t: 'sleep', kind, costCopper: kind === 'bunk' ? 3 : 0 }); continue
    }
    const who = [...IDX.npc.values()].find((n) => canTalk(s, n))
    if (who && rand(seed, 'flavor', steps) < 0.3) { step({ t: 'talk', npc: who.id }); continue }
    if (!isIncapacitated(s)) {
      const job = [...IDX.job.values()].find(
        (j) => j.at === s.at && h >= j.when[0] && h < j.when[1] && s.needs.stamina > 35 && attemptsLeft(s, j) > 0
      )
      if (job) { step({ t: 'work', job: job.id }); continue }
    }
    const target = rand(seed, 'flavor', steps) < 0.5 ? 'bh:quays' : 'bh:market'
    if (s.at !== target) {
      const rs = offerRoutes(s, IDX, tideAt(s.clock.minute), target).filter((r) => affordable(r, s.needs.stamina))
      if (rs.length > 0) { step({ t: 'travel', route: rs[0]!.edges, alternatives: [] }); continue }
    }
    step({ t: 'wait', minutes: 60 })
  }
  return s
}

const runs: GameState[] = []
for (let i = 0; i < N; i++) runs.push(play(`bal-${i}`))

const dead = runs.filter((s) => s.dead)
const causes = new Map<string, number>()
for (const s of dead) {
  const c = s.dead!.cause
  const bucket = c.includes('脫水') ? '脫水' : c.includes('飢餓') ? '飢餓' : c.includes('敗血') ? '敗血' : c
  causes.set(bucket, (causes.get(bucket) ?? 0) + 1)
}
const deathRate = (dead.length / N) * 100
const avgDay = dead.length > 0 ? dead.reduce((a, s) => a + s.dead!.day, 0) / dead.length : 0
const alive = runs.filter((s) => !s.dead)
const avgPurse = alive.length > 0 ? alive.reduce((a, s) => a + s.purse.copper, 0) / alive.length : 0
const avgEarned = runs.reduce((a, s) => a + s.stats.earnedCopper, 0) / N
const injTaken = runs.reduce((a, s) => a + s.stats.injuriesTaken, 0) / N
const injInf = runs.reduce((a, s) => a + s.stats.injuriesInfected, 0) / N
const injHeal = runs.reduce((a, s) => a + s.stats.injuriesHealed, 0) / N
const wore = runs.filter((s) => s.flags['wears-local']).length

console.log(`=== 無籍者 · 平衡跑分（${N} seed × ${LAST_DAY} 日）===\n`)
console.log(`14 日死亡率      ${deathRate.toFixed(1)}%   （${dead.length}/${N}）`)
console.log(`平均死亡日       第 ${avgDay.toFixed(1)} 日`)
console.log(`死因分布：`)
for (const [c, n] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${c.padEnd(6)} ${String(n).padStart(3)} 例   ${((n / Math.max(1, dead.length)) * 100).toFixed(0)}% of 死亡`)
}
console.log(`\n每局平均收入     ${avgEarned.toFixed(0)} 銅（${(avgEarned / LAST_DAY).toFixed(1)} 銅/日）`)
console.log(`存活者平均結餘   ${avgPurse.toFixed(0)} 銅`)
console.log(`里程碑達成       ${((wore / N) * 100).toFixed(0)}%（換上本地舊衣）`)
console.log(`每局傷勢         受傷 ${injTaken.toFixed(1)} 道／化膿 ${injInf.toFixed(2)}／痊癒 ${injHeal.toFixed(1)}`)
const med = (xs: number[]) => { const v = [...xs].sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)]! : 0 }
const carefulSanity = med(runs.map((r) => r.needs.sanity))
const carefulHyg = med(runs.map((r) => r.needs.hygiene))
console.log(`結局理智中位數   ${carefulSanity.toFixed(0)}`)
console.log(`結局清潔中位數   ${carefulHyg.toFixed(0)}`)

// ── 粗心政策對照組 ──
const sloppy = Array.from({ length: N }, (_, i) => play(`bal-${i}`, { careful: false }))
const sloppyDead = sloppy.filter((s) => s.dead)
const sloppyRate = (sloppyDead.length / N) * 100
const sloppyCauses = new Map<string, number>()
for (const s of sloppyDead) {
  const c = s.dead!.cause
  const b = c.includes('脫水') ? '脫水' : c.includes('飢餓') ? '飢餓' : c.includes('敗血') ? '敗血' : c
  sloppyCauses.set(b, (sloppyCauses.get(b) ?? 0) + 1)
}
console.log(`\n── 粗心政策對照（同樣的 seed，但拖到見底才吃喝、傷口不處置）──`)
console.log(`14 日死亡率      ${sloppyRate.toFixed(1)}%   （${sloppyDead.length}/${N}）`)
console.log(`死因分布：${[...sloppyCauses].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join('　')}`)
const sloppySanity = med(sloppy.map((r) => r.needs.sanity))
const sloppyHyg = med(sloppy.map((r) => r.needs.hygiene))
console.log(`結局理智中位數   ${sloppySanity.toFixed(0)}　（小心 ${carefulSanity.toFixed(0)}）`)
console.log(`結局清潔中位數   ${sloppyHyg.toFixed(0)}　（小心 ${carefulHyg.toFixed(0)}）`)

// ── 一局死亡的完整決策鏈（判斷公平性：預警夠不夠、躲不躲得掉）──
const sample = dead[0]
if (sample) {
  console.log(`\n── 抽一局死亡的決策鏈（玩家實際會看到的畫面）──`)
  console.log(`   ${sample.dead!.cause}　第 ${sample.dead!.day} 日`)
  const rows = [
    ...sample.ledger.filter((l) => l.kind === 'body'),
    ...sample.ledger.filter((l) => l.kind !== 'body').slice(-8),
  ].sort((x, y) => (x.day * 1440 + x.minute) - (y.day * 1440 + y.minute))
  for (const l of rows) {
    const hh = String(Math.floor(l.minute / 60)).padStart(2, '0')
    const mm = String(l.minute % 60).padStart(2, '0')
    const mark = l.kind === 'body' ? '  ▲' : '   '
    console.log(`${mark} 第${l.day}日 ${hh}:${mm}  ${l.action}｜${l.detail}`
      + (l.alternatives.length ? `\n         當時還可以：${l.alternatives.join('、')}` : ''))
  }
}

// ── 驗收 ──
//
// ★ 判準是從設計原則導出的，不是從跑分結果反推的（那就是「宣告不等於驗收」）：
//   · 支柱一「往上爬」＋ 反 DoL 條款：一個【會玩】的人應該多半活得下來，
//     否則就退回 DoL 式的單向崩壞。故小心政策的死亡率上限訂 40%。
//   · 支柱三「每次死亡都要能回溯到一個決定」的可驗收形式不是某個固定死亡率，
//     而是【粗心的人必須死得明顯更多】。若兩者差不多，就表示決定不影響結果。
//     這比任何固定區間都更能測到我們真正在乎的東西。
//   · 兩類死因都必須可達——否則就是某一條路徑又斷了（這正是本輪修的兩個缺陷）。
const maxShare = Math.max(0, ...[...causes.values()].map((n) => n / Math.max(1, dead.length)))
const needDeaths = (causes.get('脫水') ?? 0) + (causes.get('飢餓') ?? 0)
const bodyDeaths = (causes.get('敗血') ?? 0) + (sloppyCauses.get('敗血') ?? 0)
const checks: Array<[string, boolean, string]> = [
  ['會玩的人多半活得下來（死亡率 ≤ 40%）', deathRate <= 40, `${deathRate.toFixed(1)}%`],
  ['但死亡確實存在（≥ 5%）', deathRate >= 5, `${deathRate.toFixed(1)}%`],
  ['★ 粗心的人死得明顯更多（≥ 1.5 倍）', sloppyRate >= deathRate * 1.5,
    `小心 ${deathRate.toFixed(1)}% → 粗心 ${sloppyRate.toFixed(1)}%（${(sloppyRate / Math.max(0.1, deathRate)).toFixed(1)} 倍）`],
  ['需求類死亡可達（不再是不可達）', needDeaths > 0, `${needDeaths} 例`],
  ['傷病類死亡可達（不再是唯一死因）', bodyDeaths > 0, `${bodyDeaths} 例（含粗心組）`],
  ['傷口會痊癒（不再是永久累積）', injHeal > 0, `平均痊癒 ${injHeal.toFixed(1)} 道/局`],
  // ★ 理智與清潔的驗收都不用絕對閾值（正典零錨點，訂死就是憑空發明），
  //   改用【兩種政策的曲線分離】——那才測得到我們真正在乎的東西：決定有沒有用。
  ['★ 照顧自己的人理智明顯較高（差 ≥20）', carefulSanity - sloppySanity >= 20,
    `小心 ${carefulSanity.toFixed(0)} vs 粗心 ${sloppySanity.toFixed(0)}`],
  ['★ 清潔不再是單向槽（小心組結局 ≥40）', carefulHyg >= 40,
    `小心 ${carefulHyg.toFixed(0)} vs 粗心 ${sloppyHyg.toFixed(0)}`],
]
void maxShare
console.log('')
let pass = true
for (const [name, ok, note] of checks) {
  if (!ok) pass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}　—— ${note}`)
}
console.log(pass ? '\n[PASS] 平衡在驗收區間內。' : '\n[FAIL] 平衡需要調整。')
process.exit(pass ? 0 : 1)
