/**
 * 建置期資料驗證（link-lint 的遊戲版，要求歸零）。
 *
 * 檢查：
 *   ① 參照完整性：每個 at / where.at / item / edge 端點都指向存在的 id
 *   ② 公平性：帶致命風險者必須有 tell —— 違者建置失敗（支柱三的機器化）
 *   ③ 出處覆蓋率：每筆資料都要有 src，且 invented 比例 ≤ 20%
 *   ④ 貨幣：所有價格為非負整數銅（1 金帝 = 240 銅，非十進）
 *   ⑤ 時間：所有分鐘為非負整數
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', 'data')
const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf-8'))

const nodes = read('nodes.json')
const edges = read('edges.json')
const items = read('items.json')
const jobs = read('jobs.json')
const conditions = read('conditions.json')
const events = read('events.json')
const npcs = read('npcs.json')
const endings = read('endings.json')

/**
 * ★ 局長度從引擎常數讀，不寫死。
 *   歷史上 LAST_DAY 在 App.tsx／smoke.ts／balance.ts 各寫過一份 14，
 *   而 14 → 30 那一次改動漏掉其中一份，直到兩個月後才被發現。
 */
const LAST_DAY = (() => {
  const m = /export const LAST_DAY = (\d+)/.exec(fs.readFileSync(path.join(here, '..', 'src/engine/clock.ts'), 'utf-8'))
  if (!m) { console.error('★ 在 clock.ts 找不到 export const LAST_DAY —— 局長度相關的檢查無法進行'); process.exit(1) }
  return Number(m[1])
})()

const errors = []
const warns = []
const nodeIds = new Set(nodes.map((n) => n.id))
const edgeIds = new Set(edges.map((e) => e.id))
const itemIds = new Set(items.map((i) => i.id))
const npcIds = new Set(npcs.map((n) => n.id))

const E = (m) => errors.push(m)

// ═══ 讀原始碼判斷行為的共用工具 ═══
//
// ★ 兩者都是被自己咬過之後才寫的：
//   · stripComments：⑥ 曾經把自己註解裡的 ctxOf(s, idx, onEdge?, justTurned?)
//     當成一個四參數呼叫點，整道「結構上永遠為假」的檢查靜默失效。
//     而 ⑤ 的兩條原始碼掃描【完全沒有剝註解】——把一行 removeItem 註解掉，
//     那條消耗通道照樣算存在。同一個錯誤，一個修了一個沒修。
//   · anchor：掃描錨點失效時【一律 error】。
//     舊版用 warns.push，而 warns 從不影響 exit code，
//     而 npm run check 只看 exit code——於是「找不到掃描目標」等於這道檢查
//     靜默變成 no-op，卻仍然全綠。一道靜默跳過的檢查比沒有檢查更貴：
//     它會讓人以為那件事被守著。
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
const srcOf = (p) => { try { return stripComments(fs.readFileSync(path.join(here, '..', p), 'utf-8')) } catch { return '' } }
const rawOf = (p) => { try { return fs.readFileSync(path.join(here, '..', p), 'utf-8') } catch { return '' } }
const anchor = (re, txt, what) => {
  const m = re.exec(txt)
  if (!m) E(`validate-data 的掃描錨點失效：${what}`
    + ' —— 這道檢查會【靜默變成 no-op】卻仍然全綠。請同步這裡的正則，或把目標搬回原形狀。')
  return m
}

/**
 * 從一段 TypeScript 介面／型別的主體裡抓出【頂層】的鍵名。
 *
 * ★ 為什麼不能用縮排：舊版要求「行首恰好兩個空白後緊接識別字」，
 *   而一個【與欄位同行的 JSDoc 註解】會讓那個欄位完全不進 declared
 *   ——於是 ⑥ 的兩半檢查（零實例／可達性）同時對它失效。
 *   而同行短註解正是這份 types.ts 已經在用的風格（`elevation: number // 公尺`）。
 *
 * ★★ 也不能簡單放寬成 `\s{2,}`：那會抓到嵌套物件型別的內層鍵
 *   （`needs` 裡的 satiety/hydration…），一改就【誤報】。
 *   「恰好兩格」實際上是在做頂層過濾，所以正解是明確地數括號深度。
 */
function topLevelKeys(body) {
  const t = stripComments(body)
  const keys = []
  let depth = 0
  let i = 0
  while (i < t.length) {
    const c = t[i]
    if ('{[('.includes(c)) { depth++; i++; continue }
    if ('}])'.includes(c)) { depth--; i++; continue }
    if (depth === 0 && (i === 0 || /[\s;,{]/.test(t[i - 1]))) {
      const m = /^(\w+)\??\s*:/.exec(t.slice(i))
      if (m) { keys.push(m[1]); i += m[0].length; continue }
    }
    i++
  }
  return keys
}

// ① 參照完整性
for (const e of edges) {
  if (!nodeIds.has(e.a)) E(`edge ${e.id}: 端點 a 不存在 → ${e.a}`)
  if (!nodeIds.has(e.b)) E(`edge ${e.id}: 端點 b 不存在 → ${e.b}`)
  if (!Number.isInteger(e.minutes) || e.minutes <= 0) E(`edge ${e.id}: minutes 必須為正整數`)
  if (e.knowledge !== 'public' && e.knowledge !== 'learned') E(`edge ${e.id}: knowledge 值非法`)
  // ★ 同一個迴圈裡 knowledge 檢查了、requiresTide 卻零檢查——就是這種不對稱在漏。
  //   'ebb' 打成 'ebbing' → map.ts 讓那條邊在【兩種潮汐都不通】，
  //   而玩家會把它讀成正常的潮汐機制而不回報 bug（比崩掉更難發現）。
  if (e.requiresTide !== undefined && e.requiresTide !== 'rise' && e.requiresTide !== 'ebb')
    E(`edge ${e.id}: requiresTide 值非法 → ${JSON.stringify(e.requiresTide)}（只能是 'rise' | 'ebb'）`)
  if (e.climbFactor !== undefined && (typeof e.climbFactor !== 'number' || !(e.climbFactor > 0)))
    E(`edge ${e.id}: climbFactor 必須是正數 → ${JSON.stringify(e.climbFactor)}`)
}
for (const j of jobs) {
  if (!Number.isInteger(j.maxPerDay) || j.maxPerDay < 1) E(`job ${j.id}: maxPerDay 必須是 >=1 的整數（一天只挑一次人；缺這格會讓錄取率被原地重試磨平）`)
  if (!nodeIds.has(j.at)) E(`job ${j.id}: at 不存在 → ${j.at}`)
  if (!Number.isInteger(j.minutes) || j.minutes <= 0) E(`job ${j.id}: minutes 必須為正整數`)
  if (!Number.isInteger(j.payCopper) || j.payCopper < 0) E(`job ${j.id}: payCopper 必須為非負整數`)
}
for (const i of items) {
  if (i.priceCopper !== null && (!Number.isInteger(i.priceCopper) || i.priceCopper < 0))
    E(`item ${i.id}: priceCopper 必須為 null 或非負整數銅`)
  if (i.sellCopper !== undefined && (!Number.isInteger(i.sellCopper) || i.sellCopper < 0))
    E(`item ${i.id}: sellCopper 必須為非負整數銅`)
}

// 走訪條件樹，收集所有引用的 id
function walkCond(c, ev, where) {
  if (!c || typeof c !== 'object') return
  for (const sub of [...(c.all ?? []), ...(c.any ?? []), ...(c.not ? [c.not] : [])]) walkCond(sub, ev, where)
  if (c.at) for (const n of [].concat(c.at)) if (!nodeIds.has(n)) E(`${ev} ${where}: at 指向不存在的節點 → ${n}`)
  if (c.onEdge && !edgeIds.has(c.onEdge)) E(`${ev} ${where}: onEdge 不存在 → ${c.onEdge}`)
  if (c.has?.item && !itemIds.has(c.has.item)) E(`${ev} ${where}: has.item 不存在 → ${c.has.item}`)
  if (c.canAfford && !itemIds.has(c.canAfford)) E(`${ev} ${where}: canAfford 不存在 → ${c.canAfford}`)
  if (c.cannotAfford && !itemIds.has(c.cannotAfford)) E(`${ev} ${where}: cannotAfford 不存在 → ${c.cannotAfford}`)
  if (c.npc?.id && !npcIds.has(c.npc.id)) E(`${ev} ${where}: npc 不存在 -> ${c.npc.id}`)
  if (c.knowsRoute && !edgeIds.has(c.knowsRoute)) E(`${ev} ${where}: knowsRoute 不存在 → ${c.knowsRoute}`)
  if (c.hours) {
    const [f, t] = c.hours
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f > 23 || t < 0 || t > 24)
      E(`${ev} ${where}: hours 值域非法 → ${JSON.stringify(c.hours)}`)
  }
}

for (const ev of events) {
  walkCond(ev.where, ev.id, 'where')
  walkCond(ev.when, ev.id, 'when')
  walkCond(ev.requires, ev.id, 'requires')
  if (!Array.isArray(ev.choices) || ev.choices.length === 0) E(`event ${ev.id}: 必須至少有一個 choice`)
  if (!ev.name || ev.name === ev.id) E(`event ${ev.id}: 缺 name（死亡回溯的決策鏈要給人讀，不能顯示內部 id）`)
  // ★★ weight 的兩個方向都是靜默的死內容，而舊版【零校驗】（grep -c weight = 0）：
  //   · weight: 0  → pickWeighted 的 x -= Math.max(0, 0) 永不使 x < 0，恆不被抽中
  //                  （實測進池 8000 次、抽出 0 次；對照 weight 20 抽出 398 次）
  //   · 整行刪掉 → Math.max(0, undefined) = NaN 使 total = NaN、迴圈永不命中，
  //                  落到 return weights.length - 1，於是那個事件被抽出 8000/8000
  //   兩者都是「暫時關掉一個事件」最常見的手法，而八道閘全部放行。
  if (!Number.isInteger(ev.weight) || ev.weight <= 0) {
    E(`event ${ev.id}: weight 必須是正整數（現為 ${JSON.stringify(ev.weight)}）——`
      + ` 0 恆不被抽中；缺失會讓 pickWeighted 落到 NaN 分支而恆被抽中。兩個方向都是靜默的。`)
  }
  // cooldownDays 大於局長度 = 「一局只出現一次」的偽裝寫法，應該寫 once: true
  if (ev.cooldownDays !== undefined
    && (!Number.isInteger(ev.cooldownDays) || ev.cooldownDays < 0 || ev.cooldownDays > LAST_DAY)) {
    E(`event ${ev.id}: cooldownDays 必須是 0..${LAST_DAY} 的整數（現為 ${JSON.stringify(ev.cooldownDays)}）——`
      + ` 大於局長度等於「一局只出現一次」，那應該寫成 once: true 才讀得出意圖。`)
  }
  for (const [n, ch] of (ev.choices ?? []).entries()) {
    walkCond(ch.requires, ev.id, `choice[${n}].requires`)
    if (ch.gain?.item && !itemIds.has(ch.gain.item)) E(`event ${ev.id} choice[${n}]: gain.item 不存在 → ${ch.gain.item}`)
    if (ch.spend?.item && !itemIds.has(ch.spend.item)) E(`event ${ev.id} choice[${n}]: spend.item 不存在 → ${ch.spend.item}`)
    if (ch.gain?.npc?.id && !npcIds.has(ch.gain.npc.id)) E(`event ${ev.id} choice[${n}]: gain.npc 不存在 -> ${ch.gain.npc.id}`)
    if (ch.gain?.learnRoute && !edgeIds.has(ch.gain.learnRoute))
      E(`event ${ev.id} choice[${n}]: learnRoute 不存在 → ${ch.gain.learnRoute}`)
    if (ch.cost?.minutes !== undefined && (!Number.isInteger(ch.cost.minutes) || ch.cost.minutes < 0))
      E(`event ${ev.id} choice[${n}]: cost.minutes 必須為非負整數`)
    if (ch.spend?.copper !== undefined && !Number.isInteger(ch.spend.copper))
      E(`event ${ev.id} choice[${n}]: spend.copper 必須為整數銅`)
    // ② 公平性：有致命或帶傷風險者，該風險必須有 tell
    for (const r of ch.risks ?? []) {
      if (!r.tell || String(r.tell).trim().length < 8)
        E(`event ${ev.id} choice[${n}]: 帶風險的選項必須有長度 ≥8 的 tell（支柱三）`)
    }
  }
  // ② 事件層級：標記 lethal 者必須有 tell
  if (ev.lethal && (!ev.tell || ev.tell.trim().length < 12))
    E(`event ${ev.id}: 標記 lethal 者必須有長度 ≥12 的 tell（支柱三：不得存在無預警的致命隨機事件）`)
}

// ③ 出處覆蓋率
const all = [
  ...nodes.map((x) => ['node', x]),
  ...edges.map((x) => ['edge', x]),
  ...items.map((x) => ['item', x]),
  ...jobs.map((x) => ['job', x]),
  ...events.map((x) => ['event', x]),
  ...npcs.map((x) => ['npc', x]),
]
let canonN = 0, derivedN = 0, inventedN = 0
for (const [kind, x] of all) {
  if (!x.src) { E(`${kind} ${x.id}: 缺 src 出處標記`); continue }
  if (x.src.startsWith('canon:')) canonN++
  else if (x.src.startsWith('derived:')) derivedN++
  else if (x.src.startsWith('invented:')) inventedN++
  else E(`${kind} ${x.id}: src 前綴必須是 canon: / derived: / invented: → ${x.src}`)
}
const totalSrc = canonN + derivedN + inventedN
const inventedPct = totalSrc ? (inventedN / totalSrc) * 100 : 0
if (inventedPct > 20) E(`invented 比例 ${inventedPct.toFixed(1)}% 超出 20% 上限`)

// 未被任何邊連到的孤立節點
for (const n of nodes) {
  if (!edges.some((e) => e.a === n.id || e.b === n.id)) warns.push(`node ${n.id} 是孤點（沒有任何邊連到它）`)
}


// ═══════════════════════════════════════════════════════════════════
// ★★ 第五輪徹查補上的四道建置期防線。
//
// 舊版的「致命必須有 tell」強制檢查【形同虛設】：
//   · 全庫沒有一個事件標 lethal: true，所以那條檢查一次都沒有生效過
//   · 路段的 riskDay/riskNight 與工作的 risks 完全不在檢查範圍內
//   · flag 的設定端與讀取端誰都不檢查
// 於是四項 blocker 一路活到玩家手上。這四道防線成本極低，但能一次擋掉它們的復發。
// 這是 codex 的 brokenCurated 稽核在遊戲側的對應物。
// ═══════════════════════════════════════════════════════════════════

// ① 路段風險 >= 10% 必須有敘事前兆（不能只給玩家一個百分比數字）
const RISK_TELL_THRESHOLD = 0.10
for (const e of edges) {
  const worst = Math.max(e.riskDay ?? 0, e.riskNight ?? 0)
  if (worst >= RISK_TELL_THRESHOLD && (!e.tell || String(e.tell).length < 8)) {
    errors.push(`edge ${e.id}: 風險 ${Math.round(worst * 100)}% >= 10% 但沒有 tell —— 支柱三要求敘事前兆，不是只給一個百分比`)
  }
}

// ② 工作的每一項風險都要有 tell（舊版零覆蓋）
for (const j of jobs) {
  for (const r of j.risks ?? []) {
    if (!r.tell || String(r.tell).length < 8) {
      errors.push(`job ${j.id}: risks 內的「${r.injury ?? '?'}」缺 tell（或短於 8 字）`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ★★★ 三道【反向】驗證器。
//
// 為什麼要「反向」：既有的檢查全部是同一個方向——
//   「這個參照指到的東西存在嗎」（learnRoute → 邊存在、spend.item → 物品存在、
//    npc.id → NPC 存在）。那個方向抓的是【拼錯】。
//
// 但本專案反覆踩到的不是拼錯，是【另一個方向的空缺】：
//   東西宣告了，卻沒有任何人去用它／去減少它／去教它。
//   那種缺陷【通過全部既有驗收】，因為每一條參照本身都合法。
//
// 一次跨三個子系統的稽核把它們找出來，而三者是【同一個空缺的三個症狀】：
//   · 一條 learned 邊沒有任何事件教 → 地圖上永遠釣著玩家的虛線
//   · 一個宣告 uses: 30 的打火機沒有任何地方扣它 → 永不耗盡的火源
//   · 兩個謂詞有完整實作但 Ctx 從不填 → 照規格寫的事件永遠不觸發，測試全綠
//
// 根因（稽核的結論，逐字記在這裡）：
//   「這個專案的驗收標準大量寫在 .md 裡，而不是寫在會 exit 1 的腳本裡。」
// 下面三道就是把那三條宣告搬進會 exit 1 的地方。
// ═══════════════════════════════════════════════════════════════════

// ④ 每條 learned 邊都必須有【教它的來源】。
//
// 既有檢查只做 learnRoute → 邊存在（單向）。於是新增一條 learned 邊而忘記寫教學事件時，
// 那條邊在地圖上以虛線顯示（「有路，但你還不知道怎麼走」）卻【永遠學不到】。
// 實例：e:grotto-cathedral-cliffpath 加進來當天就是這個狀態，
// 而 pareto-check 用「learned 邊全知」做路線分析，還把它算進 Pareto 集。
{
  const taught = new Map() // edgeId → 教它的事件 id
  for (const ev of events) {
    for (const ch of ev.choices ?? []) {
      if (ch.gain?.learnRoute) taught.set(ch.gain.learnRoute, ev.id)
    }
  }
  for (const e of edges) {
    if (e.knowledge !== 'learned') continue
    if (!taught.has(e.id)) {
      E(`edge ${e.id}（${e.name}）標 knowledge: learned，但【沒有任何事件的 gain.learnRoute 教它】`
        + ` —— 它會在地圖上以虛線永久釣著玩家，且 pareto-check 會把一條不可得的邊算進最優集。`
        + ` 修法二選一：寫一個教它的事件，或改成 knowledge: public。`)
    }
  }
}

// ⑤ 每個宣告 uses 的消耗品都必須有【至少一條會減少它的玩家路徑】。
//
// `uses: N` 的語意是「N 次用完」（實作為 carry[].count，見 reduce.ts:909），
// 而 02_character_and_items.md 明訂「凡消耗品皆嚴格單調遞減，且永不回補」、
// 「可省著用，這本身是一項要學的生活技能」。
// 一個永不遞減的消耗品直接抹掉那條設計，而它通過全部既有驗收——
// 因為 requires.has.item 是合法參照，只是它【不消耗】。
//
// ★ 消耗通道一律【從原始碼與內容抽出】，不寫死清單，否則這道檢查自己就會過期：
//   (a) 內容側 spend.item
//   (b) 引擎側 removeItem(s, 'item-xxx') 的字面呼叫（treat 的兩條路）
//   (c) useItem —— 但只算 UI 真的提供入口的那些（App.tsx 的 EDIBLE）
//
// ★★ 刻意【不把「可賣掉」算成消耗通道】：uses 講的是「用掉幾次」，
//   而賣掉是一次性換錢、不表達「省著用」。若把賣算進去，
//   任何有 sellCopper 的消耗品都會蒙混過關，這道檢查就白做了。
{
  // ★ 一律剝註解。註解掉一行 removeItem 是最常見的「暫時停用」手法，
  //   而舊版會把那行註解算成一條真的消耗通道。
  const engineSrc = srcOf('src/engine/reduce.ts')
  const uiSrc = srcOf('src/ui/App.tsx')

  const channels = new Map() // itemId → [通道說明]
  const note = (id, why) => { if (!channels.has(id)) channels.set(id, []); channels.get(id).push(why) }

  for (const ev of events) {
    for (const ch of ev.choices ?? []) if (ch.spend?.item) note(ch.spend.item, `事件 ${ev.id} 的 spend.item`)
  }
  for (const m of engineSrc.matchAll(/removeItem\(\s*(?:s|\{[^)]*\})\s*,\s*'([^']+)'/g)) {
    note(m[1], 'reduce.ts 的 removeItem 字面呼叫')
  }
  // App.tsx 的 EDIBLE 對照表 —— useItem 的唯一 UI 入口
  const edibleBlock = /const EDIBLE[^=]*=\s*\{([\s\S]*?)\}/.exec(uiSrc)
  if (!edibleBlock) {
    warns.push('validate-data ⑤：在 App.tsx 找不到 EDIBLE 對照表，useItem 通道無法認定'
      + '（若該表被改名，這道檢查會開始誤報——請同步這裡）')
  } else {
    for (const m of edibleBlock[1].matchAll(/'([^']+)'\s*:/g)) note(m[1], 'useItem（App.tsx 的 EDIBLE）')
  }

  for (const it of items) {
    if (it.uses === undefined) continue
    if (channels.has(it.id)) continue
    E(`item ${it.id}（${it.name}）宣告 uses: ${it.uses}，但【沒有任何路徑會減少它】`
      + ` —— 既沒有事件 spend.item、引擎沒有 removeItem 它、useItem 也沒有入口。`
      + ` 它是一個永不耗盡（或完全用不到）的消耗品，違反「凡消耗品皆嚴格單調遞減」。`)
  }
}

// ⑥ 每個條件 DSL 謂詞都必須【至少有一個實例】，且必須【結構上可能為真】。
//
// 這一道抓的是最壞的一種缺陷：謂詞有完整實作、tsc 全綠、測試全綠，
// 但它依賴的 Ctx 欄位【從來沒有人填】，所以照規格寫出來的事件永遠不會觸發。
// 實例：onEdge 與 tideJustTurned 在 cond.ts 有實作，
// 而唯一的 Ctx 工廠 ctxOf(s, idx, onEdge?, justTurned?) 的【全部呼叫點都只傳兩個參數】。
//
// 沒有任何既有測試能抓到它，因為沒有測試斷言「每個謂詞至少有一個可觸發實例」。
{
  const typesSrc = (() => { try { return fs.readFileSync(path.join(here, '..', 'src/engine/types.ts'), 'utf-8') } catch { return '' } })()
  /**
   * ★ 支援 `export interface Cond extends X {`：舊版的正則要求 Cond 後緊接 " {"，
   *   於是一次「抽出共用父介面」的重構就會讓整道 ⑥ 失效。
   *
   * ★★ 而它【必須走 anchor（error）而不是 warns】。
   *   第一版我只拿掉了 warns 分支、忘了把 exec 換成 anchor——
   *   結果錨點失效變成【完全無聲】：整道閘直接跳過，一個字都不印，exit 0。
   *   那比原本的警告版更糟，而它只在反向測試（把 Cond 改名）時才露出來。
   */
  const condBlock = anchor(/export interface Cond(?:\s+extends\s+[^{]+)?\s*\{([\s\S]*?)\n\}/,
    typesSrc, '在 types.ts 找不到 export interface Cond 的主體')
  const STRUCTURAL = new Set(['all', 'any', 'not'])

  /**
   * 明列的例外。★ 每一筆都必須寫【為什麼】——
   * 這個白名單的用途是把「靜默的死謂詞」變成「一個寫下來的決定」，
   * 不是用來讓檢查閉嘴。
   */
  const UNUSED_OK = {
    onEdge: {
      onUse: 'error',
      why: '路段上的事件【功能未建】：travel 只逐邊做風險判定，從不帶邊的上下文抽事件，'
        + '所以沒有任何 ctxOf 呼叫點會填 onEdge。保留謂詞是因為 03_condition_dsl.md 把它列為'
        + ' P0 謂詞集，而路段事件排 P2。',
    },
    tideJustTurned: {
      onUse: 'error',
      why: '同上：沒有任何 ctxOf 呼叫點會填 tideJustTurned。原規格要它表達「潮水剛轉」，'
        + '目前內容改用 tide 表達「現在是漲/退潮」，語意較寬但可用。',
    },
    rep: {
      onUse: 'error',
      why: '聲望系統【只有讀取端】：cond.ts 讀 s.rep，而全 src 唯一寫入是 initialState 的 rep: {}，'
        + 'Choice.gain 連 rep 格位都沒有。所以任何 rep 條件恆為「拿 0 去比」＝恆假。'
        + '（另外 FactionId 是 string 且 data/ 沒有 faction 註冊表，所以連 id 拼錯都沒有人查——'
        + '日後接上聲望系統時要一併建 data/factions.json 並在 walkCond 補存在性檢查。）',
    },
    onAction: { onUse: 'error', why: '連型別都沒有，僅存在於設計文件的謂詞清單裡。' },
    givenAway: {
      onUse: 'ok',
      why: '「無償把東西給出去的次數」——計數器【有增也有讀】（gain.giveAway 增、'
        + '局末摘要「把東西給出去 N 次」讀），只是作為【條件】還沒有任何事件或結局用它。'
        + '三條結局刻意都不要求它——「給過幾次」不該變成一張門票。'
        + '★ 這一行是驗證器逼出來的一個【寫下來的決定】，不是讓它閉嘴。',
    },
  }

  // 每個謂詞讀哪個【選用的】Ctx 欄位（決定它是否結構上可能為真）
  /**
   * ★★ Ctx 的【選用】欄位由型別自己列舉，不再維護一張硬寫的對照表。
   *   舊版的 `CTX_DEP = { onEdge: ..., tideJustTurned: ... }` 硬寫兩筆，
   *   於是新增第三個選用 Ctx 欄位時查不到它 → dep=undefined → 自動判定為可達。
   */
  const ctxSrc = srcOf('src/engine/cond.ts')
  const ctxBlock = anchor(/export interface Ctx\s*\{([\s\S]*?)\n\}/, ctxSrc, '在 cond.ts 找不到 export interface Ctx')
  const ctxOptional = new Set(
    ctxBlock
      ? topLevelKeys(ctxBlock[1]).filter((k) => new RegExp(`\\b${k}\\?\\s*:`).test(stripComments(ctxBlock[1])))
      : [],
  )

  /**
   * 哪些【選用的 Ctx 欄位】真的有人填。
   *
   * ★ 改成掃「ctxOf 的實參物件裡出現的鍵名」而不是數參數個數。
   *   ctxOf 的簽章已改為具名物件（見 reduce.ts 該函式的註解），所以這裡問的是
   *   「有沒有一處寫了 `onEdge:`」——鍵名就是欄位名。
   *   對型別包裝免疫（實參是值不是型別）、新增欄位自動生效。
   *
   * ★ 只掃 src/：測試腳本把 onEdge 傳進去，不會讓玩家在遊戲裡碰得到它。
   *   且已剝註解——⑥ 曾經把自己的說明註解算成一個呼叫點。
   */
  const ctxFilled = (() => {
    const filled = new Set()
    for (const m of engineAndCallers().matchAll(/ctxOf\(([\s\S]{0,240}?)\)/g)) {
      const args = m[1]
      if (/:\s*(GameState|Index)/.test(args)) continue // 函式宣告自身
      for (const k of ctxOptional) if (new RegExp(`\\b${k}\\s*:`).test(args)) filled.add(k)
    }
    return filled
  })()
  /**
   * ★★ 只掃 src/，而且【先剝掉註解】。兩者都是被自己咬過之後才寫對的。
   *
   * 第一版掃 src/engine + src/ui + scripts，而 scripts/ 裡就有這個檔案本身——
   * 於是上面那段解釋「ctxOf(s, idx, onEdge?, justTurned?) 的全部呼叫點都只傳兩個參數」
   * 的【註解】被當成一個四參數的呼叫點，ctxArity 算成 4，
   * reachable 恆為 true，整道「結構上永遠為假」的檢查【靜默失效】。
   *
   * 驗證器被自己的文件打敗了——而它偏偏就是為了抓這種東西而存在的。
   * 若不是刻意注入一個 onEdge 事件去反向測試，這個洞會永久留著且永遠是綠的。
   *
   * ★ 順帶把語意修對：可達性只該看 src/。
   *   測試腳本裡呼叫 ctxOf 時傳了 onEdge，【不會】讓玩家在遊戲裡碰得到它。
   */
  function engineAndCallers() {
    const strip = (t) => t
      .replace(/\/\*[\s\S]*?\*\//g, '')  // 區塊註解（含 JSDoc）
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行註解（避開 https:// 的 //）
    const parts = []
    for (const dir of ['src/engine', 'src/ui']) {
      const abs = path.join(here, '..', dir)
      if (!fs.existsSync(abs)) continue
      for (const f of fs.readdirSync(abs)) {
        if (!/\.(ts|tsx)$/.test(f)) continue
        parts.push(strip(fs.readFileSync(path.join(abs, f), 'utf-8')))
      }
    }
    return parts.join('\n')
  }

  // 統計每個謂詞在內容裡的實例數
  const used = new Map()
  const bump = (k) => used.set(k, (used.get(k) ?? 0) + 1)
  const walkKeys = (c) => {
    if (!c || typeof c !== 'object') return
    for (const k of Object.keys(c)) {
      if (STRUCTURAL.has(k)) continue
      bump(k)
    }
    for (const sub of [...(c.all ?? []), ...(c.any ?? []), ...(c.not ? [c.not] : [])]) walkKeys(sub)
  }
  for (const ev of events) {
    walkKeys(ev.where); walkKeys(ev.when); walkKeys(ev.requires)
    for (const ch of ev.choices ?? []) walkKeys(ch.requires)
  }
  for (const j of jobs) walkKeys(j.requires)
  for (const e of endings) walkKeys(e.requires)

  if (condBlock) {
    // ★ 用括號深度掃頂層鍵，不用縮排（見 topLevelKeys 的註解：同行 JSDoc 會讓謂詞隱形）
    const declared = topLevelKeys(condBlock[1]).filter((k) => !STRUCTURAL.has(k))

    for (const k of declared) {
      const n = used.get(k) ?? 0
      // 這個謂詞讀哪個選用的 Ctx 欄位？（同名即依賴——onEdge 讀 ctx.onEdge）
      const dep = ctxOptional.has(k) ? k : null
      const reachable = dep ? ctxFilled.has(dep) : true

      if (n > 0 && !reachable) {
        E(`謂詞「${k}」在內容裡用了 ${n} 次，但它讀的 ctx.${dep} 【沒有任何 ctxOf 呼叫點會填】`
          + `（src/ 裡沒有任何 ctxOf 呼叫點寫了 "${dep}:" 這個鍵）—— 那些條件【結構上永遠為假】，`
          + `用到它的事件永遠不會觸發，而所有測試都會通過。`
          + ` 修法：讓對應的 action 呼叫 ctxOf 時把 ${dep} 傳進去，或別用這個謂詞。`)
        continue
      }
      if (n === 0 && !(k in UNUSED_OK)) {
        E(`謂詞「${k}」在 Cond 有宣告，但【全部內容零實例】。`
          + ` 這要麼是一個沒接上的機制，要麼是一個該刪的殘留——`
          + ` 兩者都不該靜默存在。請在 validate-data 的 UNUSED_OK 補一行【寫明理由】，或刪掉它。`)
      }
    }
    /**
     * ★★★ 反向的反向：內容用了一個 Cond 【沒有宣告】的謂詞。
     *
     * 這一項比 ⑥ 原本防的那件事嚴重得多，方向也相反：
     *   · 原本防的是「謂詞沒人用」→ 死內容（玩家看不到你寫的東西）
     *   · 這一項防的是「用了一個不存在的謂詞」→ 門禁【整條消失】
     *
     * 因為 evaluate 舊版對不認識的鍵不做任何事、最後 return true。
     * 所以把 flag 打成 flagg，那個事件不是永遠不觸發，是【無條件觸發】。
     * 而 reach-test 只守 16 個登記過的主線事件，其餘 48 個沒有人在看。
     *
     * 根本修法已經下在求值器本身（cond.ts 的 COND_KEYS 會直接拋錯），
     * 這一道是建置期的第二層：讓它在跑起來之前就被指名道姓地擋下。
     */
    for (const [k, n] of used) {
      if (STRUCTURAL.has(k)) continue
      if (declared.includes(k)) continue
      E(`謂詞「${k}」在內容裡用了 ${n} 次，但 Cond 【沒有宣告它】——`
        + ` 求值器會拋錯（cond.ts 的 COND_KEYS），而在加上那道防線之前它會【靜默回傳 true】，`
        + ` 也就是那條 where/when/requires 等於沒寫、事件無條件觸發。多半是拼錯。`)
    }

    /**
     * ★ 執行期的 COND_KEYS 必須與型別的 Cond 逐鍵相同。
     *   兩份清單分歧的兩個方向都危險：
     *   · 型別有、COND_KEYS 沒有 → 一個合法謂詞會在執行期被當成拼錯而拋錯（遊戲當場壞）
     *   · COND_KEYS 有、型別沒有 → 那個鍵回到「靜默忽略」的舊行為
     */
    const condSrc = srcOf('src/engine/cond.ts')
    const keysBlock = anchor(/export const COND_KEYS = new Set\(\[([\s\S]*?)\]\)/, condSrc,
      '在 cond.ts 找不到 export const COND_KEYS')
    if (keysBlock) {
      const runtime = [...keysBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      const missing = [...declared, ...STRUCTURAL].filter((k) => !runtime.includes(k))
      const extra = runtime.filter((k) => !declared.includes(k) && !STRUCTURAL.has(k))
      if (missing.length) {
        E(`cond.ts 的 COND_KEYS 缺少型別 Cond 有宣告的謂詞：${missing.join('、')}`
          + ` —— 那些謂詞一被使用就會在執行期被誤判為拼錯並拋錯。`)
      }
      if (extra.length) {
        E(`cond.ts 的 COND_KEYS 多出型別 Cond 沒有的鍵：${extra.join('、')}`
          + ` —— 那些鍵會回到「靜默忽略、回傳 true」的舊行為，也就是門禁消失。`)
      }
    }

    /**
     * ★★ 白名單保鮮：依 onUse 分流，而不是一律給一句「可以移除了」的警告。
     *
     * 舊版對【任何】已被使用的白名單謂詞都只 warns.push「可以從 UNUSED_OK 移除了」——
     * 而 rep 的真相是「這個實例是死的」。於是照設計文件寫一條聲望條件的人，
     * 會得到一個永不觸發的事件，外加一句【鼓勵他刪掉那行例外註記】的警告。
     * 方向剛好相反。
     *
     * onUse: 'error' ＝ 這個謂詞沒有寫入端，一被使用就是恆假，必須擋。
     * onUse: 'ok'    ＝ 只是還沒有人用它作為條件，用了就該把它從表裡移除。
     */
    for (const [k, spec] of Object.entries(UNUSED_OK)) {
      if (!declared.includes(k)) continue
      const n = used.get(k) ?? 0
      if (n === 0) continue
      if (spec.onUse === 'error') {
        E(`謂詞「${k}」在內容裡用了 ${n} 次，但 UNUSED_OK 記載它【沒有寫入端】——`
          + ` 那些條件結構上永遠為假，用到它的事件永遠不會觸發，而所有測試都會通過。`
          + ` 理由：${spec.why}`
          + ` 修法：接上寫入端，或別用這個謂詞。`)
      } else {
        warns.push(`謂詞「${k}」已經有 ${n} 個實例，可以從 UNUSED_OK 移除了`)
      }
    }
  }
}

// ②-bis ★★ 玩家看得到的欄位裡不得出現設計註記。
//
// 為什麼需要這一道：瀏覽器實跑第五章時，「還沒有」畫面上並排印出三扇門，
// 而其中一扇門的 asks 寫著「★ 這是三條裡唯一用錢的一條，也理應是最緊的一條」——
// 那就是【在畫面上替三條結局排序】，逐字違反 engine/ending.ts 檔頭自己訂的版面禁令。
// 同一輪還抓到 end-trade 的正文對玩家說「canon 寫得很明白」（破第四面牆）。
//
// ★ 兩者都是我自己寫的，而且都通過了當時全部的驗收——因為【沒有人在檢查這件事】。
//   設計理由該留在 YAML 註解裡；一旦它進了 asks／gaveUp／text，它就是台詞。
//
// ★ 刻意【不查 name】：事件名會出現在死亡回溯的決策鏈裡，
//   而「★★ 城衛查籍」這種標記主線份量的寫法是既有的、刻意的慣例。
{
  const MARK = [
    ['★', '設計標記'],
    ['canon', '正典檔名／術語（玩家不知道 canon 是什麼）'],
    ['.md', '檔名'],
    ['design/', '設計文件路徑'],
    ['支柱', '遊戲憲法術語'],
    ['禁忌', '遊戲憲法術語'],
    ['違憲', '遊戲憲法術語'],
    ['reducer', '程式術語'],
    ['遊戲不會', '以「遊戲」自稱＝破第四面牆'],
    ['遊戲也不', '以「遊戲」自稱＝破第四面牆'],
    ['遊戲不得', '以「遊戲」自稱＝破第四面牆'],
  ]
  const scan = (id, field, txt) => {
    if (typeof txt !== 'string') return
    for (const [needle, why] of MARK) {
      if (!txt.includes(needle)) continue
      const line = txt.split('\n').find((l) => l.includes(needle)) ?? txt
      errors.push(`${id} 的 ${field} 含設計註記「${needle}」（${why}）——這是玩家看得到的欄位，`
        + `理由請移到 YAML 註解：「${line.trim().slice(0, 60)}」`)
    }
  }
  for (const e of events) {
    scan(e.id, 'text', e.text); scan(e.id, 'tell', e.tell)
    for (const c of e.choices ?? []) { scan(e.id, `choices[${c.label}].resultText`, c.resultText); scan(e.id, 'choice label', c.label) }
  }
  for (const e of endings) {
    scan(e.id, 'text', e.text); scan(e.id, 'asks', e.asks)
    scan(e.id, 'gaveUp', e.gaveUp); scan(e.id, 'tagline', e.tagline)
  }
  // ★ 節點描述與物品說明同樣是玩家看得到的（here.desc 就印在敘事區、it.desc 印在背包）。
  //   第一版這道閘只查事件與結局，於是我立刻在新增的城區 desc 裡寫了「★ 治安一級」——
  //   同一個錯誤，換一個欄位。閘門要涵蓋【全部】呈現給玩家的文字，否則它只是抓上一次的錯。
  for (const n of nodes) scan(n.id, 'desc', n.desc)
  for (const it of items) { scan(it.id, 'desc', it.desc); scan(it.id, 'name', it.name) }
  for (const j of jobs) scan(j.id, 'tell', j.tell)
  for (const n of npcs) { scan(n.id, 'desc', n.desc)
    for (const [i, l] of (n.talkLines ?? []).entries()) scan(n.id, `talkLines[${i}]`, l) }

  // ★★ 兩級的分野：敘事文字 vs 機制提示。
  //
  //   npc.effect 與 job.desc 是【機制提示】欄位——它們的工作就是告訴玩家
  //   「這個關係會改變什麼」「這份工要付什麼」。它們用 ★ 當項目符號
  //   （同局末摘要的「★ 里程碑」），那是強調而不是設計註記，所以不查 ★。
  //
  //   但它們仍然不得洩漏正典檔名、遊戲憲法術語，或以「遊戲」自稱——
  //   那些在任何欄位都是洩漏。
  const scanHint = (id, field, txt) => {
    if (typeof txt !== 'string') return
    for (const [needle, why] of MARK) {
      if (needle === '★' || !txt.includes(needle)) continue
      const line = txt.split('\n').find((l) => l.includes(needle)) ?? txt
      errors.push(`${id} 的 ${field} 含設計註記「${needle}」（${why}）——機制提示欄位可用 ★ 當符號，`
        + `但不得洩漏這個：「${line.trim().slice(0, 60)}」`)
    }
  }
  for (const n of npcs) scanHint(n.id, 'effect', n.effect)
  for (const j of jobs) scanHint(j.id, 'desc', j.desc)
}

// ③ flag 雙向斷鏈：讀了沒人設 = 錯誤；設了沒人讀 = 警告
{
  const setFlags = new Set()
  const readFlags = new Set()
  const walkCond = (c) => {
    if (!c || typeof c !== 'object') return
    if (typeof c.flag === 'string') readFlags.add(c.flag)
    for (const k of ['all', 'any']) if (Array.isArray(c[k])) c[k].forEach(walkCond)
    if (c.not) walkCond(c.not)
  }
  for (const ev of events) {
    walkCond(ev.where); walkCond(ev.when); walkCond(ev.requires)
    for (const ch of ev.choices ?? []) {
      walkCond(ch.requires)
      for (const f of [ch.gain?.flag ?? []].flat()) setFlags.add(f)
    }
  }
  for (const j of jobs) walkCond(j.requires)
  // ★ 結局的 requires 也是讀取端。漏掉它會讓這道警告【指著對的方向說錯的話】：
  //   一個只被結局條件讀的 flag 會被誤報成「沒人讀」，而誤報幾次之後
  //   整份警告就會開始被跳過——那才是真正的損失。
  for (const e of endings) { walkCond(e.requires); if (e.aim) readFlags.add(e.aim) }
  // ★ UI 也是讀取端：局末摘要用 s.flags['...'] 呈現玩家的決定。
  //   那片滓的四種下場就只有摘要在讀（見 App.tsx 的 Stats），
  //   而「一個不留下任何痕跡的決定」跟沒有這個決定是一樣的——所以摘要【算】讀。
  for (const dir of ['../src/ui/', '../src/engine/']) {
    for (const f of fs.readdirSync(new URL(dir, import.meta.url))) {
      if (!/\.(tsx?|ts)$/.test(f)) continue
      const src = fs.readFileSync(new URL(dir + f, import.meta.url), 'utf-8')
      for (const m of src.matchAll(/flags\[['"]([^'"]+)['"]\]/g)) readFlags.add(m[1])
    }
  }
  // 引擎自己會設的 flag（不是資料設的），列入白名單
  const ENGINE_SET = ['wears-local']
  for (const f of ENGINE_SET) setFlags.add(f)
  // 引擎自己會讀的 flag 前綴
  const isEngineRead = (f) => f.startsWith('treated:') || f.startsWith('dep:')

  const neverSet = [...readFlags].filter((f) => !setFlags.has(f) && !isEngineRead(f))
  const neverRead = [...setFlags].filter((f) => !readFlags.has(f) && !ENGINE_SET.includes(f))
  for (const f of neverSet) {
    errors.push(`flag「${f}」被條件讀取但【沒有任何地方會設定它】—— 該事件是死事件，永遠不會觸發`)
  }
  if (neverRead.length > 0) {
    warns.push(`flag 設了但沒人讀（${neverRead.length} 個，可能是接錯鍵或伏筆未完成）：${neverRead.join('、')}`)
  }
}

/**
 * ⑦ item 雙向斷鏈：被條件讀取但【沒有任何取得通道】＝死事件。
 *
 * ★ 這一道的形狀刻意抄 ③（flag 雙向斷鏈）。而它的存在本身就是一個發現：
 *   ③ 對「flag 讀了沒人設」是 error，訊息還逐字寫「該事件是死事件，永遠不會觸發」，
 *   而【完全同一個形狀】的 item 版本零檢查——
 *   一個不在任何 node.sells、沒有任何 gain.item、也不是開場物的物品，
 *   可以大方地當事件的 requires.has.item，那個事件就是死的，而八道閘全綠。
 *   既有的檢查只做 `has.item → 物品存在` 的單向拼字。
 *
 * 取得通道只有三條（grep 實證）：node.sells（buy 的唯一入口被 here.sells 鎖住）、
 * 事件的 gain.item、以及開場六選三的 PICKABLE。
 */
{
  const obtainable = new Set()
  for (const n of nodes) for (const it of n.sells ?? []) obtainable.add(it)
  for (const ev of events) for (const ch of ev.choices ?? []) if (ch.gain?.item) obtainable.add(ch.gain.item)
  const pick = anchor(/const PICKABLE[^=]*=\s*\[([\s\S]*?)\]/, srcOf('src/ui/App.tsx'),
    '在 App.tsx 找不到 PICKABLE（開場六選三的物品清單）')
  for (const m of (pick?.[1] ?? '').matchAll(/'([^']+)'/g)) obtainable.add(m[1])

  /**
   * ★ canAfford 刻意【不算】「需要持有」：它查的是錢包夠不夠，
   *   是拿物價當基準的寫法（例如結局用租約的價格表示「下一輪的租金已經在桌上」）。
   *   把它算成需要持有，這道閘一上線就誤報。
   */
  const needed = new Map()
  const wantItem = (c, where) => {
    if (!c || typeof c !== 'object') return
    if (c.has?.item) needed.set(c.has.item, where)
    for (const sub of [...(c.all ?? []), ...(c.any ?? []), ...(c.not ? [c.not] : [])]) wantItem(sub, where)
  }
  for (const ev of events) {
    wantItem(ev.requires, ev.id); wantItem(ev.where, ev.id); wantItem(ev.when, ev.id)
    for (const [i, ch] of (ev.choices ?? []).entries()) {
      wantItem(ch.requires, `${ev.id} choice[${i}]`)
      if (ch.spend?.item) needed.set(ch.spend.item, `${ev.id} choice[${i}] 的 spend`)
    }
  }
  for (const j of jobs) wantItem(j.requires, j.id)
  for (const e of endings) wantItem(e.requires, e.id)

  for (const [id, where] of needed) {
    if (obtainable.has(id)) continue
    E(`item「${id}」被 ${where} 的條件讀取，但【沒有任何取得通道】——`
      + ` 不在任何 node.sells、沒有任何事件的 gain.item、也不是開場六選三之一。`
      + ` 那是死事件，永遠不會觸發（比照 ③ flag 雙向斷鏈的同一個形狀）。`)
  }
}

/**
 * ⑧ node.services 的值域與讀取端。
 *
 * ★ 這道閘要處理的是一個【假直覺】：寫了 service 就以為那個設施會存在。
 *   實測：資料裡 20 種 service 值，src 真正讀到的只有 5 種。
 *   而打錯字的後果是靜默的——`sleep-room` 打錯 → 12 銅單間那顆按鈕整顆不 render，
 *   沒有任何替代路徑、也沒有任何閘會紅（實測九閘全綠）。
 *
 * ★ DECORATIVE_OK 逼出 15 個「寫下來的決定」，這正是 UNUSED_OK 已經證明有效的模式：
 *   不是讓檢查閉嘴，是把「這個值目前只是氛圍」變成一句可查的話。
 */
{
  const blk = anchor(/export const SERVICES[^=]*=\s*\[([\s\S]*?)\]\s*as const/, srcOf('src/engine/types.ts'),
    '在 types.ts 找不到 export const SERVICES 詞彙表')
  const VOCAB = new Set([...((blk?.[1]) ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]))
  /**
   * ★★ 讀取端只認【真正的讀取寫法】，不做寬鬆的字串包含。
   *
   * 第一版寫 readers.includes(`'${sv}'`)，於是 'buy' 與 'sell' 被判定為「有讀取端」——
   * 而它們命中的其實是【動作名】（reduce.ts 的 `case 'buy':`、`t: 'buy'`），
   * 跟 node.services 毫無關係。那是一個偽綠燈，而它出現在一道
   * 【專門用來抓偽綠燈的閘】裡面，第一次跑就發生。
   *
   * 真正的讀取只有兩種形狀：
   *   ① 字面：here.services.includes('sleep-bunk')
   *   ② 動態：node.services.includes(def.service) —— 值來自 mind.ts 的 CLEAN 表
   */
  const srcAll = srcOf('src/ui/App.tsx') + srcOf('src/engine/mind.ts')
    + srcOf('src/engine/reduce.ts') + srcOf('src/engine/map.ts')
  const readServices = new Set()
  for (const m of srcAll.matchAll(/services\??\.includes\(\s*'([^']+)'\s*\)/g)) readServices.add(m[1])
  // 動態讀取：CLEAN 表的 service 欄位（wash / well / rinse）
  const cleanBlk = anchor(/export const CLEAN[^=]*=\s*\{([\s\S]*?)\n\}/, srcOf('src/engine/mind.ts'),
    '在 mind.ts 找不到 export const CLEAN 表（services 的動態讀取端）')
  for (const m of ((cleanBlk?.[1]) ?? '').matchAll(/service:\s*'([^']+)'/g)) readServices.add(m[1])
  const AMBIENCE = '氛圍標記：這個設施【目前沒有對應的動作】。'
  const DECORATIVE_OK = {
    buy: AMBIENCE + '商店面板是由 node.sells 渲染的，不看這個值。',
    sell: AMBIENCE + '賣出是由 item.sellCopper 決定的，不看這個值。',
    alms: AMBIENCE + '救濟隊是一份 job（job-cathedral-alms），由 job.at 定位，不看這個值。',
    craft: AMBIENCE + '寂裔工藝尚未有玩家可執行的動作。',
    repair: AMBIENCE + '修理尚未實作（P2 的器物耐久度）。',
    'sell-metal': AMBIENCE + '賣鑰匙鋼走一般的 sell 動作與 item.sellCopper。',
    'buy-blackmarket': AMBIENCE + '黑市與一般商店走同一條 buy 路徑，差別只在 sells 的內容與價格。',
    'food-cheap': AMBIENCE + '食物由 node.sells 決定，這個值只表達「這裡的東西便宜」。',
    'food-cheapest': AMBIENCE + '同上。',
    drink: AMBIENCE + '烈酒尚未實作。',
    'sleep-rough': AMBIENCE + '露宿在任何節點都可以（不需要設施），所以它不該是一個條件。',
    'job-dayhire': AMBIENCE + '工作一律由 job.at 定位；這四個 job-* 值是給人讀的索引，不是機制。',
    'job-errand': AMBIENCE + '同上。',
    'job-rake': AMBIENCE + '同上。',
    'job-rope': AMBIENCE + '同上。',
  }
  for (const n of nodes) {
    for (const sv of n.services ?? []) {
      if (!VOCAB.has(sv)) {
        E(`node ${n.id}: service「${sv}」不在 types.ts 的 SERVICES 詞彙表 ——`
          + ` 多半是拼錯，而拼錯的後果是那個設施的按鈕【靜默不 render】。`)
        continue
      }
      if (!readServices.has(sv) && !(sv in DECORATIVE_OK)) {
        E(`service「${sv}」在 src 沒有任何讀取端 —— 寫了 service 卻沒有那個設施，`
          + ` 會讓「寫了就會有」變成假直覺。請接上讀取端、刪掉它，`
          + ` 或在 validate-data 的 DECORATIVE_OK 補一行【寫明理由】。`)
      }
    }
  }
  // 詞彙表自身保鮮：列在 DECORATIVE_OK 但其實已經有讀取端了
  for (const sv of Object.keys(DECORATIVE_OK)) {
    if (readServices.has(sv)) warns.push(`service「${sv}」已經有讀取端，可以從 DECORATIVE_OK 移除了`)
  }
}

/**
 * ⑨ conditions.json 的每個葉鍵都必須有【讀取端】。
 *
 * ★ 鐵律 5「敘事文本一律在 data」只寫在 .md 裡，沒有寫在會 exit 1 的地方。
 *   而它已經出過一次事：sanity.rows 的 12 條中文文案從第一天起沒有任何讀取端，
 *   而死亡回溯的決策鏈一路印內部英文鍵（「心理｜roughNight｜理智 -4」）給玩家看。
 *   內容寫了、出貨了，而引擎印的是鍵名。
 *
 * ★ 別名讀法必須支援（`const T = idx.text.treat` 之後用 `T.herbs`），
 *   否則這道閘一上線就誤報整組 treat.*。
 */
{
  const readers = srcOf('src/ui/App.tsx') + srcOf('src/engine/reduce.ts')
    + srcOf('src/engine/mind.ts') + srcOf('src/engine/body.ts') + srcOf('src/engine/map.ts')
  const flat = (o, pre = []) => Object.entries(o).flatMap(([k, v]) => (
    v && typeof v === 'object' && !Array.isArray(v) ? flat(v, [...pre, k]) : [[...pre, k].join('.')]
  ))
  /**
   * ★★ 動態索引的群組要做【雙向對應】，不能只問「有沒有讀取端」。
   *
   * sanity.rows 是用 `rowText[row.key]` 讀的，所以「有讀取端」對那個群組底下的
   * 【任何】鍵都成立——包含一個根本沒有人會產生的鬼鍵。第一版就是這樣放行的。
   *
   * 正解是比對兩個集合：資料裡的鍵 ≡ 引擎會產生的鍵。它同時抓兩個方向，
   * 而【第二個方向就是剛修掉的那個 bug】：
   *   · 資料有、引擎不產生 → 死文案（寫了永遠不會顯示）
   *   · 引擎產生、資料沒有 → 玩家會看到內部英文鍵
   *     （死亡回溯一路印「心理｜roughNight｜理智 -4」就是這一個方向）
   */
  const DYNAMIC_GROUPS = {
    'sanity.rows': {
      from: 'src/engine/mind.ts',
      // settleDay 裡的 add('roughNight', …) —— 每一個 key 都是一行日界結算
      pattern: /\badd\(\s*'([^']+)'/g,
      what: 'mind.ts 的 settleDay 用 add(key, delta) 產生的日界結算行',
    },
  }
  const dynamicHandled = new Set()
  for (const [group, spec] of Object.entries(DYNAMIC_GROUPS)) {
    const node = group.split('.').reduce((o, k) => (o ?? {})[k], conditions)
    if (!node || typeof node !== 'object') {
      E(`validate-data ⑨：conditions.json 找不到動態群組「${group}」——`
        + ` 若它被改名或刪除，這道雙向對應會靜默失效。`)
      continue
    }
    const emitted = new Set([...srcOf(spec.from).matchAll(spec.pattern)].map((m) => m[1]))
    const inData = new Set(Object.keys(node))
    for (const k of inData) {
      dynamicHandled.add(`${group}.${k}`)
      if (!emitted.has(k)) {
        E(`conditions.json 的「${group}.${k}」是死文案 —— ${spec.what} 從來不會產生這個鍵，`
          + ` 所以那段文字永遠不會顯示給玩家。`)
      }
    }
    for (const k of emitted) {
      if (!inData.has(k)) {
        E(`★ ${spec.what} 會產生「${k}」，但 conditions.json 的 ${group} 沒有對應文案 ——`
          + ` 玩家會在畫面上看到內部英文鍵「${k}」。`
          + `（這正是死亡回溯一路印「心理｜roughNight｜理智 -4」的那個缺陷。）`)
      }
    }
  }

  /**
   * ★★ 這一段是【啟發式的，有已知的漏判】，必須誠實記下來。
   *
   * 它問「葉鍵名有沒有出現在 src 裡」，而短的／常見的鍵名會被無關的屬性存取誤命中：
   *   · `sanity.bands.ok`  被 `r.ok` / `res.ok` 命中（全 src 到處都是）
   *   · `treat.does`       被任何 `.does` 命中
   * 所以它抓得到 `warmth.note` 這種較獨特的名字，抓不到 `ok`。
   *
   * ★ 這與同一輪抓到的另一個偽綠燈是同一形狀：service 的 'buy' 被動作名 `t: 'buy'` 命中。
   *   我沒有把它修成「更聰明的猜測」，因為那條路已經證明會製造偽綠燈。
   *
   * 真正 sound 的替代方案是【行為式覆蓋】：讓讀取一律經過一個會記錄鍵的 helper，
   * 在煙霧測試裡斷言覆蓋率。那與 live-reach 是同一個路子，排在它後面。
   * 在那之前，這一段是一個【會抓到一些、不保證抓完】的工具，而
   * DYNAMIC_GROUPS 的雙向對應才是這道閘裡唯一 sound 的部分。
   */
  const TEXT_OK = {}
  for (const key of flat(conditions)) {
    if (key.startsWith('_')) continue // _src 之類的中介資料
    if (dynamicHandled.has(key)) continue // 已由雙向對應處理
    const parts = key.split('.')
    const leaf = parts[parts.length - 1]
    const group = parts.slice(0, -1).join('.')
    const hit = readers.includes(`.${leaf}`) || readers.includes(`['${leaf}']`)
      || readers.includes(`text.${group}`) || readers.includes(`[${leaf}]`)
    if (!hit && !(key in TEXT_OK)) {
      E(`conditions.json 的「${key}」在 src 找不到任何讀取端 —— 那段文字永遠不會顯示給玩家。`
        + ` 修法：接上讀取端、刪掉它，或在 validate-data 的 TEXT_OK 補一行【寫明理由】。`)
    }
  }
}

// ④ UI 不得硬寫機率（舊版 App.tsx 硬寫「34% → 21%」，而真實值受髒污與體溫乘數影響可達 58%）
{
  const uiFiles = fs.readdirSync(new URL('../src/ui/', import.meta.url)).filter((f) => f.endsWith('.tsx'))
  for (const f of uiFiles) {
    const src = fs.readFileSync(new URL('../src/ui/' + f, import.meta.url), 'utf-8')
    let inBlockComment = false
    src.split('\n').forEach((line, i) => {
      // 跳過註解——註解裡引用舊的錯誤數字是【刻意】的（用來記錄為什麼那是錯的）
      const trimmed = line.trim()
      if (inBlockComment) { if (trimmed.includes('*/')) inBlockComment = false; return }
      if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) { if (!trimmed.includes('*/')) inBlockComment = true; return }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      // 只抓【字面】百分比，放行由運算式插值產生的（含 {、Math.round、toFixed）
      const m = line.match(/[^{}\w.]\d{1,3}\s*%/)
      if (m && !/Math\.round|toFixed|\$\{|width:|hsl\(/.test(line)) {
        errors.push(`src/ui/${f}:${i + 1}: UI 不得硬寫機率「${m[0].trim()}」—— 一律呼叫引擎實算（body.quoteSuppuration 等）`)
      }
    })
  }
}

// ⑥ ★ 設 path-* 者必須同時設 identity-obtained（兩者不可分歧）
//    這條缺陷的原貌：design/05_main_story.md 宣告 identity-obtained 為第三章出章 flag，
//    但它在 events.json 裡出現 0 次——因為 gain.flag 當時只放得下一個字串。
//    於是第四、五章的閘門讀一個永遠為假的 flag。
{
  for (const ev of events) {
    for (const ch of ev.choices ?? []) {
      const fs2 = [ch.gain?.flag ?? []].flat()
      if (fs2.some((f) => /^path-(token|forge|vouch)$/.test(f)) && !fs2.includes('identity-obtained')) {
        errors.push(`event ${ev.id} 的選項「${ch.label}」設了 path-* 卻沒有同時設 identity-obtained —— 第四、五章的閘門會讀到一個永遠為假的 flag`)
      }
    }
  }
}

// ⑤ conditions.json 的必填鍵
{
  const need = [['deprivation', 'thirst'], ['deprivation', 'starve']]
  for (const [a, b] of need) {
    const node = conditions?.[a]?.[b]
    if (!node) errors.push(`conditions.json 缺 ${a}.${b}`)
    else {
      if (!Array.isArray(node.stages) || node.stages.length < 3) errors.push(`conditions.json ${a}.${b}.stages 必須有 3 階（每階文字必須不同，否則玩家分不出離死多遠）`)
      else if (new Set(node.stages).size < node.stages.length) errors.push(`conditions.json ${a}.${b}.stages 有重複的句子 —— 舊版 tick 0 與 tick 2 逐字相同，玩家收不到升級訊號`)
    }
  }
  if (conditions?.warmth?.warn && /會死|致死/.test(conditions.warmth.warn)) {
    errors.push('conditions.json warmth.warn 不得暗示致死 —— canon 明載鹽澤枯收季不會凍死人（見 body.ts coldMul 註解）')
  }
}

// ── 輸出 ──
console.log('=== 無籍者 · 資料驗證 ===')
console.log(`NPC ${npcs.length} / 節點 ${nodes.length} / 路段 ${edges.length} / 物品 ${items.length} / 工作 ${jobs.length} / 事件 ${events.length}`)
console.log(`出處：canon ${canonN} / derived ${derivedN} / invented ${inventedN}  → invented ${inventedPct.toFixed(1)}%（上限 20%）`)
if (warns.length) { console.log('\n警告：'); warns.forEach((w) => console.log('  ! ' + w)) }
if (errors.length) {
  console.log(`\n★ 失敗，${errors.length} 項錯誤：`)
  errors.forEach((e) => console.log('  x ' + e))
  process.exit(1)
}
console.log('\n[PASS] 參照完整性歸零、公平性檢查通過、出處覆蓋完整。')
