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
}

const ALL_NODES = [...IDX.node.keys()]
const HOURS = [6, 8, 11, 14, 18, 21]
/** ★ 理想狀態的日子要晚到足以涵蓋第五章（day>=24），錢要夠付租約（60 銅） */
const IDEAL_DAY = 28
const IDEAL_COPPER = 200

/** 一個「該有的都有了」的狀態，用來測條件而不是測玩家能不能練到那裡 */
function ideal(at: NodeId, hour: number, dropFlags: string[]): GameState {
  // ★ 那片滓要帶著：ev-dross-settle 要 has(item-dross-shard)。
  //   拒賣一路帶到第 28 日在遊戲中完全達得到（ev-dross-buyer 的「說不賣」分支），
  //   所以理想狀態本來就該有它——第一版漏了它，於是收口事件被判「不可達」。
  const s = initialState('reach', at, ['item-bandaid', 'item-salve', 'item-fish-barley'], IDX)
  const carry = [...s.carry, { item: 'item-dross-shard' as const, n: 1 }]
  const flags: Record<string, boolean> = {
    'identity-obtained': true, 'path-token': true, 'saw-workshop': true,
    'bond-scribe-1': true, 'ladder-prentice-in': true, 'hollow-bench': true,
    // ★ 手語。ev-learn-cliffpath 以它為門檻，而理想狀態漏了它 → 該事件被判「不可達」。
    //   它在遊戲中拿得到（石窟街的手語事件），所以理想狀態本來就該有。
    //   這是第二次同型的量尺缺件（第一次是漏帶那片殘滓）。
    'bond-grotto-1': true,
    'dross-identified': true, 'saw-dross': true,
    // 三個目標旗標都給——ev-ch5-aim 的自我守衛（not any[aim-*]）會自動把它們拿掉，
    // 而 ev-lease-sign 需要 aim-hearth。
    'aim-hearth': true, 'aim-trade': true, 'aim-quiet': true,
  }
  for (const f of dropFlags) delete flags[f]
  return {
    ...s, at, carry, clock: { day: IDEAL_DAY, minute: hour * 60 }, flags,
    purse: { copper: IDEAL_COPPER },
    needs: { ...s.needs, stamina: 90 },
    npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id,
      { acquaintance: 60, trust: 60, affection: 60, lastSeenDay: IDEAL_DAY - 1, knownFacts: [] }])),
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
const shouldRegister = [...IDX.event.values()]
  /**
   * ★★ 這條 regex 是一個【以 id 命名為條件的覆蓋白名單】——
   *    等於讓內容作者用取名決定自己要不要被驗收。
   *    對抗式攻擊的 21 項裡，它出現 8 次當作「為什麼別的閘沒抓到」。
   *
   * 補上 learn 是因為三個 ev-learn-* 教學事件【一個都沒有登記】，
   * 而它們是 learned 邊唯一的來源：教學事件寫死了，那條邊就永久釣著玩家。
   *
   * ★ 這只是止血。正解是「每一個事件都必須可達」，而那需要行為式的不動點閉包
   *   （live-reach 的 R3），排在下一步。到那時這條 regex 就該整條刪掉。
   */
  .filter((e) => /^ev-(ladder|named|give|learn|ch4|ch5|lease|end)-/.test(e.id))
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
