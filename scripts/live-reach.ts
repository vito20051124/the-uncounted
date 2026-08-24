/**
 * 行為式可達性：用【真引擎】跑一個不動點閉包，斷言每一樣東西玩家真的碰得到。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 為什麼需要它：既有的閘全部在證明「某個字串存在」。
 *
 * 一次對抗式稽核在三道反向閘上找出 21 個漏洞，【全部是偽綠燈方向】，
 * 而它們全部走同一道門：留下字串，拆掉路徑。
 *   · 教學事件存在，但它的 requires 永遠為假
 *   · 教學事件存在且條件可滿足，但它在一個必須先走那條邊才到得了的節點
 *   · 兩條 learned 邊互相依賴（A 教 B、B 教 A）
 *   · removeItem 寫在一個從未被呼叫的函式裡
 *   · spend.item 落在一個永遠不可選的選項上
 *
 * 靜態分析對前兩種可以逐案補規則，對後三種【原理上】抓不到——
 * 因為問題不在任何單一資料列，而在整張圖的連通性。
 *
 * 所以這一支不問「有沒有寫」，它問：
 *   從真起點出發、用真引擎的 candidates／availableChoices／edgeAvailable，
 *   一個玩家【走得到】這裡嗎？
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 不動點的三個集合（都是單調成長，永不縮小）：
 *     known ⊆ learned 邊 ／ flags ⊆ 可被設定的旗標 ／ owned ⊆ 可取得的物品
 *
 * ★★ 而它刻意是【樂觀的】：閉包不模擬單一局，它模擬「所有可能的局」。
 *   一個被 not:{flag:F} 守著的事件，在 F 還沒進閉包的那一輪就算可達，
 *   而它之後即使 F 進來了也【永久記為已達】。
 *   這是對的：那兩件事屬於不同的 playthrough，而我們問的是
 *   「存在一條路徑讓玩家看到它嗎」，不是「同一局能不能全部看到」。
 *   若不這樣做，任何「一次性事件 ＋ 完成旗標」的標準寫法都會被誤報。
 *
 * ★ 誠實的界線：閉包不模擬【資源預算】。它假設玩家在某一局裡可以有很多錢、
 *   很高的關係、很多上工日——那些軸用「側寫」窮舉，而不是靠模擬去賺。
 *   所以它證明的是「條件與圖的連通性允許」，不是「三十天內來得及」。
 *   後者是 balance.ts 的工作，兩者互補。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  buildIndex, type Content, type EdgeId, type GameState, type ItemId, type NodeId,
} from '../src/engine/types.ts'
import { LAST_DAY } from '../src/engine/clock.ts'
import { edgeAvailable } from '../src/engine/map.ts'
import { availableChoices, isCandidate } from '../src/engine/events.ts'
import { ctxOf, initialState } from '../src/engine/reduce.ts'
import { newInjury } from '../src/engine/body.ts'

const D = new URL('../data/', import.meta.url)
const rd = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX = buildIndex({
  npcs: rd('npcs.json'), nodes: rd('nodes.json'), edges: rd('edges.json'),
  items: rd('items.json'), jobs: rd('jobs.json'), events: rd('events.json'),
  conditions: rd('conditions.json'), endings: rd('endings.json'),
} as Content)

/** 抵達點（App.tsx 的 initialState 用的同一個） */
const START = 'bh:alley' as NodeId

/**
 * 開場六選三的候選物。
 * ★ 六樣【全部】算可取得：玩家只帶三樣，但「哪三樣」由玩家決定，
 *   所以對可達性而言六樣都有某一局拿得到。
 */
const PICKABLE = [
  'item-phone', 'item-keys', 'item-candy', 'item-lighter', 'item-spray', 'item-bandaid',
] as ItemId[]

/**
 * 豁免表。★ F-3 的要求：上線時【必須是空的】。
 *   若一開始就需要幾筆豁免，那是下面的側寫建錯了，不是內容有問題。
 */
const UNREACHABLE_OK: Record<string, string> = {}

/**
 * R6 的豁免：物品被條件引用為【物價基準】而非持有物。
 * ★ 這一筆是有依據的：canAfford 查的是錢包不是背包，
 *   而 item-room-lease 的 desc 自己就寫「不是可以帶著走的東西」。
 */
const NOT_CARRIABLE: Record<string, string> = {
  'item-room-lease': '租約是【物價基準】而不是可以帶著走的東西（它的 desc 自述如此）。'
    + 'endings.yaml 用 canAfford 引用它來表達「下一輪的租金已經在桌上」，而 canAfford 查錢包不查持有。',
}

/**
 * 不屬於閉包的狀態軸，用【側寫】窮舉。
 *
 * ★ 為什麼不是完整交叉乘積：那會爆炸而且沒有必要。這五個側寫刻意覆蓋
 *   每一個軸的兩個極端（窮／富、生／熟、健康／感染、早／晚），
 *   而條件語言裡沒有任何謂詞需要「中間值」才會為真。
 *
 * ★★ 側寫【不得】手動塞旗標、物品或路線——那三樣只能來自閉包本身。
 *   這是這支腳本唯一的誤報來源：god-state 一塞就會把「其實學不到的邊」
 *   誤判成可達（而它就是為了抓那件事而存在的）。
 */
interface Profile {
  name: string
  day: number
  copper: number
  rel: number
  hurt: 'none' | 'raw' | 'infected'
  big: boolean
}
/**
 * ★ 這份清單是【手工配對】而不是完整交叉乘積。
 *
 *   完整乘積是 copper(3) × hurt(3) × rel(3) × day(4) × big(2) × needs(3)
 *   × 節點(8) × 時刻(15) ≈ 78 萬個狀態，每個還要跑 64 個事件的條件樹——太慢。
 *
 *   但第一版只寫五個側寫時，立刻出現一個【交叉乘積的洞】：
 *   「身無分文」只存在於 hurt:'none' 的那一列、「帶著傷」只存在於有 12 銅的那一列，
 *   於是 ev-cannot-afford-salve（要求「有傷 ＋ 買不起藥」）在任何側寫下都不成立，
 *   被誤報成死事件。
 *
 *   所以下面刻意覆蓋每一對【會同時出現在同一個條件裡】的極端組合，
 *   而不是每個軸各自的極端。新增條件用到新的軸組合時，這裡要補一列。
 */
const PROFILES: Profile[] = [
  { name: '第一天、身無分文、誰都不認識', day: 1, copper: 0, rel: 0, hurt: 'none', big: false },
  { name: '★ 身無分文【且帶傷】（買不起藥的那一幕需要這一格）', day: 3, copper: 0, rel: 0, hurt: 'raw', big: false },
  { name: '身無分文且傷已感染', day: 6, copper: 0, rel: 10, hurt: 'infected', big: false },
  { name: '早期、有點錢、帶著傷', day: 4, copper: 12, rel: 10, hurt: 'raw', big: false },
  { name: '中期、關係中等、健康', day: 12, copper: 80, rel: 45, hurt: 'none', big: false },
  { name: '中期、關係中等、傷已感染', day: 12, copper: 80, rel: 45, hurt: 'infected', big: false },
  { name: '中期、富裕、生疏', day: 15, copper: 400, rel: 0, hurt: 'none', big: false },
  { name: '晚期、富裕、熟識、健康', day: 28, copper: 400, rel: 85, hurt: 'none', big: true },
  { name: '晚期、富裕、熟識、帶傷', day: 28, copper: 400, rel: 85, hurt: 'raw', big: true },
  { name: '晚期、身無分文、熟識', day: 26, copper: 0, rel: 85, hurt: 'none', big: true },
  { name: '最後一天、富裕、熟識', day: LAST_DAY, copper: 400, rel: 85, hurt: 'none', big: true },
]

/**
 * 六條需求的三個水位。
 *
 * ★ 這是一個獨立的軸，不綁在側寫上——第一版把它做成側寫的一個布林（low），
 *   而 low 對應到 20，於是 `satiety: '<15'` 這種條件【在任何側寫下都不成立】，
 *   ev-hunger-faint 被誤報成死事件。
 *   2 / 50 / 96 三個水位讓 `<15`、`>10 且 <60`、`>=90` 三類條件都有一個狀態命中。
 */
const NEED_LEVELS = [2, 50, 96]

/** 代表時刻：涵蓋日夜、宵禁、潮汐兩相與各工作時窗的邊界 */
const HOURS = [0, 3, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 21, 22, 23]

/**
 * ★★★ 蒐集一個條件樹裡【被否定】的旗標／物品／路線。
 *
 * 這是這支腳本最重要的一段，因為沒有它整個閉包會系統性誤報。
 *
 * 問題：閉包把累積到的旗標【全部同時】餵回引擎，
 * 而 `not: { flag: F }` 是本專案「這一幕只演一次」的標準寫法。
 * 一旦 F 進了閉包，那個事件在【之後每一輪】都不再是候選——
 * 於是 ev-dross-settle（被 not:dross-sold 守著）、
 * ev-path-forge／ev-path-vouch（被 not:identity-obtained 守著）
 * 全部被誤報成死事件。
 *
 * 解法就是 reach-test 已經在用的那個做法：對每個事件，
 * 把【它自己否定的那些東西】從狀態裡拿掉再評估。
 * 語意上完全正確：`not: F` 的意思就是「在 F 發生之前」，
 * 而那個時點在任何一局裡都存在。
 *
 * ★ 這讓閘門更樂觀，而樂觀的方向是【漏判】而非誤報——
 *   對一道會 exit 1 的閘來說，那是正確的偏誤方向。
 */
function negatives(cond: unknown): { flags: Set<string>; items: Set<string>; routes: Set<string> } {
  const out = { flags: new Set<string>(), items: new Set<string>(), routes: new Set<string>() }
  const walk = (c: unknown, negated: boolean) => {
    if (!c || typeof c !== 'object') return
    const o = c as Record<string, unknown>
    if (negated) {
      if (typeof o.flag === 'string') out.flags.add(o.flag)
      const has = o.has as { item?: string } | undefined
      if (has?.item) out.items.add(has.item)
      if (typeof o.knowsRoute === 'string') out.routes.add(o.knowsRoute)
    }
    for (const k of ['all', 'any'] as const) {
      if (Array.isArray(o[k])) for (const sub of o[k] as unknown[]) walk(sub, negated)
    }
    if (o.not) walk(o.not, !negated)
  }
  walk(cond, false)
  return out
}

function stateFor(
  p: Profile, at: NodeId, hour: number, need: number,
  known: Set<EdgeId>, flags: Set<string>, owned: Set<ItemId>,
): GameState {
  const s = initialState('live-reach', at, [], IDX)
  return {
    ...s,
    at,
    clock: { day: p.day, minute: hour * 60 },
    purse: { copper: p.copper },
    needs: { satiety: need, hydration: need, stamina: need, warmth: need, hygiene: need, sanity: need },
    // ★ 三個閉包集合原封餵回引擎——不加任何額外的東西
    knownRoutes: [...known],
    flags: Object.fromEntries([...flags].map((f) => [f, true])),
    carry: [...owned].map((item) => ({ item, count: 9 })),
    injuries: p.hurt === 'none' ? [] : [{
      ...newInjury('lr-w', '割傷', 2, Math.max(1, p.day - 2)),
      infected: p.hurt === 'infected',
      feverSinceDay: p.hurt === 'infected' ? Math.max(1, p.day - 1) : null,
    }],
    npcs: Object.fromEntries([...IDX.npc.keys()].map((id) => [id, {
      acquaintance: p.rel, trust: p.rel, affection: p.rel,
      lastSeenDay: p.rel > 0 ? p.day - 1 : null, knownFacts: [],
    }])),
    stats: {
      ...s.stats,
      namedAsks: p.big ? 6 : 0,
      wageDays: p.big ? 25 : 0,
      givenAway: p.big ? 4 : 0,
    },
    // ★ eventHistory 保持【空的】：MIN_EVENT_GAP 與 once 都靠它，
    //   而閉包問的是「存在一局看得到嗎」，不是「同一刻能不能連續看到」。
    eventHistory: {},
  }
}

/** 以當前 known 算出可達節點（公開邊 ＋ 已知的 learned 邊；潮汐兩相取聯集） */
function reachableNodes(known: Set<EdgeId>): Set<NodeId> {
  const seen = new Set<NodeId>([START])
  const queue: NodeId[] = [START]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of IDX.edge.values()) {
      if (e.a !== cur && e.b !== cur) continue
      const nxt = (e.a === cur ? e.b : e.a) as NodeId
      if (seen.has(nxt)) continue
      // 兩種潮汐任一可通即算可達（潮汐每天都會轉，它限制時機不限制可達性）
      const probe = { ...initialState('lr', cur, [], IDX), knownRoutes: [...known] }
      const passable = (['rise', 'ebb'] as const).some((t) => edgeAvailable(e, probe, t).ok)
      if (!passable) continue
      seen.add(nxt)
      queue.push(nxt)
    }
  }
  return seen
}

/**
 * 每個事件的 drop 簽章（它自己否定了哪些旗標／物品／路線）。
 * ★ 只算一次：它只取決於事件的條件樹，與側寫／節點／時刻無關。
 */
const DROP_OF = new Map<string, { flags: Set<string>; items: Set<string>; routes: Set<string> }>()
const DROP_GROUPS = new Map<string, Array<ReturnType<typeof IDX.event.get> & object>>()
for (const ev of IDX.event.values()) {
  const neg = negatives({ all: [ev.where, ev.when, ev.requires].filter(Boolean) })
  for (const ch of ev.choices) {
    const cn = negatives(ch.requires)
    for (const f of cn.flags) neg.flags.add(f)
    for (const i of cn.items) neg.items.add(i)
    for (const r of cn.routes) neg.routes.add(r)
  }
  const sig = [[...neg.flags].sort().join(','), [...neg.items].sort().join(','), [...neg.routes].sort().join(',')].join('|')
  if (!DROP_OF.has(sig)) { DROP_OF.set(sig, neg); DROP_GROUPS.set(sig, []) }
  DROP_GROUPS.get(sig)!.push(ev)
}

// ═══════════════ 不動點 ═══════════════
const known = new Set<EdgeId>()
const flags = new Set<string>()
const owned = new Set<ItemId>(PICKABLE)
/** 事件 id → 它第一次成為候選時的證人（哪個側寫／節點／時刻） */
const eventSeen = new Map<string, string>()
/** `eventId#choiceIndex` → 證人 */
const choiceSeen = new Map<string, string>()
let nodesSeen = new Set<NodeId>([START])
let rounds = 0

for (;;) {
  rounds++
  const before = known.size + flags.size + owned.size + eventSeen.size + choiceSeen.size + nodesSeen.size
  nodesSeen = reachableNodes(known)
  // 可達節點賣的東西都算取得得到（buy 的唯一入口就是 here.sells）
  for (const n of nodesSeen) for (const it of IDX.node.get(n)!.sells) owned.add(it)

  for (const p of PROFILES) {
    for (const at of nodesSeen) {
      for (const h of HOURS) {
        for (const need of NEED_LEVELS) {
          /**
           * ★ 逐【事件】評估，而不是一次拿一個狀態問全部事件。
           *   因為每個事件要拿掉的東西不一樣（見 negatives 的註解）：
           *   一個被 not:F 守著的事件必須在「F 尚未成立」的狀態下評估。
           *
           * ★★ 但【同一個 drop 簽章的事件共用一個狀態】。
           *   第一版為每個事件各建一份狀態：11 側寫 × 8 節點 × 15 時刻 × 3 水位 × 64 事件
           *   = 203 萬次狀態建構，跑 12 秒。而大多數事件根本沒有 not 守衛，
           *   簽章相同——按簽章分組之後降到約 10 萬次。
           *   分組不改變任何語意：同簽章的事件看到的狀態本來就一樣。
           */
          for (const [sig, group] of DROP_GROUPS) {
            const neg = DROP_OF.get(sig)!
            const useFlags = new Set([...flags].filter((f) => !neg.flags.has(f)))
            const useOwned = new Set([...owned].filter((i) => !neg.items.has(i)))
            const useKnown = new Set([...known].filter((r) => !neg.routes.has(r)))
            const s = stateFor(p, at, h, need, useKnown, useFlags, useOwned)
            const ctx = ctxOf(s, IDX)
            for (const ev of group) {
              if (!isCandidate(ev, s, ctx)) continue
              if (ev.weight <= 0) continue // 恆不被抽中（weight 另有專門的閘，這裡不重複報）
              const witness = `${p.name} ／ ${IDX.node.get(at)!.name} ／ ${String(h).padStart(2, '0')}:00 ／ 需求 ${need}`
              if (!eventSeen.has(ev.id)) eventSeen.set(ev.id, witness)
              for (const ch of availableChoices(ev, ctx)) {
                const key = `${ev.id}#${ev.choices.indexOf(ch)}`
                if (!choiceSeen.has(key)) choiceSeen.set(key, witness)
                const g = ch.gain
                if (!g) continue
                if (g.learnRoute) known.add(g.learnRoute)
                if (g.item) owned.add(g.item)
                for (const f of [g.flag ?? []].flat()) flags.add(f as string)
              }
            }
          }
        }
      }
    }
  }
  const after = known.size + flags.size + owned.size + eventSeen.size + choiceSeen.size + nodesSeen.size
  if (after === before) break
  if (rounds > 40) {
    console.error('★ 不動點未收斂（>40 輪）—— 這是腳本的 bug，不是內容的問題')
    process.exit(1)
  }
}

// ═══════════════ 斷言 R1–R6 ═══════════════
const problems: string[] = []
const notes: string[] = []
const exempt = (id: string) => id in UNREACHABLE_OK

// R1 每個節點都到得了
for (const n of IDX.node.values()) {
  if (nodesSeen.has(n.id) || exempt(n.id)) continue
  problems.push(`R1 節點「${n.name}」（${n.id}）從抵達點【走不到】——`
    + `已知路線閉包收斂後仍不連通。玩家會看到一個永遠進不去的城區。`)
}
// R2 每條 learned 邊都學得到
for (const e of IDX.edge.values()) {
  if (e.knowledge !== 'learned') continue
  if (known.has(e.id) || exempt(e.id)) continue
  problems.push(`R2 learned 邊「${e.name}」（${e.id}）在閉包裡【永遠學不到】——`
    + `教學事件可能不存在、條件恆假、或落在一個必須先走這條邊才到得了的地方（雞生蛋）。`
    + `地圖上它會以虛線永久釣著玩家，而 pareto-check 會把一條不可得的邊算進最優集。`)
}
// R3 每個事件至少進候選池一次
for (const ev of IDX.event.values()) {
  if (eventSeen.has(ev.id) || exempt(ev.id)) continue
  problems.push(`R3 事件「${ev.name}」（${ev.id}）在任何側寫×節點×時刻【都進不了候選池】——`
    + `玩家永遠看不到你寫的這一幕，而所有既有測試都會通過。`)
}
// R4 每個選項至少可選一次
for (const ev of IDX.event.values()) {
  for (const [i, ch] of ev.choices.entries()) {
    const key = `${ev.id}#${i}`
    if (choiceSeen.has(key) || exempt(key)) continue
    problems.push(`R4 事件「${ev.name}」的選項「${ch.label}」（${key}）【永遠不可選】——`
      + `它的 requires 或 spend 在任何狀態下都不成立。玩家會看到一幕少了一個出口。`)
  }
}
// R5 每個宣告 uses 的消耗品，消耗點落在【可達的】選項上（或由引擎消耗）
{
  const engineConsumed = new Set<string>()
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const engineSrc = strip(readFileSync(new URL('../src/engine/reduce.ts', import.meta.url), 'utf-8'))
  for (const m of engineSrc.matchAll(/removeItem\(\s*(?:s|\{[^)]*\})\s*,\s*'([^']+)'/g)) {
    engineConsumed.add(m[1]!)
  }
  const uiSrc = strip(readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf-8'))
  const edible = /const EDIBLE[^=]*=\s*\{([\s\S]*?)\}/.exec(uiSrc)
  for (const m of (edible?.[1] ?? '').matchAll(/'([^']+)'\s*:/g)) engineConsumed.add(m[1]!)

  for (const it of IDX.item.values()) {
    if (it.uses === undefined) continue
    if (engineConsumed.has(it.id)) continue
    let hit: string | null = null
    for (const ev of IDX.event.values()) {
      for (const [i, ch] of ev.choices.entries()) {
        if (ch.spend?.item !== it.id) continue
        if (choiceSeen.has(`${ev.id}#${i}`)) { hit = `${ev.id}#${i}`; break }
      }
      if (hit) break
    }
    if (hit || exempt(it.id)) continue
    problems.push(`R5 消耗品「${it.name}」（${it.id}）宣告 uses: ${it.uses}，`
      + `但它的每一個消耗點都落在【玩家碰不到的地方】——`
      + `引擎不消耗它，而所有 spend.item 都在不可選的選項上。它實際上永不遞減。`)
  }
}
// R6 每個物品都取得得到
for (const it of IDX.item.values()) {
  if (owned.has(it.id) || exempt(it.id)) continue
  if (it.id in NOT_CARRIABLE) { notes.push(`（豁免）${it.id}：${NOT_CARRIABLE[it.id]}`); continue }
  problems.push(`R6 物品「${it.name}」（${it.id}）在閉包裡【取得不到】——`
    + `不在任何可達節點的 sells、沒有任何可達選項的 gain.item、也不是開場六選三之一。`)
}

/**
 * ★ 把閉包落成產物給下游用。
 *
 *   pareto-check.ts 原本把 knownRoutes 設成【全部】 learned 邊（全知假設），
 *   所以它結構上不可能發現「這條路玩家其實學不到」。實測傷害：
 *   石窟街→大聖堂在全知下的最優解是 14 分的崖上崖下小徑，
 *   而那條邊曾經無人教——玩家實際只能走 29 分的緘默長廊。
 *   路線分析對那組 OD 給出的最優解快了一倍，而玩家永遠拿不到。
 *
 *   現在 pareto-check 讀這份閉包跑第二遍：判準必須在【實際可得】的邊上通過。
 */
{
  const outDir = new URL('../_build/', import.meta.url)
  try { mkdirSync(outDir, { recursive: true }) } catch { /* 已存在 */ }
  writeFileSync(new URL('reach-closure.json', outDir), JSON.stringify({
    generatedBy: 'scripts/live-reach.ts',
    rounds,
    nodes: [...nodesSeen].sort(),
    knownRoutes: [...known].sort(),
    flags: [...flags].sort(),
    ownedItems: [...owned].sort(),
    events: [...eventSeen.keys()].sort(),
  }, null, 2), 'utf-8')
}

// ═══════════════ 輸出 ═══════════════
const learnedTotal = [...IDX.edge.values()].filter((e) => e.knowledge === 'learned').length
const choiceTotal = [...IDX.event.values()].reduce((a, e) => a + e.choices.length, 0)
console.log('=== 無籍者 · 行為式可達性（不動點閉包）===\n')
console.log(`  收斂於第 ${rounds} 輪`)
console.log(`  可達節點 ${nodesSeen.size}/${IDX.node.size}　`
  + `learned 邊 ${known.size}/${learnedTotal}　可得物品 ${owned.size}/${IDX.item.size}`)
console.log(`  旗標閉包 ${flags.size} 個　事件 ${eventSeen.size}/${IDX.event.size}　`
  + `選項 ${choiceSeen.size}/${choiceTotal}`)
if (Object.keys(UNREACHABLE_OK).length > 0) {
  console.log(`\n  ★ 豁免 ${Object.keys(UNREACHABLE_OK).length} 筆（F-3：這張表上線時應該是空的）`)
}
for (const n of notes) console.log(`  ${n}`)

if (problems.length > 0) {
  console.log('\n★ 問題：')
  for (const p of problems) console.log('  x ' + p)
  console.log('\n[FAIL] 行為式可達性未通過。')
  process.exit(1)
}
console.log('\n[PASS] 每個節點到得了、每條 learned 邊學得到、每個事件與選項都碰得到、每個物品取得得到。')
