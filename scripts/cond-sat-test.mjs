/**
 * cond-sat 的單元測試。
 *
 * ★★ 這份測試的重點在【誤報方向】，而不是漏判方向。
 *
 * F 節（對抗式攻擊報告）的原話：「寧可漏判不可誤判——它只在可證明恆假時說話。」
 * 一個會誤報的可滿足性判定會逼人去放寬它，而放寬幾次之後它就什麼都抓不到了。
 * 所以下面【可滿足】那一組比【恆假】那一組更重要：
 * 恆假漏一個只是少擋一次，可滿足誤報一個會讓整道閘被拆掉。
 */

import { unsat } from './cond-sat.mjs'

const ENV = { lastDay: 30, npcTotal: 8, offWageTotal: 3 }
const rows = []
const T = (name, ok, note = '') => rows.push({ name, ok, note })

/** 必須回 null（可能為真）——誤報這些就是把好內容擋掉 */
const SAT = [
  ['單一時窗', { hours: [6, 9] }],
  ['時窗有交集', { all: [{ hours: [6, 9] }, { hours: [8, 12] }] }],
  ['跨午夜時窗與夜間時窗有交集', { all: [{ hours: [22, 4] }, { hours: [23, 2] }] }],
  ['同一地點兩次', { all: [{ at: 'bh:alley' }, { at: ['bh:alley', 'bh:quays'] }] }],
  ['day 在局內', { all: [{ day: '>=3' }, { day: '<28' }] }],
  ['day 邊界剛好可行', { day: '>=30' }],
  ['wageDays 剛好等於局長', { wageDays: '>=30' }],
  ['npcCount 等於名冊人數', { npcCount: { axis: 'acquaintance', is: '>=30', atLeast: 8 } }],
  ['npcOffWage 等於上限', { npcOffWage: { axis: 'acquaintance', is: '>=30', atLeast: 3 } }],
  ['持有 X 且不持有 Y', { all: [{ has: { item: 'item-a' } }, { not: { has: { item: 'item-b' } } }] }],
  ['知道 X 且不知道 Y', { all: [{ knowsRoute: 'e:a' }, { not: { knowsRoute: 'e:b' } }] }],
  ['flag 正反不同鍵', { all: [{ flag: 'a' }, { not: { flag: 'b' } }] }],
  ['★ 教學事件的標準寫法（教 X 且尚未知道 X）',
    { all: [{ at: 'bh:grotto' }, { not: { knowsRoute: 'e:x' } }] }],
  ['any 有一支可行', { any: [{ hours: [6, 7] }, { hours: [0, 24] }] }],
  ['★ any 底下的兩支互斥【不算】恆假（那是聯集）',
    { any: [{ at: 'bh:alley' }, { at: 'bh:quays' }] }],
  ['巢狀 all 內仍有交集', { all: [{ all: [{ hours: [6, 12] }] }, { hours: [8, 10] }] }],
  ['空條件', {}],
  ['不認識的比較式不猜（回 null）', { day: '大約三天' }],
  ['★ 真實內容：end-quiet 的條件形狀',
    { all: [{ flag: 'aim-quiet' }, { day: '>=28' }, { not: { injury: { untreated: true } } },
      { wageDays: '>=18' }, { npcCount: { axis: 'acquaintance', is: '>=30', atLeast: 4 } },
      { npcOffWage: { axis: 'acquaintance', is: '>=30', atLeast: 1 } }] }],
]

/** 必須回一個理由（恆假） */
const UNSAT = [
  ['★ 攻擊實例：早上與晚上兩個時窗', { all: [{ hours: [6, 7] }, { hours: [20, 21] }] }],
  ['時窗交集為空（相鄰不重疊）', { all: [{ hours: [6, 8] }, { hours: [8, 10] }] }],
  ['地點交集為空', { all: [{ at: 'bh:alley' }, { at: 'bh:quays' }] }],
  ['地點集合無交集', { all: [{ at: ['bh:alley', 'bh:pans'] }, { at: ['bh:quays', 'bh:market'] }] }],
  ['潮汐同時兩種', { all: [{ tide: 'rise' }, { tide: 'ebb' }] }],
  ['day 超過局長度', { day: '>=45' }],
  ['day 上下界矛盾', { all: [{ day: '>=20' }, { day: '<5' }] }],
  ['wageDays 超過局長度', { wageDays: '>=45' }],
  ['npcCount 超過名冊人數', { npcCount: { axis: 'acquaintance', is: '>=30', atLeast: 9 } }],
  ['npcOffWage 超過上限', { npcOffWage: { axis: 'acquaintance', is: '>=30', atLeast: 4 } }],
  ['同時持有與不持有同一物', { all: [{ has: { item: 'item-a' } }, { not: { has: { item: 'item-a' } } }] }],
  ['同時知道與不知道同一條路', { all: [{ knowsRoute: 'e:a' }, { not: { knowsRoute: 'e:a' } }] }],
  ['同一 flag 正反', { all: [{ flag: 'a' }, { not: { flag: 'a' } }] }],
  ['any 的每一支都恆假', { any: [{ day: '>=45' }, { day: '>=99' }] }],
  ['巢狀 all 裡的時窗矛盾', { all: [{ all: [{ hours: [6, 7] }] }, { hours: [20, 21] }] }],
]

for (const [name, cond] of SAT) {
  const r = unsat(cond, ENV)
  T(`可滿足：${name}`, r === null, r === null ? '' : `★ 誤報：${r}`)
}
for (const [name, cond] of UNSAT) {
  const r = unsat(cond, ENV)
  T(`恆假：${name}`, typeof r === 'string' && r.length > 0, r ? r.slice(0, 60) : '★ 沒抓到')
}

console.log('=== cond-sat 單元測試 ===\n')
let pass = true
let fp = 0
for (const r of rows) {
  if (!r.ok) { pass = false; if (r.name.startsWith('可滿足')) fp++ }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.note) console.log(`        ${r.note}`)
}
console.log(`\n可滿足 ${SAT.length} 例 / 恆假 ${UNSAT.length} 例`)
if (fp > 0) console.log(`★★ 有 ${fp} 個【誤報】——那比漏判嚴重得多，必須先修這個方向。`)
console.log(pass ? `\n[PASS] ${rows.length} 項 cond-sat 測試全數通過。` : '\n[FAIL] 有項目未通過。')
process.exit(pass ? 0 : 1)
