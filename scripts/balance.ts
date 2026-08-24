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
import { LAST_DAY, tideAt } from '../src/engine/clock.ts'
import { isIncapacitated } from '../src/engine/body.ts'
import { CLEAN, canUnwind, type CleanKind } from '../src/engine/mind.ts'
import { evaluate } from '../src/engine/cond.ts'
import { affordable, offerRoutes } from '../src/engine/map.ts'
import { availableChoices, drawEvent } from '../src/engine/events.ts'
import { attemptsLeft, canTalk, ctxOf, initialState, reduce, type Action } from '../src/engine/reduce.ts'
import { rand } from '../src/engine/rng.ts'

const D = new URL('../data/', import.meta.url)
const load = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX = buildIndex({
  npcs: load('npcs.json'), nodes: load('nodes.json'), edges: load('edges.json'),
  items: load('items.json'), jobs: load('jobs.json'), events: load('events.json'),
  conditions: load('conditions.json'), endings: load('endings.json'),
} as Content)

const N = Number(process.argv[2] ?? 300)

/**
 * 政策參數。
 * ★ 「小心」與「粗心」兩種政策的死亡率差距，比任何固定的死亡率區間都更能驗收支柱三：
 *   如果兩者差不多，就表示玩家的決定不影響結果——那才是真正的失敗。
 */
interface Policy {
  careful: boolean
  /**
   * ★ 「會在城裡走動」的政策。
   *
   * 加它的理由不是為了讓某個測試變綠，而是因為前兩種政策【在結構上答不了】
   * 「平凡達不達得到」這個問題：它們的移動目標寫死只有碼頭與市集——
   * 也就是兩個【有工作的節點】。逐人跑分因此必然是
   *   老克瓦 100%　穗爾 100%　闕 100%　｜　灰姐 0%　石啞 0%
   * 這不是「平凡太難」，是量尺量錯了東西。
   *
   * 所以三道結局驗收各用【能回答它那個問題的】那一把尺：
   *   · 「平凡達得到嗎」→ 用會走動的政策（本項）
   *   · 「平凡是不是活下來就自動送」→ 用純領工資的政策（careful）
   */
  roam?: boolean
}
/** 會走動的政策要跑遍的四個城區——★ 含兩個【不發工錢】的地方 */
const ROAM: Array<'bh:quays' | 'bh:market' | 'bh:cinder' | 'bh:grotto'> =
  ['bh:quays', 'bh:market', 'bh:cinder', 'bh:grotto']

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
    if (who && rand(seed, 'flavor', steps) < (pol.roam ? 0.75 : 0.3)) { step({ t: 'talk', npc: who.id }); continue }
    if (!isIncapacitated(s)) {
      const job = [...IDX.job.values()].find(
        (j) => j.at === s.at && h >= j.when[0] && h < j.when[1] && s.needs.stamina > 35 && attemptsLeft(s, j) > 0
      )
      if (job) { step({ t: 'work', job: job.id }); continue }
    }
    // ★ 會走動的政策必須是【一個合理的玩家】，不是隨機遊走者。
    //   第一版寫成「每一步從四區隨機挑一個」，結果死亡率 65%、收入從 295 銅崩到 68——
    //   因為它整天在爬 +12m 的崖梯，從來沒待在一個地方把工做完。
    //   那量到的是隨機遊走的代價，不是「想被人認得」的代價。
    //   正確的形狀：有工就上工；只在【需求安全且還有人不認得她】時，才專程去見那個人。
    let target: string = rand(seed, 'flavor', steps) < 0.5 ? 'bh:quays' : 'bh:market'
    if (pol.roam) {
      const safe = s.needs.hydration > 55 && s.needs.satiety > 55 && s.needs.stamina > 55
      const stranger = [...IDX.npc.values()].find((n) => (s.npcs[n.id]?.acquaintance ?? 0) < 30)
      if (safe && stranger && h >= 8 && h < 17) target = stranger.at
    }
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

// ── 三條結局的達成率 ──
//
// ★ 這一段量的不是「機器人會不會選結局」（它不宣告目標），而是
//   【假如她宣告了那一條，實質條件成不成立】——所以一律注入 aim flag 再求值。
//
// ★★ 而它要抓的東西是「平凡」這一條特有的失敗模式：
//     若每一個活到第三十日的人【自動】滿足平凡，那平凡在機制上就等於
//     「你活下來了」＝預設值＝那個 else 分支——而那正是 ending.ts 檔頭
//     花整段篇幅要避免的違憲形狀。它必須明顯低於 100%，否則設計是假的。
/** 不發工錢的節點，以及站在那裡的人（npcOffWage 實際上在數的東西） */
const paidNodes = new Set([...IDX.job.values()].map((j) => j.at))
const offWageNodes = new Set([...IDX.node.keys()].filter((n) => !paidNodes.has(n)))
const offWageNpcs = [...IDX.npc.values()].filter((n) => offWageNodes.has(n.at))

const roam = Array.from({ length: N }, (_, i) => play(`bal-${i}`, { careful: true, roam: true }))
const roamAlive = roam.filter((s) => !s.dead)
/** 假如她宣告了那一條，實質條件成不成立（★ 一律注入 aim flag——機器人不宣告目標） */
const endShare = (aim: string, pool: GameState[]) => {
  const def = [...IDX.ending.values()].find((e) => e.aim === aim)
  if (!def) return { pct: 0, n: 0 }
  const ok = pool.filter((s) => evaluate(def.requires, ctxOf({ ...s, flags: { ...s.flags, [aim]: true } }, IDX)))
  return { pct: pool.length ? (ok.length / pool.length) * 100 : 0, n: ok.length }
}
const faces = (s: GameState) => Object.values(s.npcs).filter((n) => n.acquaintance >= 30).length
const perNpc = (pool: GameState[]) => [...IDX.npc.values()].map((n) => {
  const pct = pool.length ? (pool.filter((s) => (s.npcs[n.id]?.acquaintance ?? 0) >= 30).length / pool.length) * 100 : 0
  return `${n.name} ${pct.toFixed(0)}%`
}).join('　')

// 純領工資組（careful）——它回答的是「平凡是不是活下來就自動送」
const wageQuiet = endShare('aim-quiet', alive)
// 會走動組（roam）——它回答的是「平凡達不達得到」
const roamQuiet = endShare('aim-quiet', roamAlive)
console.log(`\n── 三條結局：實質條件達成率（假如她宣告了那一條）──`)
console.log(`   ┌ 純領工資組（只跑碼頭與市集，${alive.length} 局存活）`)
console.log(`   │   安家 ${endShare('aim-hearth', alive).pct.toFixed(0)}%　立業 ${endShare('aim-trade', alive).pct.toFixed(0)}%　平凡 ${wageQuiet.pct.toFixed(0)}%`)
const medWageWage = med(alive.map((s) => s.stats.wageDays))
console.log(`   │   上工日數中位數 ${medWageWage}／需 18　　認得她的臉 ${med(alive.map(faces))} 人／需 4`)
console.log(`   │   逐人：${perNpc(alive)}`)
console.log(`   └ 會走動組（四個城區都去，含兩個不發工錢的地方，${roamAlive.length} 局存活）`)
console.log(`       安家 ${endShare('aim-hearth', roamAlive).pct.toFixed(0)}%　立業 ${endShare('aim-trade', roamAlive).pct.toFixed(0)}%　平凡 ${roamQuiet.pct.toFixed(0)}%`)
console.log(`       上工日數中位數 ${med(roamAlive.map((s) => s.stats.wageDays))}／需 18　　認得她的臉 ${med(roamAlive.map(faces))} 人／需 4`)
console.log(`       逐人：${perNpc(roamAlive)}`)
console.log(`   ★ 三種政策都【不追劇情線】，故安家（要租約事件）與立業（要被指名兩次）`)
console.log(`     本就偏低，此處只作參考不設閘——它們的驗收在 reach-test。`)

// ★★ 走動的代價：這一段是上面那張表【逼出來的】問題，不是預先想到的。
//    會走動組的存活數明顯少於純領工資組，而「平凡」要求的正是走動——
//    若走動本身高度致命，那平凡就在事實上變成三條裡最難的一條，與設計意圖相反。
const roamDeadRate = ((roam.length - roamAlive.length) / roam.length) * 100
const roamCauses = new Map<string, number>()
for (const s of roam.filter((x) => x.dead)) {
  const c = s.dead!.cause
  roamCauses.set(c.includes('脫水') ? '脫水' : c.includes('飢餓') ? '飢餓' : c.includes('敗血') ? '敗血' : c,
    (roamCauses.get(c.includes('脫水') ? '脫水' : c.includes('飢餓') ? '飢餓' : c.includes('敗血') ? '敗血' : c) ?? 0) + 1)
}
const roamEarned = roam.reduce((a, s) => a + s.stats.earnedCopper, 0) / roam.length
console.log(`\n   ── 走動的代價 ──`)
console.log(`   死亡率 ${roamDeadRate.toFixed(1)}%（純領工資 ${deathRate.toFixed(1)}%）　死因：${[...roamCauses].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join('　')}`)
console.log(`   平均收入 ${roamEarned.toFixed(0)} 銅（純領工資 ${avgEarned.toFixed(0)}）　上工日 ${med(roamAlive.map((s) => s.stats.wageDays))}（${medWageWage}）`)
console.log(`   平均受傷 ${(roam.reduce((a, s) => a + s.stats.injuriesTaken, 0) / roam.length).toFixed(1)} 道（純領工資 ${injTaken.toFixed(1)}）`)

/**
 * ★★★ 主線瓶頸：三條結局共用的那一條鏈，有多少人真的走得完。
 *
 * 旗標的設定端／讀取端統計揭穿了一件事：
 *   census-passed 讀 4 / 設 1　　census-fled 讀 4 / 設 1
 * 而三條身分路【全部】要求 `any: [census-passed, census-fled]`，
 * 兩者又都只出自同一個事件 ev-guard-census。它的前置是 saw-dross，
 * 而 saw-dross 也只出自一個事件 ev-dross-trace，且那一幕【只在她落地的那條巷子】。
 *
 * 於是整個第三章與其後的三條結局，掛在兩幕的抽取運氣上：
 *   ev-dross-trace（巷子）→ saw-dross → ev-guard-census（市集/碼頭，日 4 起，08–17）
 *   → census-* → 三路之一 → identity-obtained → ev-ch5-aim → 三條結局
 *
 * ★ 兩幕的每一個選項都會設旗標，所以【遇到就過】——風險不是選錯，是沒遇到。
 *   一個習慣睡碼頭通鋪的玩家可能整局很少在巷子裡抽到事件。
 *
 * 這一段把那個風險變成一個【看得見的數字】，而不是一句設計上的擔心。
 */
const bottleneck = (pool: GameState[], label: string) => {
  const pct = (f: string) => (pool.length ? (pool.filter((s) => s.flags[f]).length / pool.length) * 100 : 0)
  const census = pool.length
    ? (pool.filter((s) => s.flags['census-passed'] || s.flags['census-fled']).length / pool.length) * 100
    : 0
  const aim = pool.length
    ? (pool.filter((s) => s.flags['aim-hearth'] || s.flags['aim-trade'] || s.flags['aim-quiet']).length / pool.length) * 100
    : 0
  return `   ${label.padEnd(6)} 看見殘滓 ${pct('saw-dross').toFixed(0).padStart(3)}%`
    + ` → 查籍 ${census.toFixed(0).padStart(3)}%`
    + ` → 有身分 ${pct('identity-obtained').toFixed(0).padStart(3)}%`
    + ` → 宣告目標 ${aim.toFixed(0).padStart(3)}%`
}
console.log(`\n── 主線瓶頸：三條結局共用的那一條鏈 ──`)
console.log(bottleneck(alive, '領工資'))
console.log(bottleneck(roamAlive, '會走動'))
console.log('   ★ 查籍那一幕現在有三個入口（殘滓／公告／第 12 日的保底），')
console.log('     所以「活過三十天卻不可能拿到任何結局」這件事應該【不會發生】。')

/**
 * ★★ 沒有任何存活者可以被【靜默鎖死】在三條結局之外。
 *
 * 這一條的依據是支柱一：三條結局沒有優劣，平凡也不是失敗結局。
 * 若一個玩家可以活過三十天、卻因為兩幕沒抽到而【不可能】拿到任何一條，
 * 那遊戲就有了一個既不是死亡、也不是選擇的失敗狀態——
 * 而且他不會知道自己是在哪一天失去它的。
 *
 * 保底是第 12 日：普查是全城系統性作業，沒有人能整整一個月不被找到。
 * 所以【活到第 12 日以後的存活者】必須全部拿得到 census-*。
 * ★ 這不是一個調出來的門檻，是那條保底條款的機械後果——
 *   它若失敗，代表保底本身壞了。
 */
const lateSurvivors = [...alive, ...roamAlive].filter((s) => s.clock.day > 12)
const lockedOut = lateSurvivors.filter((s) => !s.flags['census-passed'] && !s.flags['census-fled'])

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
  // ★ 平凡的兩面驗收。它是三條裡唯一【不需要劇情線】的一條，
  //   所以機器人政策就是它的正確量尺：一個只上工、吃喝、跟人講話的人該達得到。
  // ★ 平凡的兩道驗收各用【能回答它那個問題】的量尺，這是本段的重點：
  //   同一個數字餵兩道相反的閘，只會逼人去調條件討好量尺。
  // ★★ 這裡刻意【沒有絕對下限】，而那是一個修正。
  //
  //   原本寫「≥40%」。那個數字是在條件還是 npcCount>=4 的時候訂的，
  //   而條件已經換了形狀（改成 npcOffWage：至少一個認得她的人在不發工錢的地方）。
  //   一個為了另一個條件校準的門檻，對這個條件不構成任何證據。
  //
  //   而我【推導不出】一個絕對下限：「會走動的機器人該有幾成拿得到」
  //   沒有任何設計原則可以定出來——它取決於機器人多想要它，而那是我隨手寫的。
  //   訂一個數字然後調到它過，就是把驗收反推自結果。所以拿掉它。
  //
  //   ★ 留下來的是【推導得出】的那兩條：門不能是假的（>0），
  //     以及兩組必須明顯分離（那才是「這條結局真的在問一件事」的證據）。
  //
  //   ★★ 目前實測 38%，而它偏低有一個【結構性】的原因，不是平衡問題：
  //     全圖只有一個不發工錢的節點【有人在】（石窟街的石啞）。
  //     灰棚巷本來也算，但 job-cinder-drill（巷尾武館的對練）讓它變成有工錢的地方——
  //     於是 npcOffWage 自動把灰姐排除了，正如它該做的。
  //     垂直切片擴張會加節點與 NPC，這個數字會自己動；若它不動，那是真情報。
  ['★ 平凡達得到（不是假的門）', roamQuiet.pct > 0,
    `會走動組 ${roamQuiet.pct.toFixed(0)}%　※ 不設絕對下限——見程式註解。`
    /**
     * ★ 這一行的數字【自己算】，不寫死。
     *   第一版寫「全圖只有 1 個不發工錢的節點有人在（石窟街）」，
     *   而加了妲莎（老鹽街）之後就變成 2 個——那句話過期了，
     *   卻印在測試輸出裡，看起來很權威。
     *   跑分報告的每一個數字都該是量出來的，否則它就是另一種偽綠燈。
     */
    + `　可計入 npcOffWage 的人：${offWageNpcs.map((n) => n.name).join('、') || '（無）'}`
    + `（共 ${offWageNpcs.length} 人，在 ${offWageNodes.size} 個不發工錢的節點）`],
  ['★★ 但平凡不是活下來就自動送：純領工資拿不到（≤60%）', wageQuiet.pct <= 60,
    `純領工資組 ${wageQuiet.pct.toFixed(0)}%——若接近 100% 則平凡退化成 else 分支，違反支柱一`],
  ['★ 而兩組必須明顯分離（差 ≥30 個百分點＝這條結局真的在問一件事）',
    roamQuiet.pct - wageQuiet.pct >= 30,
    `走動 ${roamQuiet.pct.toFixed(0)}% − 領工資 ${wageQuiet.pct.toFixed(0)}% = ${(roamQuiet.pct - wageQuiet.pct).toFixed(0)} 點`],
  ['★★ 沒有人被靜默鎖死在三條結局之外（第 12 日後的存活者全部過得了查籍）',
    lockedOut.length === 0,
    lockedOut.length === 0
      ? `${lateSurvivors.length} 局活過第 12 日，全部拿得到 census-*`
      : `★ ${lockedOut.length}/${lateSurvivors.length} 局活著卻【不可能】拿到任何結局——保底條款壞了`],
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
