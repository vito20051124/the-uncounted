/**
 * 時間與需求衰減。
 *
 * 紀律 4：引擎【只認整數分鐘】。鐘點僅為顯示層換算，映射為資料。
 * 紀律 8：禁止小數分鐘。
 *
 * ★ 需求衰減率是【反推】出來的，不是憑手感填的：
 *   canon 明載每人每日需 1.5–2 磅主食，且 1 銅 = 2 磅黑麥麵包
 *   → 一日主食成本即 1 銅
 *   → 設計為「一天吃 1 次主食 + 1 次補充」
 *   → satiety 100→0 需 720 分鐘 = 0.139/分
 *   若改成「一天吃兩次主食」，會推出一日 4 磅麵包，與 canon 牴觸。
 */

import type { GameState, NeedKey, Tide } from './types.ts'

export const MIN_PER_DAY = 1440

/**
 * 這一局有多長（遊戲日）。
 *
 * ★ 30 日的三個理由全部是 canon 的，不是挑的數字：
 *   ① 銀月週期 30 日盈虧一輪，民間稱【一輪】（canon/01）——這是這個世界自己的整數單位
 *   ② 老鹽街單間月租 60 銅，一輪＝租期正好到期一次，
 *      於是「安家」的驗收可以寫成「這一輪已付、下一輪的租金已經在桌上」，
 *      不需要任何新狀態、不需要 shelterStreak、不需要為它升 schemaVersion
 *   ③ 旬＝10 日，第 10／20／30 日是三個對冊節拍，而第三次就是「平凡」結局本身
 *
 * ★ 它放在這裡是因為 LAST_DAY 原本在 App.tsx／smoke.ts／balance.ts 各寫一份 14——
 *   而「同一個數字寫三份」正是本專案反覆修掉的缺陷類別。
 */
export const LAST_DAY = 30

/** 鐘 N 鳴於 N×2 時（canon 統一換算律，BRIEF-057）。十二鐘 = 24:00。 */
export function bellOf(minute: number): number {
  const h = Math.floor(minute / 60)
  const n = Math.floor(h / 2)
  return n === 0 ? 12 : n
}

const BELL_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

export function clockLabel(day: number, minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return `第 ${day} 日 ${hh}:${mm} ${BELL_CN[bellOf(minute)]}鐘 ${phaseLabel(minute)}`
}

export function phaseLabel(minute: number): string {
  const h = minute / 60
  if (h < 5) return '深夜'
  if (h < 8) return '晨'
  if (h < 11) return '上午'
  if (h < 14) return '午'
  if (h < 17) return '午後'
  if (h < 20) return '昏'
  if (h < 23) return '夜'
  return '深夜'
}

/**
 * 潮汐：三鐘 06:00 晨漲 / 六鐘 12:00 正午落 / 九鐘 18:00 夕漲 / 十二鐘 24:00 子夜落。
 * 間隔一律 6 小時，符合半日潮物理（canon 統一裁定）。
 * 漲潮期＝ [06,12) 與 [18,24)；退潮期＝ [00,06) 與 [12,18)。
 */
export function tideAt(minute: number): Tide {
  const h = minute / 60
  return (h >= 6 && h < 12) || (h >= 18 && h < 24) ? 'rise' : 'ebb'
}

/** 這段時間內潮汐是否剛轉為某相 */
export function tideTurnedDuring(fromMin: number, toMin: number): Tide | undefined {
  const a = tideAt(fromMin % MIN_PER_DAY)
  const b = tideAt(toMin % MIN_PER_DAY)
  return a === b ? undefined : b
}

/**
 * 每分鐘衰減率。★ 一律由 canon 的物量錨點反推，不得憑手感填。
 *
 * ── 試玩第一輪抓到的推導錯誤（原值 satiety 720／hydration 480 分）──
 * 原註解宣稱「反推自 canon 每日 1.5–2 磅主食」，但填進去的 720 分鐘
 * 【把一天當成 720 分鐘算】，而一天是 1440。等於把食量與飲水量各灌了一倍以上，
 * 於是出現「一夜睡眠比水分歸零還長」這種必死結構。
 * ——**宣告不等於驗收**：註解寫了推導，不代表數字真的推導過。
 *
 * ── 重新推導（含睡眠 0.4 倍後的「等效分鐘」）──
 *   一天 ＝ 醒 15 小時（900 分）＋ 睡 9 小時（540 × 0.4 ＝ 216 等效分）
 *        ＝ **1,116 等效分鐘**
 *
 *   satiety：canon「每人每日 1.5–2 磅主食」＋「1 銅 ＝ 2 磅黑麥麵包」
 *            → 一日份 ＝ 一個 item-rye-bread ＝ **+70**
 *            → 1,116 等效分須恰好耗掉 70 → 100/1,600 分（每日實耗 69.75 ≈ 2 磅）✓
 *            → 一日主食成本 **1 銅**，與收支表吻合
 *
 *   hydration：canon「下城井水取水費半銅」，皮袋二人份計 1 銅 ＝ **+80**
 *            → 一日一皮袋 → 1,116 等效分耗 80 → 100/1,400 分（每日實耗 79.7）✓
 *            → 且「無水約 3 日致死」（thirstyTicks ≥ 2）符合生理，飢餓約 4 日
 *
 *   水比食物掉得快一點（1,400 < 1,600），所以在重勞動日先咬人的是水——這是刻意的。
 */
export const DECAY_PER_MIN: Record<NeedKey, number> = {
  satiety: 100 / 1600, // 一日一份兩磅主食（canon 1.5–2 磅/日）
  hydration: 100 / 1400, // 一日一皮袋井水
  stamina: 0, // 體力不隨時間衰減，只由行動消耗；睡眠恢復
  warmth: 0, // 只在夜間露宿時作用，見 sleep()
  hygiene: 100 / (1440 * 12.5), // 約 8/日
  /**
   * ★ 理智不隨時間衰減 —— 它不是第六個要定時餵的槽，是【每一天的收據】。
   * 沿用本表 stamina/warmth 的既有先例（兩者也是 0）。
   * 它只在【日界結算】與具名動作改變，見 mind.ts。
   *
   * ★ 結算刻意不掛在 sleep：掛 sleep 就是 04_roadmap §8 根因一
   *   （「結算時間軸是夜，所以不睡覺就不扣」）的原地復發，
   *   而煙霧測試 ⑯「不睡覺也會死」正是為那件事寫的。
   */
  sanity: 0,
}

/** 全部需求鍵的單一真相來源。★ 禁止任何地方再硬寫需求鍵陣列（見 reduce.ts 的血淚註解）。 */
export const NEED_KEYS: NeedKey[] = ['satiety', 'hydration', 'stamina', 'warmth', 'hygiene', 'sanity']

/**
 * ★ 睡眠代謝倍率。試玩第一輪抓到的結構性缺陷：
 *
 *   一夜睡眠 20:28 → 06:00 ＝ 572 分鐘 ＞ hydration 歸零所需的 480 分鐘
 *   → 【只要睡覺就必定醒來時脫水歸零】，連睡兩夜即死。
 *   → 死因追不到任何一個決定，直接違反支柱三。
 *
 * 修正不是調高門檻，而是修正模型本身：上面那些速率是從
 * 「一個扛鹽、爬坡、走路的清醒白天」反推出來的，
 * 【睡著的身體不在扛鹽】。故睡眠期間以 0.4 倍計。
 *
 * 校驗：0.4 × 572 分 ＝ 229 分等效 → 睡滿一夜掉 hydration 48、satiety 32。
 * 睡前喝過水的人早上會渴，但不會死；睡前就已經見底的人才會出事——
 * 這才是「可回溯到一個決定」。
 */
export const SLEEP_DECAY_MUL = 0.4

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v))
}

/**
 * 推進時間並惰性結算需求衰減。
 * 決定性、無隨機、可重播——存讀檔不會漂移。
 * 回傳新的 clock/needs（純函數，不改動傳入物件）。
 *
 * `mode: 'asleep'` 只改衰減倍率，不改時間本身——時間永遠是整數分鐘（紀律 8）。
 */
export function advanceTime(
  s: GameState,
  minutes: number,
  mode: 'awake' | 'asleep' = 'awake'
): { clock: GameState['clock']; needs: GameState['needs']; crossedMidnight: boolean } {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`[clock] 時間必須為非負整數分鐘，收到：${minutes}`)
  }
  const total = s.clock.day * MIN_PER_DAY + s.clock.minute + minutes
  const day = Math.floor(total / MIN_PER_DAY)
  const minute = total % MIN_PER_DAY

  const mul = mode === 'asleep' ? SLEEP_DECAY_MUL : 1
  const needs = { ...s.needs }
  for (const k of Object.keys(needs) as NeedKey[]) {
    needs[k] = clamp(needs[k] - DECAY_PER_MIN[k] * minutes * mul)
  }
  return { clock: { day, minute }, needs, crossedMidnight: day !== s.clock.day }
}

/** 距離指定時刻還有幾分鐘（若已過則到明日） */
export function minutesUntil(nowMinute: number, targetHour: number): number {
  const t = targetHour * 60
  return t > nowMinute ? t - nowMinute : MIN_PER_DAY - nowMinute + t
}
