/**
 * 存檔的 I/O 層。★ 只有這一檔碰 localStorage——engine 不認識瀏覽器（紀律 1）。
 *
 * 槽位設計：
 *   · 3 個手動槽 ＋ 1 個自動槽
 *   · 自動存檔只在【跨日】發生，而且【死了不存】
 *
 * ★ 「死了不存自動檔」不是小細節，是整個存檔制的關鍵。
 *   `00_pillars.md` 定的是「死亡是永久的，但保留存檔制可回檔」——
 *   如果自動檔會被死亡狀態覆蓋，那唯一的自動檔就永遠停在死掉的那一刻，
 *   等於沒有可回去的地方，「可回檔」就成了空話。
 */

import type { GameState, Index } from '../engine/types.ts'
import { load as loadSave, serialize, summarize, type LoadResult, type SaveSummary } from '../engine/save.ts'

const PREFIX = 'uncounted:save:'
export const MANUAL_SLOTS = [1, 2, 3] as const
export const AUTO_SLOT = 'auto'
export type SlotId = 1 | 2 | 3 | 'auto'

const key = (slot: SlotId) => `${PREFIX}${slot}`

function available(): boolean {
  try {
    const k = `${PREFIX}__probe`
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}
export const STORAGE_OK = available()

export interface SlotInfo {
  slot: SlotId
  summary: SaveSummary | null
  savedAt: string
  /** 這一槽讀得起來嗎；讀不起來要說原因，不要顯示成空槽 */
  broken: string | null
}

export function listSlots(): SlotInfo[] {
  const out: SlotInfo[] = []
  for (const slot of [...MANUAL_SLOTS, AUTO_SLOT] as SlotId[]) {
    const raw = STORAGE_OK ? localStorage.getItem(key(slot)) : null
    if (!raw) { out.push({ slot, summary: null, savedAt: '', broken: null }); continue }
    try {
      const env = JSON.parse(raw) as { savedAt?: string; summary?: SaveSummary }
      out.push({ slot, summary: env.summary ?? null, savedAt: env.savedAt ?? '', broken: null })
    } catch {
      // ★ 壞檔要顯示成「壞了」，不能顯示成「空的」——顯示成空的會讓玩家以為存檔沒寫進去，
      //   然後覆蓋掉它。
      out.push({ slot, summary: null, savedAt: '', broken: '這一槽的內容讀不出來' })
    }
  }
  return out
}

export function write(slot: SlotId, s: GameState, idx: Index): { ok: true } | { ok: false; error: string } {
  if (!STORAGE_OK) return { ok: false, error: '這個瀏覽器不允許存檔（localStorage 被停用或無痕模式）' }
  try {
    localStorage.setItem(key(slot), serialize(s, new Date().toISOString(), idx))
    return { ok: true }
  } catch (e) {
    // 配額爆掉是真的會發生的——ledger 會隨局長增長
    return { ok: false, error: `寫入失敗：${e instanceof Error ? e.message : String(e)}` }
  }
}

export function read(slot: SlotId, idx: Index): LoadResult | null {
  if (!STORAGE_OK) return null
  const raw = localStorage.getItem(key(slot))
  if (!raw) return null
  return loadSave(raw, idx)
}

export function erase(slot: SlotId): void {
  if (STORAGE_OK) localStorage.removeItem(key(slot))
}

/**
 * 自動存檔。★ 死了不存（見檔頭）。
 * 回傳是否真的寫了，讓 UI 可以顯示「已自動存檔」而不是猜。
 */
export function autosave(s: GameState, idx: Index): boolean {
  if (s.dead || s.ended) return false
  return write(AUTO_SLOT, s, idx).ok
}

export function slotLabel(slot: SlotId): string {
  return slot === AUTO_SLOT ? '自動存檔（每日天亮時）' : `存檔槽 ${slot}`
}

export function describeSlot(info: SlotInfo, idx: Index): string {
  void idx
  if (info.broken) return info.broken
  if (!info.summary) return '（空）'
  const m = info.summary
  const hh = String(Math.floor(m.minute / 60)).padStart(2, '0')
  const mm = String(m.minute % 60).padStart(2, '0')
  const when = info.savedAt ? new Date(info.savedAt).toLocaleString('zh-TW', { hour12: false }) : ''
  return `第 ${m.day} 日 ${hh}:${mm}　${m.at}　${m.copper} 銅　理智 ${m.sanity}　認識 ${m.npcs} 人`
    + (m.dead ? `　★ ${m.dead}` : '')
    + (when ? `\n${when}` : '')
}

export { summarize }
