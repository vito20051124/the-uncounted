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

/** 全知狀態：learned 邊全部已知，圖最完整 */
function stateAt(from: NodeId, minute: number, stamina = 100): GameState {
  const s = initialState('acceptance', from, [])
  return {
    ...s,
    at: from,
    clock: { day: 3, minute },
    needs: { ...s.needs, stamina },
    knownRoutes: content.edges.filter((e) => e.knowledge === 'learned').map((e) => e.id),
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

console.log('=== Pareto 路線列舉驗收 ===')
console.log(`OD 對：${pairs.length} 組（6 節點）\n`)
rows.forEach((r) => console.log(r))

const checks = [
  { name: '≥12 組有 ≥2 條 Pareto 最優路徑', got: multi, need: 12 },
  { name: '≥4 組因日夜/潮汐改變 front', got: variesByWorld, need: 4 },
  { name: '≥2 組的可行路線因體力而改變', got: variesByLoad, need: 2 },
]
console.log('\n--- 判準 ---')
let pass = true
for (const c of checks) {
  const ok = c.got >= c.need
  if (!ok) pass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}：實測 ${c.got} / 需 ${c.need}`)
}

// 抽樣展示一組真決策
const demo = stateAt('bh:alley', 14 * 60)
const front = paretoFront(enumerateRoutes(demo, idx, 'ebb', 'bh:market', 0))
console.log('\n--- 範例：老鹽街後巷 → 行會大市集（日·退潮）---')
for (const r of front.sort((x, y) => x.minutes - y.minutes)) {
  console.log(`  ${String(r.minutes).padStart(3)} 分  體力 ${String(r.stamina).padStart(5)}  風險 ${(r.risk * 100).toFixed(1).padStart(5)}%   ${r.label}`)
}

console.log(pass ? '\n[PASS] 路線選擇是真決策。' : '\n[FAIL] 路網撐不起「路線選擇是真決策」，需改資料。')
process.exit(pass ? 0 : 1)
