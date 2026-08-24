/**
 * 事件候選過濾與加權挑選。
 *
 * 全部條件都經由 cond.evaluate（紀律 7），本模組不含任何 inline 判斷。
 * 抽選使用無狀態 seeded RNG（紀律 6），salt 帶 day/minute/node，
 * 故同一時空同一狀態必得同一結果，與呼叫次數無關。
 */

import { evaluate, type Ctx } from './cond.ts'
import { pickWeighted } from './rng.ts'
import type { EventDef, GameState, Index } from './types.ts'

/**
 * 事件不得在剛解決之後立刻再次觸發。
 * ★ 煙霧測試抓到的無窮迴圈：`cooldownDays: 0` 原意是「無冷卻」，
 *   但若該事件的條件在玩家做完選擇後仍然成立（例如口渴而選了「算了」），
 *   它會在同一刻重複觸發，時間永不推進。
 *   故 eventHistory 改存【絕對分鐘】，並設一道最小再觸發間隔。
 */
const MIN_REFIRE_GAP = 90 // 分

/**
 * ★ 事件與事件之間的全域最小間隔。
 *
 * 試玩第三輪抓到的節奏缺陷：MIN_REFIRE_GAP 只管【同一個事件】，
 * 不同事件之間毫無間隔，於是玩家一走進石窟街，八個事件像瀑布一樣連續倒下來，
 * 好感從 0 衝到 25，【主線第三章在第 2 日就跑完了】——而設計是第 8 日。
 *
 * 敘事需要留白。一個醒著的白天約 900 分鐘，除以 120 → 一天至多七幕。
 */
const MIN_EVENT_GAP = 120 // 分

export function absMinute(s: GameState): number {
  return s.clock.day * 1440 + s.clock.minute
}

/**
 * 這【一個】事件此刻能不能被抽出。
 *
 * ★ 抽出來當公開函式，是為了讓 live-reach 的不動點閉包能逐事件詢問。
 *   閉包必須對每個事件餵一個【不同的】狀態（把該事件自己否定的旗標拿掉），
 *   若它只能呼叫 candidates()，就會為每一個事件白跑一次全表迴圈——
 *   實測 130M 次條件求值、12 秒。抽出來之後兩邊共用同一份判定，
 *   不是複製一份「應該一樣」的邏輯（那正是本專案反覆踩到的分歧來源）。
 */
export function isCandidate(ev: EventDef, s: GameState, ctx: Ctx): boolean {
  const now = absMinute(s)
  const hist = Object.values(s.eventHistory)
  // 距離【上一個任何事件】不足 MIN_EVENT_GAP 時，這一刻不出事件。
  if (hist.length > 0 && now - Math.max(...hist) < MIN_EVENT_GAP) return false
  const last = s.eventHistory[ev.id]
  if (ev.once && last !== undefined) return false
  if (last !== undefined) {
    const gap = Math.max(MIN_REFIRE_GAP, (ev.cooldownDays ?? 0) * 1440)
    if (now - last < gap) return false
  }
  if (!evaluate(ev.where, ctx)) return false
  if (!evaluate(ev.when, ctx)) return false
  if (!evaluate(ev.requires, ctx)) return false
  // ★ 沒有任何可選選項的事件不得被抽出 —— 那是一個死路：
  //   玩家看得到它卻無法回應，時間不會推進。煙霧測試抓到的無窮迴圈即源於此。
  if (availableChoices(ev, ctx).length === 0) return false
  return true
}

export function candidates(s: GameState, idx: Index, ctx: Ctx): EventDef[] {
  const out: EventDef[] = []
  for (const ev of idx.event.values()) if (isCandidate(ev, s, ctx)) out.push(ev)
  return out
}

/** 抽一個事件；無候選時回傳 null。 */
export function drawEvent(s: GameState, idx: Index, ctx: Ctx): EventDef | null {
  const pool = candidates(s, idx, ctx)
  if (pool.length === 0) return null
  const i = pickWeighted(
    s.meta.seed,
    'encounter',
    pool.map((e) => e.weight),
    s.clock.day,
    s.clock.minute,
    s.at
  )
  return i < 0 ? null : (pool[i] ?? null)
}

/** 該事件此刻可選的選項（選項本身也可以有條件） */
export function availableChoices(ev: EventDef, ctx: Ctx) {
  return ev.choices.filter((c) => {
    if (!evaluate(c.requires, ctx)) return false
    // 付不起的選項不列出（與 reducer 的守衛一致）
    if (c.spend?.copper !== undefined && ctx.s.purse.copper < c.spend.copper) return false
    if (c.spend?.item !== undefined && !ctx.s.carry.some((x) => x.item === c.spend!.item && x.count > 0)) return false
    return true
  })
}
