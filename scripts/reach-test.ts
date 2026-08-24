/**
 * 可達性測試：主線事件在【它應該發生的地方】真的觸發得到嗎。
 *
 * ★ 為什麼需要它，而且為什麼要帶「預期地點」對照表
 *
 * 一個事件可以在三種意義上壞掉，而前兩種既有的測試都抓不到：
 *   ① 條件寫太緊 → 永遠不會觸發（玩家看不到你寫的內容，而測試全綠）
 *   ② 條件寫太鬆 → 在錯的地方觸發
 *   ③ 內容本身不好 → 只能人玩
 *
 * ② 是最容易漏的。第一版寫第四章時，「十五分鐘」（武技階學徒考核）與
 * 「你打的那批我簽名」兩個事件【都忘了綁地點】——於是武館的考核會在她自己的巷子裡發生，
 * 寂裔長老的簽名會在碼頭發生。資料驗證不會抓（參照都合法），
 * 煙霧測試不會抓（它只問玩得下去），而它讀起來完全不對。
 *
 * 所以這裡把「預期地點」寫成表，讓它變成可驗收的斷言而不是讀輸出時的直覺。
 * 這是「文件也要被測試」的同一個做法（比照單元測試 ⑧ 對 conditions.json 的數字）。
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState, type NodeId } from '../src/engine/types.ts'
import { evaluate } from '../src/engine/cond.ts'
import { candidates } from '../src/engine/events.ts'
import { ctxOf, initialState } from '../src/engine/reduce.ts'

const D = new URL('../data/', import.meta.url)
const rd = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX = buildIndex({
  npcs: rd('npcs.json'), nodes: rd('nodes.json'), edges: rd('edges.json'),
  items: rd('items.json'), jobs: rd('jobs.json'), events: rd('events.json'),
  conditions: rd('conditions.json'), endings: rd('endings.json'),
} as Content)

/**
 * 預期地點。`null` = 刻意與地點無關（身體、隨身物之類）。
 * ★ 新增主線事件時必須在這裡登記一行，否則測試會說「未登記」。
 */
const EXPECT: Record<string, NodeId[] | null> = {
  'ev-ch4-open': null,
  'ev-ladder-lyceum-notice': ['bh:market'],
  'ev-ladder-iron-counter': ['bh:quays'],
  'ev-ladder-prentice-intro': ['bh:cinder'],
  'ev-ladder-prentice-test': ['bh:cinder'],
  'ev-ladder-hollow-bench': ['bh:grotto'],
  'ev-ladder-hollow-sign': ['bh:grotto'],
  'ev-named-wound': ['bh:alley', 'bh:quays'],
  'ev-named-letter': ['bh:market'],
  'ev-named-count': ['bh:grotto', 'bh:pans'],
  'ev-give-soup': ['bh:cinder'],
  'ev-give-cloth': ['bh:alley', 'bh:quays'],
  'ev-give-slot': ['bh:quays'],
  // 第五章
  'ev-ch5-aim': null,            // 宣告目標——與地點無關，她在哪裡都會想到這件事
  'ev-lease-sign': ['bh:alley'], // 老鹽街的單間就在她落地的那條巷子上面
  // ★ 不在上面那條 regex 的強制名單內，但它是一條【收口事件】：
  //   在它之前，玩家可以把那片滓一路帶到第三十日而什麼都不會再發生。
  //   收口事件最容易寫死（條件一緊就永遠不觸發，而玩家不會知道自己漏了什麼），
  //   所以照樣登記一行讓它被機械驗收。
  'ev-dross-settle': ['bh:alley'], // 她落地的那面牆——「埋回原來的地方」只有在這裡成立
  /**
   * ★★ 三個教學事件。它們【一個都沒有被登記過】，而它們是 learned 邊唯一的來源——
   *    教學事件寫死了，那條邊就在地圖上以虛線永久釣著玩家。
   *    e:grotto-cathedral-cliffpath 真的發生過這件事（加邊當天沒有任何來源教它）。
   */
  // ★ 只在巷子那一端教。魚巷是「掛滿魚乾的竹架」，而那個場景屬於老鹽街那一頭；
  //   碼頭那一端沒有對應的教學場景（登記時我先寫了兩端，測試立刻指出來）。
  'ev-learn-fishlane': ['bh:alley'],
  'ev-learn-grotto-stair': ['bh:grotto'],        // 石階藏在石窟街這頭的貨棚縫裡
  'ev-learn-cliffpath': ['bh:grotto'],           // 推車從石窟街這頭出發上崖

  /**
   * ★★ 以下 22 個是把強制登記的判準【從命名改成結構】之後補進來的。
   *
   * 舊判準是一條 regex（`^ev-(ladder|named|give|learn|ch4|ch5|lease|end)-`），
   * 等於讓內容作者用取名決定自己要不要被驗收——對抗式稽核的 21 項裡，
   * 它出現 8 次當作「為什麼別的閘沒抓到」。
   *
   * 新判準是可推導的：一個事件若【設了某個別的事件或結局會讀的旗標】，
   * 或【教一條 learned 邊】，它就是主線——因為它的位置會影響進程。
   * 實測：結構上 39 個主線事件，而舊 regex 只圈到 19 個。
   *
   * ★ 這裡的地點取自各事件【自己宣告的 where.at】，不是從測試結果反推。
   *   斷言因此是「它只在它宣告的地方觸發，不在別處」，
   *   而日後有人放寬某個 where 時，這張表會逼他明確更新一行。
   */
  'ev-buy-local-clothes': ['bh:market'],
  'ev-night-alley-followed': ['bh:alley', 'bh:cinder'],
  'ev-cinder-ledger': ['bh:cinder'],
  'ev-dross-trace': ['bh:alley'],
  'ev-dross-asked': ['bh:cinder'],
  'ev-census-notice': ['bh:market'],
  'ev-dross-appraise-grotto': ['bh:grotto'],
  'ev-dross-buyer': ['bh:cinder'],
  'ev-guard-census': ['bh:market', 'bh:quays'],
  'ev-path-token': ['bh:quays'],
  'ev-path-forge': ['bh:cinder'],
  'ev-path-vouch': ['bh:grotto'],
  'ev-scribe-letters': ['bh:market'],
  'ev-scribe-choice': ['bh:market'],
  'ev-hand-ticket': ['bh:quays'],
  'ev-hand-choice': ['bh:quays'],
  'ev-foreman-fingers': ['bh:quays'],
  'ev-cinder-child': ['bh:cinder'],
  'ev-grotto-handsign': ['bh:grotto'],
  'ev-pans-shard': ['bh:pans'],
  'ev-grotto-workshop': ['bh:grotto'],
  'ev-cathedral-curfew': ['bh:cathedral'],
}

const ALL_NODES = [...IDX.node.keys()]
/**
 * ★ 時刻表要涵蓋跨午夜的時窗。
 *   舊版最晚只到 21 點，於是 `when: { hours: [22, 4] }` 的事件
 *   （身後的腳步聲）在任何時刻都不成立，被誤報成「條件寫太緊」。
 *   與 live-reach 用同一組代表時刻。
 */
const HOURS = [0, 3, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 21, 22, 23]

/**
 * ★★★ 理想狀態的旗標與物品【由 live-reach 的不動點閉包導出】，不再手寫。
 *
 * 這是第四次修同一種缺陷：手寫的 god-state 漏一個旗標，
 * 一個好內容就被誤報成「玩家永遠看不到它」。
 * 前三次分別漏了那片殘滓、bond-grotto-1，這一次一口氣漏了
 * census-passed／census-fled／dross-lead／bond-hand-1／on-cinder-ledger。
 *
 * 手寫清單這個形狀已經證明會週期性腐爛——就跟那條以命名為條件的 regex 一樣。
 * 而 live-reach 的閉包本來就是「玩家拿得到的全部旗標與物品」，
 * 它是【推導出來的】而且會自己跟著內容長大。
 *
 * ★ 缺檔一律報錯而不是靜默退回手寫清單：
 *   一道靜默退化的檢查比沒有檢查更貴（anchor 那一課）。
 */
const CLOSURE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../_build/reach-closure.json', import.meta.url), 'utf-8')) as {
      flags: string[]; ownedItems: string[]
    }
  } catch {
    console.error('★ 找不到 _build/reach-closure.json —— 請先跑 npm run live-reach。')
    console.error('  這份可達性測試的理想狀態由那份閉包導出，缺了它就無法進行'
      + '（刻意不退回手寫清單：手寫清單漏旗標已經誤報過四次）。')
    process.exit(1)
  }
})()
/** ★ 理想狀態的日子要晚到足以涵蓋第五章（day>=24），錢要夠付租約（60 銅） */
const IDEAL_DAY = 28
const IDEAL_COPPER = 200

/** 一個「該有的都有了」的狀態，用來測條件而不是測玩家能不能練到那裡 */
function ideal(at: NodeId, hour: number, dropFlags: string[]): GameState {
  const s = initialState('reach', at, [], IDX)
  // 旗標與物品一律取自閉包，再扣掉這個事件【自己否定的】那些（selfGuards）
  const flags: Record<string, boolean> = {}
  for (const f of CLOSURE.flags) flags[f] = true
  for (const f of dropFlags) delete flags[f]
  const carry = CLOSURE.ownedItems.map((item) => ({ item: item as never, count: 9 }))
  return {
    ...s, at, carry, clock: { day: IDEAL_DAY, minute: hour * 60 }, flags,
    purse: { copper: IDEAL_COPPER },
    needs: { satiety: 90, hydration: 90, stamina: 90, warmth: 90, hygiene: 90, sanity: 90 },
    npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id,
      { acquaintance: 90, trust: 90, affection: 90, lastSeenDay: IDEAL_DAY - 1, knownFacts: [] }])),
  }
}

/** 事件自己的「已完成就不再出現」守衛所指的 flag —— 測試必須把它們拿掉 */
function selfGuards(ev: { requires?: unknown; where?: unknown; when?: unknown }): string[] {
  const out: string[] = []
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return
    const o = c as Record<string, unknown>
    const n = o.not as Record<string, unknown> | undefined
    if (n && typeof n.flag === 'string') out.push(n.flag)
    if (n && Array.isArray(n.any)) for (const x of n.any as Array<Record<string, unknown>>) {
      if (typeof x.flag === 'string') out.push(x.flag)
    }
    for (const k of ['all', 'any']) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(walk)
    if (o.not) walk(o.not)
  }
  walk(ev.requires); walk(ev.where); walk(ev.when)
  return out
}

function firesAt(id: string): NodeId[] {
  const ev = IDX.event.get(id)
  if (!ev) return []
  const drop = selfGuards(ev)
  const hits: NodeId[] = []
  for (const at of ALL_NODES) {
    for (const h of HOURS) {
      const s = ideal(at, h, drop)
      const ctx = ctxOf(s, IDX)
      if (evaluate(ev.where, ctx) && evaluate(ev.when, ctx) && evaluate(ev.requires, ctx)
        && candidates(s, IDX, ctx).some((e) => e.id === id)) { hits.push(at); break }
    }
  }
  return hits
}

const problems: string[] = []
const rows: string[] = []

for (const [id, expect] of Object.entries(EXPECT)) {
  if (!IDX.event.has(id)) { problems.push(`${id}：事件不存在`); continue }
  const hits = firesAt(id)
  const names = hits.map((n) => IDX.node.get(n)!.name)

  if (hits.length === 0) {
    problems.push(`${id}：★ 在任何節點×時段都不可達——條件寫太緊，玩家永遠看不到它`)
    rows.push(`  ★不可達  ${id}`)
    continue
  }
  if (expect === null) {
    rows.push(`  OK（無地點）  ${id.padEnd(26)} ${names.length} 個節點`)
    continue
  }
  const missing = expect.filter((n) => !hits.includes(n))
  const extra = hits.filter((n) => !expect.includes(n))
  if (missing.length) problems.push(`${id}：在預期地點 ${missing.map((n) => IDX.node.get(n)!.name).join('／')} 不可達`)
  if (extra.length) problems.push(`${id}：★ 在不該發生的地方也會觸發：${extra.map((n) => IDX.node.get(n)!.name).join('／')}——條件寫太鬆`)
  rows.push(`  ${missing.length || extra.length ? '★' : 'OK'}  ${id.padEnd(26)} ${names.join('／')}`)
}

// 未登記的主線事件（★ 或 ev-ladder-/ev-named-/ev-give- 開頭者）必須在 EXPECT 裡有一行
/**
 * ★★★ 強制登記的判準：從【命名】改成【結構】。
 *
 * 舊版是一條 regex（`^ev-(ladder|named|give|learn|ch4|ch5|lease|end)-`），
 * 而那是一個以 id 命名為條件的覆蓋白名單——等於讓內容作者用取名
 * 決定自己要不要被驗收。對抗式稽核的 21 項裡它出現 8 次當作
 * 「為什麼別的閘沒抓到」，是全份報告裡最常被引用的那一個漏洞。
 *
 * 新判準可推導、不能靠取名規避：
 *   ① 它教一條 learned 邊（那條邊的存廢全靠它）
 *   ② 它設的旗標【被別的事件或結局讀取】（也就是它影響進程）
 * 只是氛圍紋理的事件（設的旗標沒人讀、或根本不設旗標）不需要登記。
 *
 * ★ 「每一個事件都至少進得了候選池」現在由 live-reach 的 R3 全面守著，
 *   所以這裡專責的是另一件事：【它有沒有在不該發生的地方發生】。
 *   兩者互補——R3 問可達性，EXPECT 問位置正確性。
 */
const flagReaders = (() => {
  const read = new Set<string>()
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return
    const o = c as Record<string, unknown>
    if (typeof o.flag === 'string') read.add(o.flag)
    for (const k of ['all', 'any']) {
      if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(walk)
    }
    if (o.not) walk(o.not)
  }
  for (const e of IDX.event.values()) {
    walk(e.where); walk(e.when); walk(e.requires)
    for (const c of e.choices) walk(c.requires)
  }
  for (const e of IDX.ending.values()) walk(e.requires)
  return read
})()
const isMainline = (e: { choices: Array<{ gain?: { learnRoute?: string; flag?: string | string[] } }> }) => {
  for (const c of e.choices) {
    if (c.gain?.learnRoute) return true
    for (const f of [c.gain?.flag ?? []].flat()) if (flagReaders.has(f as string)) return true
  }
  return false
}
const shouldRegister = [...IDX.event.values()]
  .filter((e) => isMainline(e))
  .filter((e) => !(e.id in EXPECT))
for (const e of shouldRegister) problems.push(`${e.id}：主線事件但未登記預期地點（在 EXPECT 加一行）`)

console.log('=== 無籍者 · 主線事件可達性 ===\n')
for (const r of rows) console.log(r)
if (problems.length) {
  console.log('\n★ 問題：')
  for (const p of problems) console.log('  x ' + p)
  console.log('\n[FAIL] 可達性測試未通過。')
  process.exit(1)
}
console.log(`\n[PASS] ${Object.keys(EXPECT).length} 個主線事件全部在預期地點可達，且不在別處誤觸發。`)
