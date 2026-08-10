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
  conditions: rd('conditions.json'),
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
}

const ALL_NODES = [...IDX.node.keys()]
const HOURS = [6, 8, 11, 14, 18, 21]

/** 一個「該有的都有了」的狀態，用來測條件而不是測玩家能不能練到那裡 */
function ideal(at: NodeId, hour: number, dropFlags: string[]): GameState {
  const s = initialState('reach', at, ['item-bandaid', 'item-salve', 'item-fish-barley'], IDX)
  const flags: Record<string, boolean> = {
    'identity-obtained': true, 'path-token': true, 'saw-workshop': true,
    'bond-scribe-1': true, 'ladder-prentice-in': true, 'hollow-bench': true,
  }
  for (const f of dropFlags) delete flags[f]
  return {
    ...s, at, clock: { day: 20, minute: hour * 60 }, flags,
    needs: { ...s.needs, stamina: 90 },
    npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id,
      { acquaintance: 60, trust: 60, affection: 60, lastSeenDay: 19, knownFacts: [] }])),
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
  .filter((e) => /^ev-(ladder|named|give|ch4|ch5)-/.test(e.id))
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
