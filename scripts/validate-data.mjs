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
  const src = (p) => { try { return fs.readFileSync(path.join(here, '..', p), 'utf-8') } catch { return '' } }
  const engineSrc = src('src/engine/reduce.ts')
  const uiSrc = src('src/ui/App.tsx')

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
  const condBlock = /export interface Cond \{([\s\S]*?)\n\}/.exec(typesSrc)
  const STRUCTURAL = new Set(['all', 'any', 'not'])

  /**
   * 明列的例外。★ 每一筆都必須寫【為什麼】——
   * 這個白名單的用途是把「靜默的死謂詞」變成「一個寫下來的決定」，
   * 不是用來讓檢查閉嘴。
   */
  const UNUSED_OK = {
    onEdge: '路段上的事件【功能未建】：travel 只逐邊做風險判定（reduce.ts:388），'
      + '從不帶邊的上下文抽事件，所以 ctxOf 的第三參數沒有呼叫點會填。'
      + '保留謂詞是因為 03_condition_dsl.md 把它列為 P0 謂詞集，而路段事件排 P2。'
      + '★ 一旦有內容用它，下面的「結構上可能為真」檢查會擋下來——這正是要的行為。',
    tideJustTurned: '同上：ctxOf 的第四參數沒有呼叫點會填。'
      + '原規格要它表達「潮水剛轉」，目前內容改用 tide 表達「現在是漲/退潮」，語意較寬但可用。',
    rep: '聲望系統【只有讀取端】：cond.ts 讀 s.rep，而全 src 唯一寫入是 reduce.ts 的 rep: {}，'
      + 'Choice.gain 連 rep 格位都沒有。所以它恆為「拿 0 去比」。'
      + '未刪除是因為 01_architecture.md 仍把 repEffects 列為工作表欄位——'
      + '那份文件與實作的落差已登錄，此處只保證它不會被誤用。',
    onAction: '連型別都沒有，僅存在於設計文件的謂詞清單裡。',
    givenAway: '「無償把東西給出去的次數」——計數器【有增也有讀】（gain.giveAway 增、'
      + '局末摘要「把東西給出去 N 次」讀），但作為【條件】目前沒有任何事件或結局用它。'
      + '保留而不刪的理由：05_main_story.md 把「給出」列為第 3 層（歸屬）的機制，'
      + '而三條結局刻意都不要求它——因為「給過幾次」不該變成一張門票。'
      + '★ 這一行是驗證器逼出來的一個【寫下來的決定】，不是讓它閉嘴。',
  }

  // 每個謂詞讀哪個【選用的】Ctx 欄位（決定它是否結構上可能為真）
  const CTX_DEP = { onEdge: 'onEdge', tideJustTurned: 'tideJustTurned' }
  const ctxArity = (() => {
    const calls = [...engineAndCallers().matchAll(/ctxOf\(([^)]*)\)/g)]
      .map((m) => m[1])
      .filter((argsText) => !/:\s*(GameState|Index)/.test(argsText)) // 排除函式宣告自身
    let max = 0
    for (const argsText of calls) {
      let depth = 0, n = argsText.trim() ? 1 : 0
      for (const c of argsText) {
        if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) depth--
        else if (c === ',' && depth === 0) n++
      }
      if (n > max) max = n
    }
    return max
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

  if (!condBlock) {
    warns.push('validate-data ⑥：在 types.ts 找不到 `export interface Cond {...}`，謂詞盤點跳過'
      + '（★ 這道檢查靜默跳過就等於不存在——若型別被搬家請同步這裡）')
  } else {
    const declared = [...condBlock[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
      .filter((k) => !STRUCTURAL.has(k))

    for (const k of declared) {
      const n = used.get(k) ?? 0
      const dep = CTX_DEP[k]
      const reachable = dep ? ctxArity >= (dep === 'onEdge' ? 3 : 4) : true

      if (n > 0 && !reachable) {
        E(`謂詞「${k}」在內容裡用了 ${n} 次，但它讀的 ctx.${dep} 【沒有任何 ctxOf 呼叫點會填】`
          + `（實測最大參數個數 ${ctxArity}）—— 那些條件【結構上永遠為假】，`
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
    // 白名單自身也要保鮮：已經有人用了的謂詞不該還掛在例外表裡
    for (const k of Object.keys(UNUSED_OK)) {
      if (!declared.includes(k)) continue
      if ((used.get(k) ?? 0) > 0 && !CTX_DEP[k]) {
        warns.push(`謂詞「${k}」已經有 ${used.get(k)} 個實例，可以從 UNUSED_OK 移除了`)
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
