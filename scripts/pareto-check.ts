/**
 * Pareto 路線列舉的驗收判準（可機器檢查；跑不出來就改資料，不改程式）。
 *
 * 對 6 節點的 30 組有序 OD 對跑列舉：
 *   ① ≥12 組要有 ≥2 條 Pareto 最優路徑
 *   ② ≥4 組的 front 成員會因日/夜或潮汐而改變
 *   ③ ≥2 組的【可行】路線集合會因體力而改變
 *
 * ★ 判準 ③ 原本寫的是「因負重改變 Pareto front」，實測恆為 0，追查後確認
 *   【那條判準測錯了東西】：在本圖中陡路永遠同時是短路，負重只會等向拉大
 *   體力差距，支配關係結構上不可能翻轉。
 *
 *   而壓力測試真正描述的機制是「扛完一天鹽之後，百階梯【走不動了】」——
 *   那不是 Pareto 支配翻轉，是【可行性約束】。故改測可行路線集合。
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState, type NodeId } from '../src/engine/types.ts'
import { paretoFront, enumerateRoutes, affordable } from '../src/engine/map.ts'
import { tideAt } from '../src/engine/clock.ts'
import { initialState } from '../src/engine/reduce.ts'

const D = new URL('../data/', import.meta.url)
const load = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const content: Content = {
  npcs: load('npcs.json'),
  nodes: load('nodes.json'),
  edges: load('edges.json'),
  items: load('items.json'),
  jobs: load('jobs.json'),
  events: load('events.json'),
}
const idx = buildIndex(content)
const ids = content.nodes.map((n) => n.id)

/**
 * 已知路線的兩種讀法。
 *
 * ★★ 舊版只有「全知」一種：knownRoutes = 全部 learned 邊。
 *   於是這支腳本【結構上不可能】發現「這條路玩家其實學不到」——
 *   它會把一條不可得的邊算進 Pareto 最優集，然後宣告路線選擇是真決策。
 *
 *   實測傷害（對抗式稽核）：石窟街→大聖堂在全知下的最優解是
 *   14 分的「崖上崖下小徑」，而那條邊曾經【沒有任何事件教它】。
 *   玩家實際只能走 29 分的緘默長廊——路線分析對那組 OD 給出的最優解
 *   快了一倍，而玩家永遠拿不到。
 *
 * ★ 現在跑兩遍：
 *     全知 = 設計意圖（這張圖【應該】提供什麼選擇）
 *     實得 = live-reach 的不動點閉包（玩家【真的】拿得到什麼）
 *   而【判準必須在實得那一遍通過】。兩遍差太多就是一個獨立的警訊：
 *   你的路線設計依賴玩家拿不到的邊。
 */
const ALL_LEARNED = content.edges.filter((e) => e.knowledge === 'learned').map((e) => e.id)
const CLOSURE = (() => {
  try {
    const j = JSON.parse(readFileSync(new URL('../_build/reach-closure.json', import.meta.url), 'utf-8'))
    return j.knownRoutes as string[]
  } catch {
    return null
  }
})()
/** 目前這一遍用哪一組 learned 邊 */
let KNOWN: string[] = ALL_LEARNED

function stateAt(from: NodeId, minute: number, stamina = 100): GameState {
  const s = initialState('acceptance', from, [])
  return {
    ...s,
    at: from,
    clock: { day: 3, minute },
    needs: { ...s.needs, stamina },
    knownRoutes: KNOWN,
  }
}

const SCENARIOS = [
  { name: '日·漲潮 10:00', minute: 10 * 60 },
  { name: '日·退潮 14:00', minute: 14 * 60 },
  { name: '夜·漲潮 22:00', minute: 22 * 60 },
  { name: '夜·退潮 02:00', minute: 2 * 60 },
]

function frontKey(from: NodeId, to: NodeId, minute: number, enc: number): string {
  const s = stateAt(from, minute)
  const f = paretoFront(enumerateRoutes(s, idx, tideAt(minute), to, enc))
  return f.map((r) => r.edges.join('>')).sort().join(' | ')
}
function frontSize(from: NodeId, to: NodeId, minute: number, enc = 0): number {
  const s = stateAt(from, minute)
  return paretoFront(enumerateRoutes(s, idx, tideAt(minute), to, enc)).length
}

function measure() {
  const pairs: Array<[NodeId, NodeId]> = []
  for (const a of ids) for (const b of ids) if (a !== b) pairs.push([a, b])

  let multi = 0
  let variesByWorld = 0
  let variesByLoad = 0
  const rows: string[] = []

  for (const [a, b] of pairs) {
    const base = frontSize(a, b, 14 * 60)
    if (base >= 2) multi++

    const keys = new Set(SCENARIOS.map((sc) => frontKey(a, b, sc.minute, 0)))
    const worldVaries = keys.size > 1
    if (worldVaries) variesByWorld++

    // ③ 體力可行性：精神飽滿 vs 扛完一天鹽之後
    const affordableSet = (stam: number, enc: number) => {
      const s = stateAt(a, 14 * 60, stam)
      return paretoFront(enumerateRoutes(s, idx, tideAt(14 * 60), b, enc))
        .filter((r) => affordable(r, stam))
        .map((r) => r.edges.join('>'))
        .sort()
        .join(' | ')
    }
    const loadVaries = affordableSet(100, 0) !== affordableSet(28, 2)
    if (loadVaries) variesByLoad++

    const an = idx.node.get(a)!.name
    const bn = idx.node.get(b)!.name
    rows.push(
      `  ${an} → ${bn}`.padEnd(30) +
        `front ${base}` +
        (worldVaries ? '  [日夜/潮汐會變]' : '') +
        (loadVaries ? '  [負重會變]' : '')
    )
  }


  return { multi, variesByWorld, variesByLoad, rows }
}

console.log('=== Pareto 路線列舉驗收 ===')
console.log(`OD 對：${ids.length * (ids.length - 1)} 組（${ids.length} 節點）`)

// 第一遍：全知（設計意圖）
KNOWN = ALL_LEARNED
const omniscient = measure()

// 第二遍：實得（live-reach 的閉包）
let actual = omniscient
if (CLOSURE === null) {
  console.log('\n★ 找不到 _build/reach-closure.json —— 只跑得了「全知」那一遍。')
  console.log('  請先跑 npm run live-reach（npm run check 的順序已經把它排在前面）。')
  console.log('  ★ 在那之前這道閘【無法】發現「路線設計依賴玩家拿不到的邊」。')
} else {
  KNOWN = CLOSURE
  actual = measure()
}

console.log('')
actual.rows.forEach((r) => console.log(r))

if (CLOSURE !== null) {
  const missing = ALL_LEARNED.filter((e) => !CLOSURE.includes(e))
  console.log('\n--- 兩遍對照 ---')
  console.log(`  全知：多解 ${omniscient.multi}／潮汐變 ${omniscient.variesByWorld}／負重變 ${omniscient.variesByLoad}`)
  console.log(`  實得：多解 ${actual.multi}／潮汐變 ${actual.variesByWorld}／負重變 ${actual.variesByLoad}`
    + `　（learned 邊 ${CLOSURE.length}/${ALL_LEARNED.length} 學得到）`)
  if (missing.length > 0) {
    console.log(`  ★ 有 ${missing.length} 條 learned 邊玩家學不到：${missing.join('、')}`)
    console.log('    —— 判準以【實得】那一遍為準，因為玩家玩到的是那一張圖。')
  }
}

// ★ 判準一律以【實得】那一遍為準
const checks = [
  { name: '≥12 組有 ≥2 條 Pareto 最優路徑', got: actual.multi, need: 12 },
  { name: '≥4 組因日夜/潮汐改變 front', got: actual.variesByWorld, need: 4 },
  { name: '≥2 組的可行路線因體力而改變', got: actual.variesByLoad, need: 2 },
]
console.log('\n--- 判準（以實際學得到的邊計算）---')
let pass = true
for (const c of checks) {
  const ok = c.got >= c.need
  if (!ok) pass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}：實測 ${c.got} / 需 ${c.need}`)
}

// 抽樣展示一組真決策（用實得的圖）
const demo = stateAt('bh:alley', 14 * 60)
const front = paretoFront(enumerateRoutes(demo, idx, 'ebb', 'bh:market', 0))
console.log('\n--- 範例：老鹽街後巷 → 行會大市集（日·退潮）---')
for (const r of front.sort((x, y) => x.minutes - y.minutes)) {
  console.log(`  ${String(r.minutes).padStart(3)} 分  體力 ${String(r.stamina).padStart(5)}  風險 ${(r.risk * 100).toFixed(1).padStart(5)}%   ${r.label}`)
}

console.log(pass ? '\n[PASS] 路線選擇是真決策。' : '\n[FAIL] 路網撐不起「路線選擇是真決策」，需改資料。')
process.exit(pass ? 0 : 1)
