/**
 * 存檔測試。與煙霧測試分開，因為它問的是不同的問題：
 * 煙霧測試問「玩得下去嗎」，這裡問「明天改了內容，玩家的檔還讀得起來嗎」。
 *
 * ★ 存檔相容是 DoL 的慢性病，而它之所以變成慢性病，就是因為遷移機制
 *   總是在「已經有玩家存檔壞掉」之後才被寫。這裡用合成的 v1 fixture
 *   把機制先跑通——第一次真的需要遷移時，不該是那段程式第一次執行。
 */

import { readFileSync } from 'node:fs'
import { buildIndex, type Content, type GameState } from '../src/engine/types.ts'
import { attemptsLeft, initialState, reduce, type Action } from '../src/engine/reduce.ts'
import { SAVE_VERSION, load, serialize, validate } from '../src/engine/save.ts'

const D = new URL('../data/', import.meta.url)
const rd = (f: string) => JSON.parse(readFileSync(new URL(f, D), 'utf-8'))
const IDX = buildIndex({
  npcs: rd('npcs.json'), nodes: rd('nodes.json'), edges: rd('edges.json'),
  items: rd('items.json'), jobs: rd('jobs.json'), events: rd('events.json'),
  conditions: rd('conditions.json'),
} as Content)

const results: Array<{ n: number; name: string; ok: boolean; note: string }> = []
const T = (n: number, name: string, ok: boolean, note = '') => results.push({ n, name, ok, note })
const NOW = '2026-08-10T12:00:00.000Z'

/**
 * 玩幾步，讓狀態長出東西（傷、關係、ledger、flags）再存。
 *
 * ★ step() 內建「沒推進時間就強制 wait」的防護，比照煙霧測試的 autoplay。
 *   引擎對無效動作（例如工作已達每日上限）是【記一行 log 然後 break，不推進時間】——
 *   那對玩家是對的，但對測試輔助是個陷阱：第一版這支就在碼頭落選後原地空轉，
 *   於是 ledger 只有 4 筆，而體積測試因此在測一個空狀態。
 */
function played(seed: string, steps = 60): GameState {
  let s = initialState(seed, 'bh:alley', ['item-bandaid', 'item-lighter', 'item-candy'], IDX)
  const step = (a: Action) => {
    const before = s.clock.day * 1440 + s.clock.minute
    s = reduce(s, a, IDX).s
    if (!s.dead && s.clock.day * 1440 + s.clock.minute === before) {
      s = reduce(s, { t: 'wait', minutes: 60 }, IDX).s
    }
  }
  for (let i = 0; i < steps && !s.dead; i++) {
    const h = s.clock.minute / 60
    if (h >= 21 || h < 5) step({ t: 'sleep', kind: 'rough', costCopper: 0 })
    else if (s.at !== 'bh:quays') {
      step({ t: 'travel', route: ['e:alley-quays-slope'], alternatives: [] })
    } else if (h >= 5 && h < 8) step({ t: 'work', job: 'job-quays-dayhire' })
    else step({ t: 'wait', minutes: 60 })
    s = { ...s, needs: { ...s.needs, satiety: 80, hydration: 80 } }
  }
  return s
}

// ① 往返保真：存了再讀，必須逐位元相同
{
  const s = played('roundtrip')
  const raw = serialize(s, NOW, IDX)
  const r = load(raw, IDX)
  const same = r.ok && JSON.stringify(r.state) === JSON.stringify(s)
  T(1, '往返保真：序列化再反序列化，狀態逐位元相同',
    same, r.ok ? `${raw.length} 位元組；ledger ${s.ledger.length} 筆` : `讀取失敗：${r.error}`)
}

// ② ★ 讀檔後續玩的結果必須與沒存過檔一樣（無狀態 RNG 的驗收）
//    這是紀律 6 真正的用處：若 RNG 帶游標，這一條會紅。
{
  const s0 = played('determinism-save', 40)
  const raw = serialize(s0, NOW, IDX)
  const r = load(raw, IDX)
  if (!r.ok) T(2, '讀檔後續玩結果與未存檔相同（無狀態 RNG）', false, r.error)
  else {
    const contA = (x: GameState) => {
      let y = x
      for (let i = 0; i < 25 && !y.dead; i++) {
        y = { ...y, needs: { ...y.needs, satiety: 80, hydration: 80 } }
        y = reduce(y, { t: 'wait', minutes: 60 }, IDX).s
      }
      return y
    }
    const a = contA(s0)
    const b = contA(r.state)
    T(2, '讀檔後續玩結果與未存檔相同（無狀態 RNG 的驗收）',
      JSON.stringify(a) === JSON.stringify(b),
      `第${a.clock.day}日/${a.purse.copper}銅 vs 第${b.clock.day}日/${b.purse.copper}銅`)
  }
}

// ③ ★ v1 → v2 遷移：用合成的舊格式存檔，機制必須先跑通
{
  // 手工造一份 v1 形狀：有 hungryTicks/thirstyTicks，沒有 deprivation/mind/sanity
  const v1 = {
    meta: { schemaVersion: 1, seed: 'legacy', startedAt: 'C.R. 837 枯收季' },
    clock: { day: 5, minute: 14 * 60 },
    at: 'bh:market',
    needs: { satiety: 30, hydration: 0, stamina: 60, warmth: 40, hygiene: 25 },
    injuries: [{ id: 'inj-old', type: '割傷', severity: 1, sinceDay: 3, treatedDay: null, infected: false, feverSinceDay: null }],
    purse: { copper: 17 },
    carry: [{ item: 'item-bandaid', count: 4 }],
    knownRoutes: ['e:alley-quays-fishlane'],
    rep: {},
    npcs: { 'npc-quays-foreman': { acquaintance: 30, trust: 12, affection: 4, lastSeenDay: 4, knownFacts: [] } },
    flags: { 'saw-dross': true },
    eventHistory: { 'ev-dross-trace': 2000 },
    ledger: [{ day: 3, minute: 600, at: 'bh:alley', action: '移動', detail: 'x', copperBefore: 0, copperAfter: 0, needsAfter: {}, alternatives: [] }],
    stats: {
      earnedCopper: 45, spentCopper: 28, hungryTicks: 1, thirstyTicks: 2,
      wastedTrips: 3, edgeUse: { 'e:alley-quays-slope': 4 }, eventsSeen: ['ev-dross-trace'], jobAttempts: {},
    },
    dead: null, ended: false,
  }
  const r = load(JSON.stringify(v1), IDX)
  const ok = r.ok
    && r.migratedFrom === 1
    && r.state.meta.schemaVersion === SAVE_VERSION
    && r.state.needs.sanity === 50
    && r.state.deprivation.thirstMinutes === 2 * 1440
    && r.state.mind.lastShelter === null
    && r.state.injuries[0]!.stageDay === 3
    && r.state.injuries[0]!.healDay === null
    && r.state.ledger[0]!.kind === 'action'
    && !('hungryTicks' in (r.state.stats as unknown as Record<string, unknown>))
    // v2 → v3 新增的三個具名計數器一律從 0 起算（不回溯推估——見 save.ts 註解）
    && r.state.stats.namedAsks === 0
    && r.state.stats.wageDays === 0
    && r.state.stats.givenAway === 0
  T(3, '★ v1 → v3 逐級遷移：舊格式存檔可讀，且新欄位都補齊',
    ok,
    r.ok
      ? `理智 ${r.state.needs.sanity}／缺水 ${r.state.deprivation.thirstMinutes} 分／傷 stageDay ${r.state.injuries[0]?.stageDay}／ledger.kind ${r.state.ledger[0]?.kind}`
      : `失敗：${r.error}　${r.detail.join('；')}`)
}

// ④ ★ 遷移過的檔要真的能繼續玩（不只是通過驗證）
{
  const v1 = {
    meta: { schemaVersion: 1, seed: 'legacy-play', startedAt: 'x' },
    clock: { day: 4, minute: 8 * 60 },
    at: 'bh:quays',
    needs: { satiety: 70, hydration: 70, stamina: 80, warmth: 60, hygiene: 50 },
    injuries: [], purse: { copper: 30 }, carry: [], knownRoutes: [], rep: {}, npcs: {},
    flags: {}, eventHistory: {}, ledger: [],
    stats: { earnedCopper: 0, spentCopper: 0, hungryTicks: 0, thirstyTicks: 0, wastedTrips: 0, edgeUse: {}, eventsSeen: [], jobAttempts: {}, namedAsks: 0, wageDays: 0, givenAway: 0, wageDaySeen: {} },
    dead: null, ended: false,
  }
  const r = load(JSON.stringify(v1), IDX)
  let ok = false, note = ''
  if (r.ok) {
    try {
      let y = r.state
      for (let i = 0; i < 20 && !y.dead; i++) {
        y = { ...y, needs: { ...y.needs, satiety: 80, hydration: 80 } }
        y = reduce(y, { t: 'wait', minutes: 60 }, IDX).s
      }
      ok = y.clock.day > 4
      note = `續玩到第 ${y.clock.day} 日，理智 ${y.needs.sanity.toFixed(0)}`
    } catch (e) { note = '續玩時爆掉：' + (e instanceof Error ? e.message : String(e)) }
  } else note = r.error
  T(4, '★ 遷移過的檔可以真的繼續玩（不是只通過驗證）', ok, note)
}

// ⑤ 壞檔要【大聲失敗】，不得默默補成看起來能玩的樣子
{
  const cases: Array<[string, string]> = [
    ['不是 JSON', '{{{'],
    ['缺 seed', JSON.stringify({ ...played('x', 5), meta: { schemaVersion: 2, seed: '', startedAt: '' } })],
    ['分鐘超界', JSON.stringify({ ...played('x', 5), clock: { day: 2, minute: 9999 } })],
    ['需求是 NaN', JSON.stringify({ ...played('x', 5), needs: { satiety: NaN, hydration: 50, stamina: 50, warmth: 50, hygiene: 50, sanity: 50 } })],
    ['錢是負的', JSON.stringify({ ...played('x', 5), purse: { copper: -3 } })],
    ['指向不存在的地點', JSON.stringify({ ...played('x', 5), at: 'bh:atlantis' })],
    ['背包有不存在的物品', JSON.stringify({ ...played('x', 5), carry: [{ item: 'item-lightsaber', count: 1 }] })],
    ['來自更新的版本', JSON.stringify({ v: 99, savedAt: NOW, summary: {}, state: played('x', 5) })],
  ]
  const leaked = cases.filter(([, raw]) => load(raw, IDX).ok).map(([n]) => n)
  T(5, '★ 八種壞檔全部被擋下（拒絕載入，不默默修補）', leaked.length === 0,
    leaked.length ? '★ 漏放：' + leaked.join('、') : `${cases.length} 種全部擋下`)
}

// ⑥ 驗證器不得誤殺正常存檔
{
  const seeds = ['ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5']
  const bad = seeds.map((sd) => ({ sd, e: validate(played(sd, 50) as unknown, IDX) })).filter((x) => x.e.length > 0)
  T(6, '驗證器不誤殺：五份正常存檔全部通過', bad.length === 0,
    bad.length ? bad.map((x) => `${x.sd}: ${x.e.join('；')}`).join(' / ') : '5/5 通過')
}

// ⑦ 死亡狀態存得起來也讀得回來（死亡回溯畫面要能從存檔重現）
{
  let s = initialState('dead-save', 'bh:alley', [], IDX)
  let n = 0
  while (!s.dead && n < 400) { s = reduce(s, { t: 'wait', minutes: 60 }, IDX).s; n++ }
  const r = load(serialize(s, NOW, IDX), IDX)
  T(7, '死亡狀態可存可讀（死亡回溯能從存檔重現）',
    s.dead !== null && r.ok && r.state.dead?.cause === s.dead?.cause,
    s.dead ? `${s.dead.cause}　ledger ${s.ledger.length} 筆` : '沒死成')
}

// ⑧ 存檔體積：ledger 會隨局長增長，要知道量級（localStorage 一般 5 MB）
{
  const s = played('size', 300)
  const raw = serialize(s, NOW, IDX)
  const kb = raw.length / 1024
  T(8, '存檔體積在 localStorage 配額內（單槽 < 512 KB）', kb < 512,
    `${kb.toFixed(1)} KB／ledger ${s.ledger.length} 筆／第 ${s.clock.day} 日`)
}

// ── 輸出 ──
console.log('=== 無籍者 · 存檔測試 ===\n')
let pass = true
for (const r of results) {
  if (!r.ok) pass = false
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.n).padStart(2)}. ${r.name}`)
  if (r.note) console.log(`         ${r.note}`)
}
console.log(pass ? '\n[PASS] 8 項存檔測試全數通過。' : '\n[FAIL] 有項目未通過。')
process.exit(pass ? 0 : 1)
