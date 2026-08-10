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

const errors = []
const warns = []
const nodeIds = new Set(nodes.map((n) => n.id))
const edgeIds = new Set(edges.map((e) => e.id))
const itemIds = new Set(items.map((i) => i.id))
const npcIds = new Set(npcs.map((n) => n.id))

const E = (m) => errors.push(m)

// ① 參照完整性
for (const e of edges) {
  if (!nodeIds.has(e.a)) E(`edge ${e.id}: 端點 a 不存在 → ${e.a}`)
  if (!nodeIds.has(e.b)) E(`edge ${e.id}: 端點 b 不存在 → ${e.b}`)
  if (!Number.isInteger(e.minutes) || e.minutes <= 0) E(`edge ${e.id}: minutes 必須為正整數`)
  if (e.knowledge !== 'public' && e.knowledge !== 'learned') E(`edge ${e.id}: knowledge 值非法`)
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
