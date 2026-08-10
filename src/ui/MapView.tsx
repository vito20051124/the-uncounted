/**
 * SVG 路網圖。★ 這是玩家回饋的直接解藥：
 * 「因為沒有地圖以及可視化的方式，所以其實我不太確定我自己到底在哪裡，所以只好隨便走」
 *
 * 全部由 nodes.json / edges.json 生成，不手繪 —— 改資料，地圖跟著改。
 *
 * 視覺對應：
 *   節點 Y      = 高程（鹵港是一座從海爬到崖上的城）
 *   節點 X      = 既有正典方位
 *   節點外圈色  = 治安等級（1 安全 → 4 城防死角）
 *   ★當前位置  = 實心 + 光暈 + 標籤加粗
 *   連線粗細    = 時間（越粗越久）
 *   連線顏色    = 該時刻的風險（綠→黃→紅）
 *   虛線        = 你知道那裡有路，但還不知道怎麼走（learned 未習得）
 *   線消失      = 潮汐使該段此刻不存在（★ 世界改變的是圖本身，不是權重）
 *
 * ★ 平行邊必須錯開：老鹽街↔碼頭之間有兩條路（石板坡／風乾魚巷），
 *   若畫在同一條直線上會完全重疊 —— 而那正是本作示範「路線選擇是真決策」的那一組。
 */

import type { GameState, Index, NodeId, Tide, WorldEdge } from '../engine/types.ts'
import { riskFor } from '../engine/map.ts'

const W = 1000
const H = 200
const PAD_X = 62
const PAD_Y = 34

function pos(elev: number, mapX: number, outside?: boolean) {
  const x = PAD_X + (mapX / 100) * (W - PAD_X * 2)
  const y = H - PAD_Y - (elev / 12) * (H - PAD_Y * 2 - 10) + (outside ? 12 : 0)
  return { x, y }
}

const SEC_COLOR = ['', '#6d8a5a', '#8a7f4a', '#a86a44', '#b5453a']

function riskColor(p: number) {
  return `hsl(${Math.max(0, 105 - p * 320)} 58% 48%)`
}

/** 平行邊的垂直偏移量（第 0 條不偏，之後左右交錯） */
function offsetOf(i: number, total: number): number {
  if (total <= 1) return 0
  const step = 16
  return (i - (total - 1) / 2) * step
}

function curve(ax: number, ay: number, bx: number, by: number, off: number) {
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  if (off === 0) return `M ${ax} ${ay} L ${bx} ${by}`
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  // 垂直單位向量
  const nx = -dy / len
  const ny = dx / len
  return `M ${ax} ${ay} Q ${mx + nx * off * 2} ${my + ny * off * 2} ${bx} ${by}`
}

export function MapView({
  s, idx, tide, highlight, routeMode,
}: {
  s: GameState
  idx: Index
  tide: Tide
  highlight?: string[]
  routeMode?: string | null
}) {
  const nodes = [...idx.node.values()]
  const P: Record<NodeId, { x: number; y: number }> = {}
  for (const n of nodes) P[n.id] = pos(n.elevation, n.mapX ?? 50, n.outsideWalls)

  const hi = new Set(highlight ?? [])

  // 依節點配對分組，讓平行邊錯開
  const groups = new Map<string, WorldEdge[]>()
  for (const e of idx.edge.values()) {
    const k = [e.a, e.b].sort().join('|')
    const g = groups.get(k)
    if (g) g.push(e)
    else groups.set(k, [e])
  }

  let blocked = 0
  const drawn: preact.JSX.Element[] = []
  const labels: preact.JSX.Element[] = []

  for (const g of groups.values()) {
    g.forEach((e, i) => {
      const a = P[e.a]
      const b = P[e.b]
      if (!a || !b) return
      const off = offsetOf(i, g.length)
      const d = curve(a.x, a.y, b.x, b.y, off)
      const tideBlocked = !!e.requiresTide && e.requiresTide !== tide
      const unknown = e.knowledge === 'learned' && !s.knownRoutes.includes(e.id)
      const on = hi.has(e.id)

      if (tideBlocked) {
        blocked++
        drawn.push(
          <path key={e.id} d={d} fill="none" stroke="#2e241d" stroke-width="1.2" stroke-dasharray="2 6" />
        )
        return
      }

      drawn.push(
        <path
          key={e.id}
          d={d}
          fill="none"
          stroke={on ? '#7fc4e8' : unknown ? '#514537' : riskColor(riskFor(e, s.clock.minute))}
          stroke-width={on ? 4.5 : Math.max(1.6, Math.min(5, 1.2 + e.minutes / 8))}
          stroke-dasharray={unknown ? '6 5' : undefined}
          opacity={routeMode && !on ? 0.2 : unknown ? 0.8 : 0.92}
          stroke-linecap="round"
        />
      )

      if (on) {
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const dx = b.x - a.x, dy = b.y - a.y
        const len = Math.hypot(dx, dy) || 1
        labels.push(
          <g key={`l-${e.id}`}>
            <rect x={mx + (-dy / len) * off - 34} y={my + (dx / len) * off - 9} width="68" height="14" rx="3" fill="#101c22" opacity="0.9" />
            <text x={mx + (-dy / len) * off} y={my + (dx / len) * off + 1.5} fill="#a8dcf5" font-size="9.5" text-anchor="middle">{e.name}</text>
          </g>
        )
      }
    })
  }

  return (
    <div class="map-wrap">
      <svg class="map-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {/* 城牆線 */}
        <line x1={PAD_X - 26} y1={H - PAD_Y + 9} x2={W - PAD_X + 26} y2={H - PAD_Y + 9}
          stroke="#3a2f26" stroke-width="1" stroke-dasharray="3 7" />
        <text x={W - PAD_X + 30} y={H - PAD_Y + 12} fill="#4a4038" font-size="8.5">城牆</text>

        {drawn}
        {labels}

        {nodes.map((n) => {
          const p = P[n.id]!
          const cur = n.id === s.at
          const dest = routeMode === n.id
          const label = n.name
          const w = label.length * 12 + 12
          return (
            <g key={n.id}>
              {cur && <circle cx={p.x} cy={p.y} r="16" fill="#b8894a" opacity="0.16" />}
              {dest && <circle cx={p.x} cy={p.y} r="16" fill="#7fc4e8" opacity="0.2" />}
              {/* 標籤底板：避免文字疊在線上看不清 */}
              <rect x={p.x - w / 2} y={p.y - 27} width={w} height="15" rx="3"
                fill="#14100d" opacity={cur || dest ? 0.95 : 0.86} />
              <text x={p.x} y={p.y - 16} fill={cur ? '#e6c088' : dest ? '#a8dcf5' : '#9c8f7e'}
                font-size={cur ? 12 : 11} font-weight={cur || dest ? '700' : '400'} text-anchor="middle">
                {label}
              </text>
              <circle cx={p.x} cy={p.y} r={cur ? 7.5 : 5.5}
                fill={cur ? '#b8894a' : dest ? '#7fc4e8' : '#14100d'}
                stroke={cur ? '#e6c088' : dest ? '#a8dcf5' : SEC_COLOR[n.security]}
                stroke-width={cur || dest ? 2.5 : 1.8} />
              <rect x={p.x - 26} y={p.y + 9} width="52" height="12" rx="2" fill="#14100d" opacity="0.8" />
              <text x={p.x} y={p.y + 18} fill="#5b5145" font-size="8" text-anchor="middle">
                +{n.elevation}m · 治安{n.security}
              </text>
            </g>
          )
        })}
      </svg>

      {routeMode ? (
        <div class="map-hint">選擇路線中 —— 滑過選項，這裡會標出那一條</div>
      ) : (
        <div class="map-hint">
          你在 <b style="color:#e6c088">{idx.node.get(s.at)?.name}</b>
          {blocked > 0 && <span style="color:#a5705f">　·　{blocked} 條路此刻因潮汐關閉</span>}
        </div>
      )}

      <div class="map-legend">
        <div><b>高低</b>＝高程　<b>粗細</b>＝時間</div>
        <div><b>顏色</b>＝風險（綠安全→紅危險）</div>
        <div><b>虛線</b>＝有路，但你還不知道怎麼走</div>
        <div><b>點線</b>＝潮汐關閉，此刻不通</div>
      </div>
    </div>
  )
}
