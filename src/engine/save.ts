/**
 * 存檔：序列化、驗證、版本遷移。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 為什麼這一檔可以這麼短
 *
 * `GameState` 是**純 JSON**——沒有 Map、沒有 Set、沒有 Date、沒有函式。
 * 全部的 Map 都在 `Index`（內容側，由 data/ 重建），不在狀態裡。
 * 而 RNG 是無狀態的（紀律 6：`rand(seed, stream, ...salt)`，不維護游標）。
 *
 * 兩件事加起來的結果是：**存檔就只是狀態本身，而重播必然一致。**
 * 這不是運氣，是紀律 1（引擎零 UI 耦合）與紀律 6（無狀態 RNG）的回報——
 * 若當初 RNG 帶游標，這裡就得序列化亂數狀態，而任何內容改動都會讓舊檔重播漂移。
 *
 * ★ 本檔【不碰 localStorage】。engine 不認識瀏覽器（紀律 1）。
 *   I/O 在 `src/ui/storage.ts`，本檔只做純函數：字串 ⇄ 狀態。
 *   這樣 Node 端的測試可以完整覆蓋遷移邏輯而不需要 DOM。
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 為什麼現在就寫 v1→v2 遷移，即使世上沒有一份 v1 存檔
 *
 * 因為**第一次真的需要遷移時，不該是這段程式第一次執行**。
 * 存檔相容是 DoL 的慢性病，而它之所以變成慢性病，就是因為遷移機制
 * 總是在「已經有玩家存檔壞掉」之後才被寫。
 * 這裡用合成的 v1 fixture 把機制先跑通（見煙霧測試）。
 */

import type { GameState, Index, NeedKey } from './types.ts'

/** 當前存檔格式版本。改動 GameState 形狀時必須 +1 並補一條遷移。 */
export const SAVE_VERSION = 2

export interface SaveEnvelope {
  /** 存檔格式版本（不是遊戲版本） */
  v: number
  /** 寫檔時的真實時間（僅供 UI 顯示；引擎永不讀它——它不進 state，不影響重播） */
  savedAt: string
  /** 給存檔槽列表用的摘要，避免為了顯示一行字而反序列化整份狀態 */
  summary: SaveSummary
  state: GameState
}

export interface SaveSummary {
  day: number
  minute: number
  at: string
  copper: number
  dead: string | null
  sanity: number
  /** 已認識幾人——比「第幾日」更能說明這一局走到哪 */
  npcs: number
}

export function summarize(s: GameState, idx?: Index): SaveSummary {
  return {
    day: s.clock.day,
    minute: s.clock.minute,
    at: idx?.node.get(s.at)?.name ?? s.at,
    copper: s.purse.copper,
    dead: s.dead?.cause ?? null,
    sanity: Math.round(s.needs.sanity),
    npcs: Object.keys(s.npcs).length,
  }
}

export function serialize(s: GameState, now: string, idx?: Index): string {
  const env: SaveEnvelope = {
    v: SAVE_VERSION,
    savedAt: now,
    summary: summarize(s, idx),
    state: s,
  }
  return JSON.stringify(env)
}

// ─────────────────────── 遷移 ───────────────────────

/**
 * 每一條遷移把狀態從 (v) 帶到 (v+1)。
 * ★ 遷移必須是**可重播的純資料改寫**——不得呼叫 reduce、不得擲骰、不得讀時鐘。
 *   否則載入舊檔會產生一個玩家從未做過的決定。
 */
type Migration = (o: Record<string, unknown>) => Record<string, unknown>

const MIGRATIONS: Record<number, Migration> = {
  /**
   * 1 → 2：第五、六輪的狀態形狀改動。
   *
   * · stats.hungryTicks / thirstyTicks（起床快照計數）→ deprivation 連續分鐘
   * · 新增 needs.sanity 與 mind
   * · Injury 新增 stageDay / healDay
   * · LedgerEntry 新增 kind
   */
  1: (o) => {
    const stats = (o.stats ?? {}) as Record<string, number>
    const needs = (o.needs ?? {}) as Record<string, number>
    // 舊的 tick 是「連續幾個黎明需求為 0」。一個黎明約等於一天，
    // 故以 1440 分鐘近似回填——它只需要保住「這個人已經餓/渴了多久」的量級。
    const starve = (stats.hungryTicks ?? 0) * 1440
    const thirst = (stats.thirstyTicks ?? 0) * 1440

    return {
      ...o,
      meta: { ...(o.meta as object), schemaVersion: 2 },
      needs: { ...needs, sanity: needs.sanity ?? 50 },
      deprivation: { starveMinutes: starve, thirstMinutes: thirst },
      mind: { lastShelter: null, lastUnwindDay: null },
      injuries: ((o.injuries ?? []) as Array<Record<string, unknown>>).map((i) => ({
        ...i,
        stageDay: i.stageDay ?? i.sinceDay ?? 1,
        healDay: i.healDay ?? null,
      })),
      ledger: ((o.ledger ?? []) as Array<Record<string, unknown>>).map((l) => ({
        ...l,
        kind: l.kind ?? 'action',
      })),
      stats: {
        earnedCopper: stats.earnedCopper ?? 0,
        spentCopper: stats.spentCopper ?? 0,
        maxStarveMinutes: starve,
        maxThirstMinutes: thirst,
        injuriesTaken: stats.injuriesTaken ?? 0,
        injuriesInfected: stats.injuriesInfected ?? 0,
        injuriesHealed: stats.injuriesHealed ?? 0,
        wastedTrips: stats.wastedTrips ?? 0,
        edgeUse: (o.stats as Record<string, unknown>)?.edgeUse ?? {},
        eventsSeen: (o.stats as Record<string, unknown>)?.eventsSeen ?? [],
        jobAttempts: (o.stats as Record<string, unknown>)?.jobAttempts ?? {},
      },
    }
  },
}

// ─────────────────────── 驗證 ───────────────────────

const NEED_KEYS_REQUIRED: NeedKey[] = ['satiety', 'hydration', 'stamina', 'warmth', 'hygiene', 'sanity']

/**
 * 驗證一份已遷移到當前版本的狀態。
 *
 * ★ 這裡刻意**大聲失敗**而不是靜默修補。
 *   本專案已經因為「靜默丟棄」踩過三個 blocker
 *   （事件治療寫錯鍵、cost.sanity 被硬寫鍵陣列吃掉、電量沒扣）。
 *   一份壞掉的存檔如果被默默補成「看起來能玩」，玩家會在幾小時後才發現不對，
 *   而那時已經沒有可回去的地方。
 */
export function validate(o: unknown, idx?: Index): string[] {
  const err: string[] = []
  const bad = (m: string) => err.push(m)
  if (typeof o !== 'object' || o === null) return ['存檔不是一個物件']
  const s = o as Record<string, unknown>

  const meta = s.meta as Record<string, unknown> | undefined
  if (!meta || typeof meta.seed !== 'string' || !meta.seed) bad('meta.seed 缺漏——沒有 seed 就無法重播')
  if (meta && meta.schemaVersion !== SAVE_VERSION) bad(`meta.schemaVersion 應為 ${SAVE_VERSION}，實為 ${String(meta.schemaVersion)}`)

  const clock = s.clock as Record<string, unknown> | undefined
  if (!clock || !Number.isInteger(clock.day) || !Number.isInteger(clock.minute)) bad('clock 必須是整數 day/minute（紀律 8）')
  else if ((clock.minute as number) < 0 || (clock.minute as number) > 1439) bad(`clock.minute 超出 0..1439：${String(clock.minute)}`)

  const needs = s.needs as Record<string, unknown> | undefined
  if (!needs) bad('needs 缺漏')
  else for (const k of NEED_KEYS_REQUIRED) {
    const v = needs[k]
    if (typeof v !== 'number' || Number.isNaN(v)) bad(`needs.${k} 不是數字`)
    else if (v < 0 || v > 100) bad(`needs.${k} 超出 0..100：${v}`)
  }

  const purse = s.purse as Record<string, unknown> | undefined
  if (!purse || !Number.isInteger(purse.copper) || (purse.copper as number) < 0) {
    bad('purse.copper 必須是非負整數銅（紀律 3：1 金帝 = 240 銅，非十進）')
  }

  const dep = s.deprivation as Record<string, unknown> | undefined
  if (!dep || typeof dep.starveMinutes !== 'number' || typeof dep.thirstMinutes !== 'number') bad('deprivation 缺漏')

  if (!s.mind || typeof s.mind !== 'object') bad('mind 缺漏')
  for (const k of ['injuries', 'carry', 'knownRoutes', 'ledger'] as const) {
    if (!Array.isArray(s[k])) bad(`${k} 必須是陣列`)
  }

  // 參照完整性：存檔指向的 id 必須在當前內容裡存在。
  // ★ 這一項會抓到「內容改了但玩家的舊檔指向已刪除的地點/物品」——
  //   那是內容更新後最常見的壞檔方式，而它在 P1 之後只會更常發生。
  if (idx) {
    if (typeof s.at !== 'string' || !idx.node.has(s.at as string)) bad(`at 指向不存在的節點：${String(s.at)}`)
    for (const c of (s.carry as Array<{ item?: string }> | undefined) ?? []) {
      if (!c.item || !idx.item.has(c.item)) bad(`carry 含不存在的物品：${String(c.item)}`)
    }
    for (const e of (s.knownRoutes as string[] | undefined) ?? []) {
      if (!idx.edge.has(e)) bad(`knownRoutes 含不存在的路段：${e}`)
    }
    for (const n of Object.keys((s.npcs as Record<string, unknown>) ?? {})) {
      if (!idx.npc.has(n)) bad(`npcs 含不存在的人物：${n}`)
    }
  }
  return err
}

export type LoadResult =
  | { ok: true; state: GameState; migratedFrom: number | null; savedAt: string; warnings: string[] }
  | { ok: false; error: string; detail: string[] }

/**
 * 反序列化 ＋ 逐級遷移 ＋ 驗證。
 * 任何一步失敗都回傳 ok:false，並附上人看得懂的原因。
 */
export function load(raw: string, idx?: Index): LoadResult {
  let env: Record<string, unknown>
  try {
    env = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { ok: false, error: '存檔不是有效的 JSON（檔案可能被截斷或改壞了）', detail: [] }
  }

  // 舊檔可能沒有信封，直接就是 state
  const hasEnvelope = typeof env.v === 'number' && typeof env.state === 'object' && env.state !== null
  let obj = (hasEnvelope ? env.state : env) as Record<string, unknown>
  const savedAt = hasEnvelope ? String(env.savedAt ?? '') : ''

  let from = hasEnvelope
    ? (env.v as number)
    : Number(((obj.meta as Record<string, unknown>)?.schemaVersion) ?? 1)
  if (!Number.isFinite(from) || from < 1) return { ok: false, error: `無法判斷存檔版本`, detail: [] }
  const migratedFrom = from === SAVE_VERSION ? null : from

  if (from > SAVE_VERSION) {
    return {
      ok: false,
      error: `這份存檔來自更新的版本（v${from}），本版最高支援 v${SAVE_VERSION}。請更新遊戲，不要用舊版開它——舊版會把它讀壞。`,
      detail: [],
    }
  }

  const warnings: string[] = []
  while (from < SAVE_VERSION) {
    const m = MIGRATIONS[from]
    if (!m) return { ok: false, error: `缺少 v${from} → v${from + 1} 的遷移路徑`, detail: [] }
    obj = m(obj)
    warnings.push(`已從 v${from} 升級到 v${from + 1}`)
    from++
  }

  const errs = validate(obj, idx)
  if (errs.length > 0) {
    return { ok: false, error: '存檔驗證失敗——為了不讓你在幾小時後才發現不對，這裡拒絕載入。', detail: errs }
  }
  return { ok: true, state: obj as unknown as GameState, migratedFrom, savedAt, warnings }
}
