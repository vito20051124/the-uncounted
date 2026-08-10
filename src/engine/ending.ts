/**
 * 結局判定。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 唯一的規則：引擎只判定【玩家自己宣告的那一條】，不做優先序瀑布。
 *
 * 這一條不是實作偏好，是憲法要求的直接後果。
 * `00_pillars.md` 支柱一寫「三條結局沒有優劣之分，也沒有隱藏的真結局」——
 * 而任何形式的 if/else if/else 都會製造一個優劣序：
 * 最後那個 else 分支【一定】會被讀成「其他都沒達成」，
 * 而它偏偏就是「平凡地度過一生」。那會讓平凡變成失敗結局，違憲。
 *
 * 所以：玩家在第五章開場明確宣告目標（`aim-hearth` / `aim-trade` / `aim-quiet`），
 * 引擎只問「她宣告的那一條成不成立」。三條都沒宣告或沒達成 → 「還沒有」，
 * 而「還沒有」**不借用任何一條結局的名字**，也不套用死亡回溯的語域。
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 「還沒有」的版面禁令（寫在這裡因為它是機制的一部分，不只是文案）：
 *   · 並列印出三扇門各自要什麼，等重、不排序
 *   · **不印任何「你離某個結局還差多少」的讀數**——
 *     用讀數告訴玩家他離最低的那個結局還差幾步，會把「沒有優劣」反過來釘在畫面上
 */

import { evaluate } from './cond.ts'
import type { Cond, EndingDef, GameState, Index } from './types.ts'

export type { EndingDef }

export type EndingResult =
  | { kind: 'ending'; def: EndingDef }
  /** 宣告了但沒達成，或根本沒宣告 */
  | { kind: 'notYet'; declared: EndingDef | null; all: EndingDef[] }

/**
 * 判定結局。
 * @param s 第 LAST_DAY 日結束時的狀態
 */
export function resolveEnding(s: GameState, idx: Index): EndingResult {
  const all = [...idx.ending.values()]
  const declared = all.find((e) => s.flags[e.aim]) ?? null
  if (declared && evaluate(declared.requires, { s, idx, tide: 'ebb' })) {
    return { kind: 'ending', def: declared }
  }
  return { kind: 'notYet', declared, all }
}

/**
 * 她宣告的那一條，逐項還缺什麼——★ 只在【已經結束之後】給設計者除錯用，
 * 絕不呈現給玩家（見檔頭的版面禁令）。
 */
export function missingParts(s: GameState, def: EndingDef, idx: Index): string[] {
  const out: string[] = []
  const walk = (c: Cond | undefined, path: string) => {
    if (!c) return
    if (Array.isArray(c.all)) { c.all.forEach((x, i) => walk(x, `${path}.all[${i}]`)); return }
    if (!evaluate(c, { s, idx, tide: 'ebb' })) out.push(`${path}: ${JSON.stringify(c)}`)
  }
  walk(def.requires, def.id)
  return out
}
