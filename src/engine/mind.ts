/**
 * 理智（sanity）與慾望（desire）。
 *
 * 純函數、零文本、零 RNG——決定性，同 seed 可重播。
 * 敘事一律在 data/conditions.json（鐵律 5）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 兩個架構決定，它們是「點綴」與「骨架」的型別分界線
 *
 * ① **sanity 進 needs，desire 不進。**
 *    sanity 是第六個 NeedKey，因此免費獲得四樣既有基礎設施：
 *    Cond DSL（`needs.sanity`）、`job.costs`、`Choice.cost`、
 *    以及 `LedgerEntry.needsAfter`（死亡回溯自動列出它）。
 *    而 desire 永遠拿不到衰減率、拿不到進度條、拿不到紅框，
 *    也【永遠寫不進任何 requires】——建置期會擋。
 *
 * ② **DECAY_PER_MIN.sanity = 0。**
 *    理智不是第六個要定時餵的槽，是【每一天過得怎麼樣的收據】。
 *    它只在日界結算與具名動作改變。
 *    ★ 結算掛在【日界】而不是 sleep —— 掛 sleep 就是 04_roadmap §8
 *      根因一（「結算時間軸是夜，所以不睡覺就不扣」）的原地復發。
 *      `advanceTime` 早就回傳 `crossedMidnight`，而全 repo 從來沒有人讀它。
 *      這是它第一次有用途。
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 世界觀定調（正典明文，不是推論）
 *   `canon/02` §0 靈聾：完全無法持血、施法，但【免疫魔法與枯蝕】；
 *   `canon/07` §4.2：任何導入體內的靈血效果對她一律無效。
 *   → 故理智的耗損與恢復【一律不得含任何靈血／殘滓／魅影／神諭／夢示項】。
 *     低理智的文本不得出現幻覺、低語、發狂——那是施法反噬的語域，
 *     而那是她物理上不可能得到的東西。
 *
 * ★ 主題錨（正典替主角指定的核心創傷）
 *   `canon/07`：「她的核心困境不是『沒有人相信我來自另一個世界』，
 *   是『沒有人在乎我是誰』。」
 *   → 理智是【馬斯洛第三層（愛與歸屬）的儀表】，不是瘋狂值。
 *
 * ★ 誠實聲明：正典完全沒有「理智」條目，也沒有任何世俗心理耗損的量化率。
 *   （正典的「點」有四種互不相容的量綱：回復 5 點精力／4 點精神／
 *    8 點精神健康／6 點精力，彼此無換算、無上限定義。故本檔【不做任何換算】。）
 *   下面每一個數字都是 invented:，驗收不用絕對閾值，
 *   改用【小心政策與粗心政策的曲線分離】——那才是本專案既有的標準。
 */

import { stageOf } from './body.ts'
import type { GameState } from './types.ts'

// ─────────────────────── 慾望：沒有槽 ───────────────────────

/**
 * ★★ 使用者的裁決（第六輪）：
 *
 *   「**慾望是理智的一部分**，因此宣洩慾望時可以恢復理智，
 *     所以我們不會對慾望設計專屬槽位，他只是一個可以用於恢復理智的分支之一，
 *     就像吃到好吃的東西、睡在好的環境一樣。」
 *
 * 於是**全遊戲沒有 desire 這個量**——沒有槽、沒有階段、沒有計時器、
 * 沒有進度條、沒有三階文字，`GameState` 裡也沒有這個欄位。
 *
 * ★ 這個裁決比我原先提的修憲提案乾淨得多：
 *   `00_pillars.md` 支柱二條款 2 逐字寫「不設慾望槽」——
 *   而現在那句話【字面成立】，修憲提案因此作廢並已撤除。
 *   我原本想用「語域限定」繞過它，使用者用「取消那個量」直接解掉。
 *
 * 恢復理智的分支彼此同構、各有代價，沒有哪一條是必須的：
 *
 *   | 分支 | 理智 | 代價 |
 *   | :-- | --: | :-- |
 *   | 找人說話 | +3 | 免費，30 分，一天一次，要有人在場 |
 *   | 睡在有門板的房間 | +4 | 12 銅 |
 *   | 睡通鋪 | +2 | 3 銅 |
 *   | 吃一頓熱的 | +1 | 3 銅 |
 *   | 洗乾淨 | +1 | 1 銅 |
 *   | 看相簿 | +6 | 一格電，且電量永不回升 |
 *   | **獨處** | **+4** | 免費，20 分，一天一次，**要有一個此刻沒有人的地方** |
 *
 * 獨處的回復量刻意與「睡在有門板的房間」相同（+4）：
 * 它不是最強的一條，也不是最弱的一條，就是**其中一條**。
 *
 * ★ 未來若加入與 NPC 的親密內容（使用者：「進行其他澀澀的事時也是如此」），
 *   它一律走**這同一個管道與同一組數字**——不得另立計量、不得更有效率。
 *   這樣「性是點綴不是骨架」就不是靠自律維持的，而是架構上如此。
 */
/**
 * 睡眠的三級遮蔽效果。抽成常數是為了讓 data/conditions.json 的文案可以被【測試】——
 * 那些「通鋪 3 銅 +20／單間 12 銅 +40」是寫死在文案裡的數字，
 * 我改了常數它們就會開始說謊，而那正是本專案修過三次的缺陷類別。
 * 單元測試 ⑧ 現在會比對文案與這裡的值。
 */
export const SHELTER = {
  rough: { copper: 0, stamina: 40, warmth: -25, sanity: -4 },
  bunk: { copper: 3, stamina: 65, warmth: 20, sanity: 2 },
  room: { copper: 12, stamina: 80, warmth: 40, sanity: 4 },
} as const
/** 熱食（醃魚大麥飯）的保暖。derived: 三級遮蔽下界之下。 */
export const HOT_MEAL_WARMTH = 15

export const UNWIND_GAIN = 4
/** 0 銅是關鍵——付費才能宣洩就是漏斗。 */
export const UNWIND_MINUTES = 20
export const UNWIND_STAMINA = 5

// ─────────────────────── 疲憊乘數 ───────────────────────

/**
 * 理智低的【唯一】後果：每一件事更累。
 *
 * sanity ≥60 → ×1.00　／　30 → ×1.15　／　0 → ×1.30
 * 連續、無斷崖、無隱藏門檻。形式刻意抄 body.ts 的 hygieneMul / coldMul。
 *
 * ★ 明文否決過的三個提案，理由記在這裡以免下一輪重提：
 *   · 「理智 0 → 當日無法上工」——那是【沒有出口的吸收態】：
 *     發燒失能有 healDay 當終點，理智失能沒有計時器，
 *     而所有解藥都要錢，錢的唯一來源正是被它切斷的上工。違反支柱三。
 *   · 「乘在時間上」——+30% 的 480 分碼頭班會多耗約 10 點水分，
 *     並把回程推入夜間風險帶。那是把心理狀態做成脫水加速器。
 *   · 「改 hireChance」——hygiene 已經佔用那個槓桿，而本輪的任務
 *     就是把它的存在講給玩家聽。在同一顆按鈕上再加第二個隱形修正，
 *     就是使用者這次抱怨的事情原地再犯。
 */
export function fatigueMul(sanity: number): number {
  const v = Math.max(0, Math.min(60, sanity))
  return 1 + (1 - v / 60) * 0.3
}

/** 理智的三個帶，供 UI 取文本與寫 ledger。 */
export type SanityBand = 'ok' | 'low' | 'spent'
export function bandOf(sanity: number): SanityBand {
  if (sanity >= 60) return 'ok'
  if (sanity >= 30) return 'low'
  return 'spent'
}

// ─────────────────────── 日界結算 ───────────────────────

export interface MindState {
  /** 昨夜睡在哪。null = 沒睡。日界結算讀它。 */
  lastShelter: 'rough' | 'bunk' | 'room' | null
  lastUnwindDay: number | null
}

export interface DayLedgerRow {
  /** 給 conditions.json 取文本用的鍵 */
  key: string
  delta: number
  /** 帶價格的出口（支柱三：每一步都要有出口） */
  exits: string[]
}

export interface SettleResult {
  sanity: number
  rows: DayLedgerRow[]
}

/** 正向項遞減，公式沿用 reduce.ts 既有的 talkGain——越高的理智越難再往上推。 */
function gain(cur: number, base: number): number {
  return Math.max(0, Math.round(base * (1 - cur / 100) * 10) / 10)
}

/**
 * 日界結算。
 *
 * ★ 耗損來源是【白名單制】——只有下列六項合法。
 *   明文禁止：街頭騷擾／性威脅／被觸碰／服裝暴露／NPC 出現。
 *   後五者是 DoL trauma 的來源清單，必須【逐項排除】而不是籠統迴避。
 *   建置期會擋（validate 防線 ⑧）。
 *
 * @param workedToday 當日是否完成過一份工
 * @param talkedToday 當日是否與人說過話（一天算一次，不論找了幾個人）
 * @param ateHotToday 當日是否吃過熱食
 * @param cleanedToday 當日洗淨的等級加總（0 = 沒洗）
 */
export function settleDay(
  s: GameState,
  opts: { workedToday: boolean; talkedToday: boolean; ateHotToday: boolean; cleanedBonus: number }
): SettleResult {
  const rows: DayLedgerRow[] = []
  let v = s.needs.sanity
  const add = (key: string, delta: number, exits: string[] = []) => {
    if (delta === 0) return
    v = Math.max(0, Math.min(100, v + delta))
    rows.push({ key, delta, exits })
  }

  // ── 負向（不遞減）──
  if (s.mind.lastShelter === 'rough') add('roughNight', SHELTER.rough.sanity, ['花 3 銅睡通鋪', '花 12 銅睡單間'])
  if (s.needs.hygiene < 30) add('filthy', -3, ['在洗滌場借盆洗一次（1 銅）', '去碼頭用海水沖洗（免費）'])
  if (stageOf('thirst', s.deprivation.thirstMinutes) >= 1) add('thirsty', -3, ['花 1 銅打一皮袋井水'])
  if (stageOf('starve', s.deprivation.starveMinutes) >= 1) add('hungry', -3, ['花 1 銅買兩磅黑麥麵包'])
  if (s.injuries.some((i) => i.infected && i.healDay === null)) add('feverish', -4, ['處置傷口（草藥 1 銅／OK 繃一片）'])

  // 孤立：由既有的 NpcState.lastSeenDay 推導。
  // ★ 那個欄位被寫入三處、從未被讀取——這是它第一次有用途。
  const seen = Object.values(s.npcs).map((n) => n.lastSeenDay ?? 0)
  const lastAny = seen.length > 0 ? Math.max(...seen) : 0
  if (s.clock.day - lastAny >= 3) add('isolated', -3, ['找個人說話（免費，只要 30 分鐘）'])

  // ── 正向（遞減）──
  if (s.mind.lastShelter === 'room') add('roomNight', gain(v, SHELTER.room.sanity))
  else if (s.mind.lastShelter === 'bunk') add('bunkNight', gain(v, SHELTER.bunk.sanity))
  if (opts.talkedToday) add('talked', gain(v, 3))
  if (opts.workedToday) add('worked', gain(v, 1))
  if (opts.ateHotToday) add('hotMeal', gain(v, 1))
  if (opts.cleanedBonus > 0) add('washed', gain(v, opts.cleanedBonus))

  return { sanity: v, rows }
}

// ─────────────────────── 獨處 ───────────────────────

/**
 * 此刻此地能不能獨處。
 *
 * ★ 隱私是【推導值】，不是另一條需求——用 nodes.json 的 privateHours 判定，
 *   不新增任何 state。也沒有任何「慾望夠不夠」的前置：這個動作永遠可用，
 *   只要你此刻在一個沒有人的地方（而那本身就是一個要規劃的條件）。
 *
 * ★ 明文否決過的設計：「隱私分三階，最高階要 12 銅單間」。
 *   若隱私是獨處的閘門而最高階要錢，就重建了「付費才能宣洩」的漏斗。
 *   單間的第二個理由改由日界結算 +4（vs 通鋪 +2 vs 露宿 −4）兌現。
 *
 * ★ 這使獨處是一個【真決策】而不是點擊稅：
 *   她若在潮汐門外的蒸發池扒鹽扒到天黑，就回不了自己的巷子。
 */
export function canUnwind(s: GameState, node: { privateHours?: [number, number] }): boolean {
  const ph = node.privateHours
  if (!ph) return false
  const h = s.clock.minute / 60
  const [from, to] = ph
  return from > to ? h >= from || h < to : h >= from && h < to
}

// ─────────────────────── 洗淨 ───────────────────────

export type CleanKind = 'rinse' | 'well' | 'basin'

/**
 * 三階洗淨，全部用【既有的正典設施】——本作不得自行發明澡堂。
 *
 * ★ 個人沐浴設施是真正的世界觀空白：全庫對
 *   澡堂｜沐浴｜浴室｜盥洗｜湯屋｜浴場｜理髮｜剃鬚 為 **0 命中**。
 *   故三階全部是「借既有設施洗人」：
 *     rinse  潮間帶海水　　canon: 鹽埠碼頭「浸水的木棧橋與防潮石砌」
 *     well   公用分水井　　canon: landmarks「供應市民日常洗滌用水」← 全庫最直接的授權句
 *     basin  衣物洗滌場　　canon: 鹽民下城主要職能明列「衣物洗滌場」＋「洗滌皂角味」
 *   價格 derived: 下城井水取水費半銅（整數銅制下記 1 銅）。
 *   回復量與耗時標 invented:。
 *
 * ★ 三階不得互相支配（比照路網的 Pareto 紀律）：
 *   免費的最弱且有前置（開放傷口不可下海水），付費的較強但綁地點與次數。
 */
export interface CleanDef {
  hygiene: number
  minutes: number
  copper: number
  stamina: number
  sanity: number
  maxPerDay: number
  /** 節點必須有這個 service 才提供 */
  service: string
}
export const CLEAN: Record<CleanKind, CleanDef> = {
  rinse: { hygiene: 12, minutes: 20, copper: 0, stamina: 5, sanity: 0, maxPerDay: 2, service: 'rinse' },
  well: { hygiene: 18, minutes: 20, copper: 1, stamina: 5, sanity: 1, maxPerDay: 1, service: 'well' },
  basin: { hygiene: 30, minutes: 40, copper: 1, stamina: 8, sanity: 1, maxPerDay: 1, service: 'wash' },
}

/** 有未處置的開放傷口時不可下海水泡（滷水會吃掉傷口——jobs.json 的「鹽蝕手」就是這件事）。 */
export function cleanBlocked(s: GameState, kind: CleanKind): string | null {
  if (kind !== 'rinse') return null
  const open = s.injuries.some((i) => i.healDay === null && i.treatedDay === null)
  return open ? 'openWound' : null
}
