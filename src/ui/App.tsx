/**
 * P0.5 介面：四區塊，1440×900 一屏看完。
 * 紀律 1 的另一面：View 可以認識引擎，引擎不認識 View。
 * 本檔不含任何規則判斷 —— 所有條件求值一律呼叫 engine 的 evaluate。
 */

import { useMemo, useState } from 'preact/hooks'
import {
  buildIndex, type Content, type GameState, type ItemId, type NodeId,
} from '../engine/types.ts'
import { clockLabel, tideAt, DECAY_PER_MIN, LAST_DAY } from '../engine/clock.ts'
import { evaluate } from '../engine/cond.ts'
import { affordable, offerRoutes, type Route } from '../engine/map.ts'
import { availableChoices, drawEvent } from '../engine/events.ts'
import {
  DEPRIVATION_STAGES, explainSuppuration, isIncapacitated, needsHazard, needsTreatment,
  quoteSuppuration, P_WORSEN, P_WORSEN_TREATED, P_DEATH_SEVERE, P_DEATH_SEVERE_TREATED,
} from '../engine/body.ts'
import { CLEAN, UNWIND_GAIN, bandOf, canUnwind, cleanBlocked, fatigueMul, type CleanKind } from '../engine/mind.ts'
import {
  attemptKey, attemptsLeft, canTalk, ctxOf, initialState, quoteHireChance, quoteMinutes,
  reduce, type Action,
} from '../engine/reduce.ts'
import { resolveEnding } from '../engine/ending.ts'
import { MapView } from './MapView.tsx'
import {
  AUTO_SLOT, STORAGE_OK, autosave, describeSlot, erase,
  listSlots, read, slotLabel, write, type SlotId,
} from './storage.ts'

import npcsJson from '../../data/npcs.json'
import nodesJson from '../../data/nodes.json'
import edgesJson from '../../data/edges.json'
import itemsJson from '../../data/items.json'
import jobsJson from '../../data/jobs.json'
import eventsJson from '../../data/events.json'
import conditionsJson from '../../data/conditions.json'
import endingsJson from '../../data/endings.json'

const content = {
  npcs: npcsJson, nodes: nodesJson, edges: edgesJson,
  items: itemsJson, jobs: jobsJson, events: eventsJson, conditions: conditionsJson,
  endings: endingsJson,
} as unknown as Content
const IDX = buildIndex(content)


const NEEDS: Array<[keyof typeof DECAY_PER_MIN, string]> = [
  ['satiety', '飽食'], ['hydration', '水分'], ['stamina', '精力'],
  ['warmth', '體溫'], ['hygiene', '清潔'], ['sanity', '理智'],
]
const EDIBLE: Record<ItemId, string> = {
  'item-rye-bread': '吃掉', 'item-fish-barley': '吃掉', 'item-candy': '吃一顆', 'item-well-water': '喝掉',
}
const PICKABLE: ItemId[] = ['item-phone', 'item-keys', 'item-candy', 'item-lighter', 'item-spray', 'item-bandaid']
const INTRO = [
  '晚上十一點四十分。你餓了。\n冰箱裡只有半罐辣椒醬和一瓶過期的豆漿。',
  '你套上外套下樓。巷口的便利商店還亮著，店員在補貨架。\n你買了兩個飯糰和一瓶水，收銀機叮了一聲。',
  '推開門，外面在起風。\n\n不是那種吹落葉的風。是一種……從很遠的地方灌過來的風，帶著鐵和鹽的味道。\n你下意識閉上眼睛。',
]

/** ★ 0 = 紅，100 = 綠，中間連續插值。讓玩家看得出「正在變差」而不是「已經很差」。 */
function needColor(v: number): string {
  const hue = (v / 100) * 105
  const sat = 68 - (v / 100) * 22
  return `hsl(${hue} ${sat}% ${44 + (v / 100) * 4}%)`
}
/** 還剩多久歸零（分鐘）。stamina/warmth 不隨時間衰減，回傳 null。 */
function etaMinutes(key: string, v: number): number | null {
  const rate = DECAY_PER_MIN[key as 'satiety']
  if (!rate || rate <= 0) return null
  return Math.round(v / rate)
}
function fmtEta(min: number): string {
  const h = Math.floor(min / 60)
  return h >= 1 ? `約 ${h} 小時後歸零` : `不到 1 小時就會歸零`
}

export function App() {
  const [phase, setPhase] = useState<'intro' | 'pick' | 'play' | 'end'>('intro')
  const [introStep, setIntroStep] = useState(0)
  const [picked, setPicked] = useState<ItemId[]>([])
  const [s, setS] = useState<GameState>(() => initialState(String(Date.now()), 'bh:alley', [], IDX))
  const [log, setLog] = useState<string[]>([])
  const [travelTo, setTravelTo] = useState<NodeId | null>(null)
  const [hoverRoute, setHoverRoute] = useState<string[] | null>(null)
  const [evId, setEvId] = useState<string | null>(null)
  const [tab, setTab] = useState<'bag' | 'npc' | 'detail' | 'set'>('bag')
  const [openInj, setOpenInj] = useState<string | null>(null)
  /**
   * ★ 第五輪徹查抓到的：舊版 apply() 在 setLog 之後【同一批次】就 setPhase('end')，
   *   於是致死那一夜的三行敘述（化膿→惡化→敗血）玩家一個字都看不到，
   *   直接跳死亡回溯畫面。那正是支柱三禁止的「無預警致命」的字面實現。
   *   現在先停在一幀讓玩家讀完，再進 Summary。
   */
  const [dying, setDying] = useState(false)
  /** 存檔類的短訊。刻意與敘事 log 分離——它不是故事的一部分。 */
  const [notice, setNotice] = useState<string | null>(null)
  const [slots, setSlots] = useState(() => (STORAGE_OK ? listSlots() : []))
  const refreshSlots = () => setSlots(listSlots())

  const ctx = useMemo(() => ctxOf(s, IDX), [s])
  const here = IDX.node.get(s.at)!
  const tide = tideAt(s.clock.minute)
  const ev = evId ? IDX.event.get(evId) ?? null : null

  function apply(a: Action) {
    const r = reduce(s, a, IDX)
    // ★ 跨日就自動存檔。天亮是這個遊戲天然的存檔點——
    //   而 storage.autosave 內建「死了不存」，否則唯一的自動檔會停在死掉那一刻，
    //   「可回檔」就成了空話（見 storage.ts 檔頭）。
    if (r.s.clock.day !== s.clock.day) {
      if (autosave(r.s, IDX)) {
        setNotice('已自動存檔（第 ' + r.s.clock.day + ' 日天亮）')
        // ★ 寫完要重算槽位列表，否則設置頁會把剛寫進去的自動檔顯示成「（空）」，
        //   而玩家會以為存檔沒成功——然後覆蓋掉它。（瀏覽器實測抓到）
        refreshSlots()
      }
    }
    setS(r.s)
    setLog(r.log)
    setTravelTo(null)
    setHoverRoute(null)
    setEvId(null)
    if (r.s.dead) setDying(true)
    else if (r.s.clock.day > LAST_DAY) setPhase('end')
    else {
      const drawn = drawEvent(r.s, IDX, ctxOf(r.s, IDX))
      setEvId(drawn ? drawn.id : null)
    }
  }

  function doSave(slot: SlotId) {
    const r = write(slot, s, IDX)
    setNotice(r.ok ? slotLabel(slot) + '：已存檔' : '存檔失敗：' + r.error)
    refreshSlots()
  }

  function doLoad(slot: SlotId) {
    const r = read(slot, IDX)
    if (!r) { setNotice(slotLabel(slot) + ' 是空的'); return }
    if (!r.ok) {
      // ★ 大聲失敗。壞檔絕不默默補成「看起來能玩」——見 save.ts validate 的註解。
      setNotice('讀取失敗：' + r.error + (r.detail.length ? '\n· ' + r.detail.join('\n· ') : ''))
      return
    }
    setS(r.state)
    setLog(['（讀取了' + slotLabel(slot) + '。）'])
    setDying(false)
    setEvId(null)
    setTravelTo(null)
    setPhase('play')
    setNotice(r.migratedFrom !== null ? '已載入，並自動升級了存檔格式（v' + r.migratedFrom + ' → v2）' : '已載入')
  }

  function doErase(slot: SlotId) {
    erase(slot)
    refreshSlots()
    setNotice(slotLabel(slot) + '：已刪除')
  }

  // ── 開場 ──
  if (phase === 'intro') {
    return (
      <div class="center-stage">
        <div class="intro">
          <h1>無籍者</h1>
          <div class="sub">THE UNCOUNTED · 瑟瑞恩 C.R. 837 枯收季</div>
          <p class="narr">{INTRO[introStep]}</p>
          <div style="margin-top:26px">
            <button class="choice" style="width:100%" onClick={() =>
              introStep < INTRO.length - 1 ? setIntroStep(introStep + 1) : setPhase('pick')}>
              {introStep < INTRO.length - 1 ? '……' : '睜開眼睛'}
            </button>
            {/* ★ 有存檔就在開場提供入口。不要求玩家先開新局才能讀舊局。 */}
            {introStep === 0 && slots.some((x) => x.summary && !x.summary.dead) && (
              <div style="margin-top:14px">
                <div class="sec-label">或者繼續上一局</div>
                {slots.filter((x) => x.summary && !x.summary.dead).map((x) => (
                  <button class="choice" style="width:100%;margin-top:6px" onClick={() => doLoad(x.slot)}>
                    {slotLabel(x.slot)}
                    <span class="choice-meta">{describeSlot(x, IDX)}</span>
                  </button>
                ))}
              </div>
            )}
            {notice && <div class="notice" style="margin-top:12px">{notice}</div>}
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'pick') {
    const toggle = (id: ItemId) =>
      setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length < 3 ? [...picked, id] : picked)
    return (
      <div class="center-stage">
        <div class="intro">
          <h1>你出門時帶了什麼</h1>
          <div class="sub">選三樣。這不是裝備欄——這是你半夜下樓買宵夜，身上剛好會有的東西。</div>
          <div class="pick-grid">
            {PICKABLE.map((id) => {
              const it = IDX.item.get(id)!
              return (
                <button class={`pick ${picked.includes(id) ? 'on' : ''}`} onClick={() => toggle(id)}>
                  <div class="nm">{it.name}</div>
                  <div class="ds">{it.desc}</div>
                </button>
              )
            })}
          </div>
          <div style="margin-top:20px">
            <button class="choice" style="width:100%" disabled={picked.length !== 3} onClick={() => {
              const init = initialState(String(Date.now()), 'bh:alley', picked, IDX)
              setS(init); setPhase('play')
              setLog(['你睜開眼睛。\n\n風停了。你站在一條巷子裡，腳下是濕的石板，兩邊的牆比你高得多。空氣裡有醃魚和鹽的味道，遠處有海浪，還有一種很低的、規律的敲打聲。\n\n沒有招牌，沒有路燈，沒有訊號。\n身上只有出門時穿的這一套，和你剛才選的三樣東西。'])
              const drawn = drawEvent(init, IDX, ctxOf(init, IDX))
              setEvId(drawn ? drawn.id : null)
            }}>
              {picked.length === 3 ? '走出巷子' : `再選 ${3 - picked.length} 樣`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'end') {
    // ★ 引擎只判定玩家【自己宣告】的那一條，不做優先序瀑布——
    //   任何 else 分支都會被讀成「其他都沒達成」，而那偏偏就是「平凡」。
    //   詳見 src/engine/ending.ts 的檔頭。
    const res = resolveEnding(s, IDX)
    return <EndScreen s={s} res={res} onLoad={doLoad} slotList={slots} />
  }

  // ★ 死亡那一幀。支柱三禁止「無預警致命」——致死那一夜的敘述必須被讀到，
  //   而不是直接跳到回溯畫面。舊版就是直接跳。
  if (dying) {
    return (
      <div class="center-stage">
        <div class="intro">
          <div class="sec-label hot">最後一段</div>
          {log.map((l) => <p class="narr log">{l}</p>)}
          <div style="margin-top:24px">
            <button class="choice" style="width:100%" onClick={() => { setDying(false); setPhase('end') }}>
              ……
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 主畫面 ──
  const jobsHere = [...IDX.job.values()].filter((j) => j.at === s.at)
  const npcsHere = [...IDX.npc.values()].filter((n) => n.at === s.at)
  const sells = here.sells.map((i) => IDX.item.get(i)!).filter(Boolean)
  const others = [...IDX.node.keys()].filter((n) => n !== s.at)
  // ★ 舊版用 treatedDay === null，於是已進入痊癒期的傷還會出現在「處理傷口」裡繼續收錢
  const untreated = s.injuries.filter(needsTreatment)
  /**
   * ★ warmth 移出 LETHAL。
   * canon 明載鹽澤是海洋性氣候、四季溫差適中，枯收季＝秋高氣爽；
   * 全知識庫的低溫致死數據【全部】在斷脈／大寂原的灰冬。
   * 舊版讓 0% 致死率的體溫獨佔紅色「再不處理會死」，而同一個紅框也在報
   * 真正會死的飢餓與脫水——結果是玩家把紅框訓練成噪音。
   * 現在體溫改走琥珀色，並誠實說明它的真實後果（放大化膿率、睡不好）。
   */
  const hazard = needsHazard(s)
  const tired = s.needs.stamina < 20
  const cold = s.needs.warmth < 30
  const feverish = isIncapacitated(s)

  return (
    <div class="layout">
      {/* ═══ 左：狀態 ═══ */}
      <div class="zone zone-left">
        <div class="zone-head">狀態</div>
        <div class="zone-body">
          {/* ★ 全遊戲唯一決定生死的數字，第一次出現在畫面上。
              舊版顯示的是「還剩多久歸零」（歸零後那句連喊 38 次），
              而真正的倒數（連續剝奪分鐘）玩家完全看不到。 */}
          {hazard.warnings.length > 0 && (
            <div class="alarm">
              <strong>{hazard.warnings.some((w) => w.stage >= 2) ? '你快死了。' : '再不處理會死。'}</strong><br />
              {hazard.warnings.map((w) => {
                const beenH = Math.round((w.key === 'thirst' ? s.deprivation.thirstMinutes : s.deprivation.starveMinutes) / 60)
                const leftH = Math.max(1, Math.round(w.minutesToDeath / 60))
                return (
                  <div style="margin-top:4px">
                    已經 <b>{beenH} 小時</b>{w.key === 'thirst' ? '沒喝到水' : '沒吃東西'}　·
                    <b style="color:#f0a08c">再 {leftH} 小時會死</b>
                  </div>
                )
              })}
            </div>
          )}

                              {/* ★ 非致命提示合併成一塊。三個獨立的框會把左欄撐爆（實測溢出 441px），
              而且會稀釋真正致命的紅框。 */}
          {(tired || cold || feverish || s.needs.sanity < 60) && (
            <div class="soft-notes">
              {feverish && <div class="sn sn-fever"><b>發燒</b>　今天上不了工。處置傷口還來得及。</div>}
              {tired && <div class="sn sn-tired"><b>走不動</b>　精力 {Math.round(s.needs.stamina)}，不致命，睡一覺就回。</div>}
              {cold && <div class="sn sn-cold"><b>冷</b>　不致命，但會讓傷口更容易化膿、睡不好。</div>}
              {s.needs.sanity < 60 && (
                <div class="sn sn-mind">
                  <b>{bandOf(s.needs.sanity) === 'spent' ? '空了' : '勉強'}</b>　
                  不致命，但走路多耗 {Math.round((fatigueMul(s.needs.sanity) - 1) * 100)}% 體力、說話多花時間。
                </div>
              )}
            </div>
          )}
          <div class="place-name">{here.name}</div>
          <div class="place-sub">治安 {here.security} 級{here.outsideWalls ? '　·　城牆外' : ''}</div>

          <div class="clock-row">
            {clockLabel(s.clock.day, s.clock.minute)}
            <span class={`tide-chip ${tide === 'rise' ? 'tide-rise' : 'tide-ebb'}`}>
              {tide === 'rise' ? '漲潮' : '退潮'}
            </span>
          </div>

          {/* ★ 錢包與時鐘併成一行；「1 金帝 ＝ 240 銅」是參考資訊，移到右欄「設置」。
              左欄現在有六條需求，垂直空間是稀缺資源（實測溢出過 441px）。 */}
          <div class="purse-big">{s.purse.copper} <span style="font-size:13px">銅</span></div>

          <div class="needs">
            {NEEDS.map(([k, name]) => {
              const v = Math.round(s.needs[k])
              const depKey = k === 'satiety' ? 'starve' : k === 'hydration' ? 'thirst' : null
              const depMin = depKey === 'thirst' ? s.deprivation.thirstMinutes : depKey === 'starve' ? s.deprivation.starveMinutes : 0
              const eta = depKey && depMin > 0 ? null : v < 25 ? etaMinutes(k, s.needs[k]) : null
              const dying2 = depKey && depMin > 0
                ? Math.max(1, Math.round((DEPRIVATION_STAGES[depKey][2] - depMin) / 60))
                : null
              return (
                <div class={`need ${v < 12 ? 'crit' : ''} ${(k === 'hygiene' || k === 'sanity') && v < 70 ? 'wide' : ''}`}>
                  <div class="need-top">
                    <span class="need-name">{name}</span>
                    <span class="need-val" style={`color:${needColor(v)}`}>{v}</span>
                  </div>
                  <div class="need-track">
                    <div class="need-fill" style={`width:${v}%;background:${needColor(v)}`} />
                  </div>
                  {eta !== null && <div class="need-eta">{fmtEta(eta)}</div>}
                  {dying2 !== null && <div class="need-eta" style="color:#d4715c">再 {dying2} 小時會死</div>}
                  {/* ★ 清潔的兩個真實後果，貼在它自己那一列底下。
                      使用者的原話：「整潔度我不知道她的實際用途是甚麼」——
                      說明必須跟它描述的數值在一起，而不是另外開一個方框。 */}
                  {k === 'hygiene' && v < 70 && (() => {
                    const ex = explainSuppuration(s, 'none')
                    const dock = IDX.job.get('job-quays-dayhire')
                    return (
                      <div class="need-why">
                        化膿 ×{ex.hygieneMul.toFixed(2)}
                        {dock && `　·　碼頭錄取 ${Math.round(quoteHireChance(s, dock) * 100)}%`}
                        <span class="fix">　洗一次 → ×{explainSuppuration({ ...s, needs: { ...s.needs, hygiene: 100 } } as GameState, 'none').hygieneMul.toFixed(2)}
                          {dock && `／${Math.round(quoteHireChance({ ...s, needs: { ...s.needs, hygiene: 100 } } as GameState, dock) * 100)}%`}</span>
                      </div>
                    )
                  })()}
                  {k === 'sanity' && v < 70 && (
                    <div class="need-why">
                      走路多耗 {Math.round((fatigueMul(v) - 1) * 100)}% 體力
                      <span class="fix">　說話／熱食／有門板的房間／獨處</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {s.injuries.length > 0 && (
            <div class="body-list">
              <div class="zone-head" style="padding:0;border:none;margin-bottom:6px">身體狀況</div>
              {s.injuries.map((i) => (
                <div class="body-item">
                  <span class="dot" style={`background:${i.infected ? '#d4483a' : i.treatedDay !== null ? '#6d8a5a' : '#b5892f'}`} />
                  <span>{i.type}</span>
                  <span style="margin-left:auto;font-size:11px;color:#5f564b">
                    {i.infected ? '化膿' : i.treatedDay !== null ? '已處理' : '未處理'}
                  </span>
                </div>
              ))}
              <div class="body-hint">詳細見右欄「狀態」</div>
            </div>
          )}
        </div>
      </div>

      {/* ═══ 中：劇情 ═══ */}
      <div class="zone zone-center">
        <div class="zone-head">{travelTo ? '選擇路線' : ev ? '事件' : '此地'}</div>
        <div class="center-split">
          <div class="narr-area">
            {log.length === 0 ? <p class="narr">{here.desc}</p> : log.map((l) => <p class="narr log">{l}</p>)}
            {ev && !travelTo && ev.tell && <div class="tell">{ev.tell}</div>}
            {ev && !travelTo && <p class="narr">{ev.text}</p>}
            {travelTo && (
              <div class="route-banner">
                你正在選擇前往 <strong>{IDX.node.get(travelTo)!.name}</strong> 的路線。下方地圖會標出你滑過的那一條。<br />
                <span style="color:#7f9aa8;font-size:12.5px">同一個目的地不只一條路——快的通常比較險，安全的通常比較累。</span>
              </div>
            )}
          </div>

          {/* ★ 選項區：永不被敘述推出畫面 */}
          <div class="choice-area">
            {/* 事件選項 */}
            {ev && !travelTo && (
              <>
                <div class="sec-label hot">你要怎麼做</div>
                <div class={`choices ${ev.choices.length <= 2 ? 'one-col' : ''}`}>
                  {availableChoices(ev, ctx).map((c) => {
                    const i = ev.choices.indexOf(c)
                    return (
                      <button class="choice" onClick={() => apply({ t: 'eventChoice', event: ev.id, choice: i, alternatives: ev.choices.filter((x) => x !== c).map((x) => x.label) })}>
                        {c.label}
                        <span class="choice-meta">
                          {c.cost?.minutes ? `${c.cost.minutes} 分　` : ''}
                          {c.spend?.copper ? `−${c.spend.copper} 銅　` : ''}
                          {c.gain?.copper ? `+${c.gain.copper} 銅　` : ''}
                          {(c.risks ?? []).map((r) => <span class="risk">風險 {Math.round(r.chance * 100)}%　</span>)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            {/* 路線比較 */}
            {travelTo && (
              <>
                <div class="route-grid">
                  {offerRoutes(s, IDX, tide, travelTo, 0, fatigueMul(s.needs.sanity)).map((r: Route) => {
                    const can = affordable(r, s.needs.stamina)
                    return (
                      <button
                        class={`route-card ${hoverRoute === r.edges ? 'hi' : ''}`}
                        disabled={!can}
                        onMouseEnter={() => setHoverRoute(r.edges)}
                        onMouseLeave={() => setHoverRoute(null)}
                        onClick={() => apply({ t: 'travel', route: r.edges, alternatives: offerRoutes(s, IDX, tide, travelTo!, 0, fatigueMul(s.needs.sanity)).filter((x) => x !== r).map((x) => x.label) })}
                      >
                        <div class="rc-name">{r.label}</div>
                        <div class="rc-stats">
                          <div class="rc-stat"><b>{r.minutes}</b><span>分鐘</span></div>
                          <div class="rc-stat"><b>{r.stamina}</b><span>體力</span></div>
                          <div class="rc-stat"><b style={`color:${needColor(100 - r.risk * 260)}`}>{(r.risk * 100).toFixed(0)}%</b><span>風險</span></div>
                        </div>
                        {r.tells.map((t) => <div class="rc-tell">{t}</div>)}
                        {!can && <div class="rc-no">你走不動這條路（體力 {Math.round(s.needs.stamina)}，需要 {r.stamina}）</div>}
                      </button>
                    )
                  })}
                </div>
                <div style="margin-top:8px">
                  <button class="choice" onClick={() => { setTravelTo(null); setHoverRoute(null) }}>← 不去了</button>
                </div>
              </>
            )}

            {/* 一般行動 */}
          {!ev && !travelTo && (
            <>
              <div class="sec-label">要去哪裡</div>
              <div class="choices three-col">
                {others.map((n) => {
                  const node = IDX.node.get(n)!
                  const rs = offerRoutes(s, IDX, tide, n, 0, fatigueMul(s.needs.sanity))
                  const walkable = rs.filter((r) => affordable(r, s.needs.stamina))
                  return (
                    <button class="choice" disabled={rs.length === 0 || walkable.length === 0} onClick={() => setTravelTo(n)}>
                      {node.name}
                      <span class="choice-meta">
                        {rs.length === 0 ? <span class="no">此刻無路可通</span>
                          : walkable.length === 0 ? <span class="no">體力不足，走不到</span>
                          : walkable.length === 1 ? `只有一條路　${walkable[0]!.minutes} 分`
                          : `${walkable.length} 條路可選　${Math.min(...walkable.map((r) => r.minutes))}–${Math.max(...walkable.map((r) => r.minutes))} 分`}
                      </span>
                    </button>
                  )
                })}
              </div>

              {jobsHere.length > 0 && (
                <>
                  <div class="sec-label">這裡的活</div>
                  <div class="choices one-col">
                    {jobsHere.map((j) => {
                      const left = attemptsLeft(s, j)
                      const ok = !feverish && left > 0 && evaluate(j.requires, ctx) && evaluate({ hours: j.when }, ctx)
                      return (
                        <button class="choice" disabled={!ok} onClick={() => apply({ t: 'work', job: j.id })}>
                          {j.name}
                          <span class="choice-meta">
                            {Math.round(j.minutes / 60)} 小時　+{j.payCopper} 銅
                            {/* ★ 舊版印的是 hireChance 基礎值（永遠 60%），
                                而實際被清潔拉到 35%、被監工熟識度推高最多 30 個百分點。
                                現在與 reducer 共用 quoteHireChance。 */}
                            {j.hireChance < 1
                              ? `錄取 ${Math.round(quoteHireChance(s, j) * 100)}%${j.hireModBy === 'hygiene' ? `（清潔 ${Math.round(s.needs.hygiene)}）` : ''}`
                              : '保證錄取'}
                            {j.maxPerDay > 1 && left > 0 && `　今天還剩 ${left} 趟`}
                            {feverish
                              ? <span class="no">　—— 你在發燒，今天上不了工</span>
                              : left <= 0
                              ? <span class="no">　—— 今天的工已經挑完了，明天請早</span>
                              : !ok && <span class="no">　—— 現在不行（{j.when[0]}:00–{j.when[1]}:00）</span>}
                          </span>
                          <span class="choice-tell">{j.tell}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}



              {/* ★ 可重複的關係互動。沒有這一區，NPC 在一次性事件用完之後就變成死的，
                  而主線三條路的信任門檻（35–45）永遠到不了（試玩第三輪實測）。 */}
              {npcsHere.length > 0 && (
                <>
                  <div class="sec-label">這裡的人</div>
                  <div class={`choices ${npcsHere.length > 2 ? 'three-col' : ''}`}>
                    {npcsHere.map((n) => {
                      const st = s.npcs[n.id]
                      const ok = canTalk(s, n)
                      return (
                        <button class="choice" disabled={!ok} onClick={() => apply({ t: 'talk', npc: n.id })}>
                          找{n.name}說話
                          <span class="choice-meta">
                            {quoteMinutes(s, 30)} 分
                            {st ? `熟識 ${Math.round(st.acquaintance)}　信任 ${Math.round(st.trust)}` : '還沒說過話'}
                            {!ok && <span class="no">　—— 今天已經聊過了</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              {untreated.length > 0 && (
                <>
                  <div class="sec-label hot">處理傷口</div>
                  <div class="choices">
                    {untreated.map((i) => (
                      <>
                        <button class="choice" disabled={s.purse.copper < 1 && !s.carry.some((c) => c.item === 'item-salve')}
                          onClick={() => apply({ t: 'treat', injury: i.id, using: 'herbs' })}>
                          草藥處理{i.type}
                          {/* ★ 機率一律由引擎實算。舊版在這裡硬寫「34% → 21%」，
                              而髒污與低體溫的乘數讓真實值可以到 58%——UI 在報一個假數字。 */}
                          <span class="choice-meta">
                            1 銅　化膿 {Math.round(quoteSuppuration(s, 'none') * 100)}% → {Math.round(quoteSuppuration(s, 'herbs') * 100)}%
                          </span>
                        </button>
                        <button class="choice" disabled={!s.carry.some((c) => c.item === 'item-bandaid')}
                          onClick={() => apply({ t: 'treat', injury: i.id, using: 'sterile' })}>
                          OK 繃貼{i.type}
                          <span class="choice-meta">
                            化膿 {Math.round(quoteSuppuration(s, 'none') * 100)}% → {Math.round(quoteSuppuration(s, 'sterile') * 100)}%　用一片少一片
                          </span>
                        </button>
                      </>
                    ))}
                  </div>
                </>
              )}

              <div class="sec-label">休息與整頓</div>
              <div class="choices three-col">
                {/* ★ 洗淨：使用者「跑了幾天也沒找到如何讓它回復」的答案。
                    三階全部用既有的正典設施——本作不得自行發明澡堂（全庫 0 命中）。 */}
                {(['basin', 'well', 'rinse'] as CleanKind[]).map((k) => {
                  const def = CLEAN[k]
                  if (!here.services.includes(def.service)) return null
                  const used = s.stats.jobAttempts[attemptKey(s.clock.day, `clean:${k}`)] ?? 0
                  const blocked = cleanBlocked(s, k)
                  const ok = used < def.maxPerDay && !blocked && s.purse.copper >= def.copper
                  const label = k === 'basin' ? '洗滌場借盆' : k === 'well' ? '井邊擦洗' : '海水沖洗'
                  return (
                    <button class="choice" disabled={!ok} onClick={() => apply({ t: 'clean', kind: k })}>
                      {label}
                      <span class="choice-meta">
                        {def.copper === 0 ? '免費' : `${def.copper} 銅`}　{def.minutes} 分　清潔 +{def.hygiene}
                        {blocked && <span class="no">　—— 有未處置的傷口，不能泡滷水</span>}
                        {!blocked && used >= def.maxPerDay && <span class="no">　—— 今天洗過了</span>}
                        {!blocked && used < def.maxPerDay && s.purse.copper < def.copper && <span class="no">　—— 付不起</span>}
                      </span>
                    </button>
                  )
                })}

                {/* ★ 獨處：慾望 0 時按鈕【不存在】，不是灰掉——它不是待辦事項。 */}
                {canUnwind(s, here) && (
                  <button class="choice"
                    disabled={(s.stats.jobAttempts[attemptKey(s.clock.day, 'unwind')] ?? 0) >= 1}
                    onClick={() => apply({ t: 'unwind' })}>
                    {IDX.text.unwind.button}
                    <span class="choice-meta">
                      免費　20 分　理智 +{UNWIND_GAIN}
                      {(s.stats.jobAttempts[attemptKey(s.clock.day, 'unwind')] ?? 0) >= 1 && <span class="no">　—— 今天待過了</span>}
                    </span>
                  </button>
                )}

                <button class="choice" onClick={() => apply({ t: 'sleep', kind: 'rough', costCopper: 0 })}>
                  露宿<span class="choice-meta">{IDX.text.shelter.rough}</span>
                </button>
                {here.services.includes('sleep-bunk') && (
                  <button class="choice" disabled={s.purse.copper < 3} onClick={() => apply({ t: 'sleep', kind: 'bunk', costCopper: 3 })}>
                    廉價宿屋通鋪<span class="choice-meta">3 銅　{IDX.text.shelter.bunk}{s.purse.copper < 3 && <span class="no">　—— 付不起</span>}</span>
                  </button>
                )}
                {here.services.includes('sleep-room') && (
                  <button class="choice" disabled={s.purse.copper < 12} onClick={() => apply({ t: 'sleep', kind: 'room', costCopper: 12 })}>
                    客棧單間<span class="choice-meta">12 銅　{IDX.text.shelter.room}{s.purse.copper < 12 && <span class="no">　—— 付不起</span>}</span>
                  </button>
                )}
                <button class="choice" onClick={() => apply({ t: 'wait', minutes: 60 })}>
                  等一個小時<span class="choice-meta">60 分</span>
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      {/* ═══ 右：面板 ═══ */}
      <div class="zone zone-right">
        <div class="tabs">
          <button class={`tab ${tab === 'bag' ? 'on' : ''}`} onClick={() => setTab('bag')}>背包</button>
          <button class={`tab ${tab === 'npc' ? 'on' : ''}`} onClick={() => setTab('npc')}>人物</button>
          <button class={`tab ${tab === 'detail' ? 'on' : ''}`} onClick={() => setTab('detail')}>狀態</button>
          <button class={`tab ${tab === 'set' ? 'on' : ''}`} onClick={() => setTab('set')}>設置</button>
        </div>
        <div class="zone-body">
          {tab === 'bag' && (
            <>
              {/* ★ 買賣移到右欄：交易不是敘事。中欄只留劇情與行動，才能一屏看完。 */}
              {sells.length > 0 && (
                <>
                  <div class="zone-head" style="padding:0;border:none;margin-bottom:6px">這裡買得到</div>
                  {sells.map((it) => (
                    <div class="inv-item">
                      <div class="inv-name">
                        <span>{it.name}</span>
                        <span style={`font-size:12px;color:${s.purse.copper < (it.priceCopper ?? 0) ? '#b5553f' : '#b8894a'}`}>{it.priceCopper} 銅</span>
                      </div>
                      <button class="inv-act" disabled={s.purse.copper < (it.priceCopper ?? 0)}
                        onClick={() => apply({ t: 'buy', item: it.id })}>
                        {s.purse.copper < (it.priceCopper ?? 0) ? '買不起' : '買下'}
                      </button>
                    </div>
                  ))}
                </>
              )}
              {s.carry.some((c) => here.buys.includes(c.item)) && (
                <>
                  <div class="zone-head" style="padding:0;border:none;margin:12px 0 6px">這裡收購</div>
                  {s.carry.filter((c) => here.buys.includes(c.item)).map((c) => {
                    const it = IDX.item.get(c.item)!
                    return (
                      <div class="inv-item">
                        <div class="inv-name"><span>{it.name}</span><span style="font-size:12px;color:#b8894a">+{it.sellCopper} 銅</span></div>
                        <div class="inv-desc">賣了就沒有了。</div>
                        <button class="inv-act" onClick={() => apply({ t: 'sell', item: c.item })}>賣掉</button>
                      </div>
                    )
                  })}
                </>
              )}
              <div class="zone-head" style="padding:0;border:none;margin:12px 0 6px">身上的東西</div>
              {s.carry.length === 0 && <div style="color:#5f564b;font-size:13px">身上什麼都沒有。</div>}
              {s.carry.map((c) => {
                const it = IDX.item.get(c.item)!
                const verb = EDIBLE[c.item]
                return (
                  <div class="inv-item">
                    <div class="inv-name">
                      {/* ★ 手機的「電量」是 canon/07 §5 明訂【嚴格單調遞減、永不回升】的量，
                          顯示成「×40」會讀成可堆疊的數量。其餘消耗品顯示剩餘次數。 */}
                      <span>{it.name}{
                        c.count > 1
                          ? (c.item === 'item-phone'
                              ? ` 電量 ${c.count}/${it.uses ?? c.count}`
                              : ` 剩 ${c.count}${it.uses ? ' 次' : ''}`)
                          : ''
                      }</span>
                      {it.modern && <span class="tag">外來之物</span>}
                    </div>
                    <div class="inv-desc">{it.desc}</div>
                    {/* ★ 進食移到這裡，不再混在劇情選項裡 */}
                    {verb && <button class="inv-act" onClick={() => apply({ t: 'useItem', item: c.item })}>{verb}</button>}
                    {it.modern && <div class="inv-desc" style="color:#a5705f">{IDX.text.modern.seenNote}</div>}
                  </div>
                )
              })}
            </>
          )}

          {tab === 'npc' && (
            <>
              {[...IDX.npc.values()].map((n) => {
                const st = s.npcs[n.id]
                const met = !!st
                return (
                  <div class={`npc-card ${met ? '' : 'npc-unmet'}`}>
                    <div class="npc-name">{met ? n.name : '？？？'}</div>
                    <div class="npc-role">{met ? `${n.role}　·　${IDX.node.get(n.at)?.name}` : `你還沒遇過這個人（${IDX.node.get(n.at)?.name}）`}</div>
                    {met && (
                      <>
                        {([['acquaintance', '熟識'], ['trust', '信任'], ['affection', '情感']] as const).map(([k, lbl]) => (
                          <div class="npc-axis">
                            <span>{lbl}</span>
                            <span class="npc-bar"><i style={`width:${st[k]}%`} /></span>
                            <span style="color:#5f564b;min-width:1.8em;text-align:right">{Math.round(st[k])}</span>
                          </div>
                        ))}
                        <div class="npc-meta">{n.effect}</div>
                        {st.knownFacts.length > 0 && (
                          <div class="npc-meta" style="color:#a5705f">你告訴過他：{st.knownFacts.join('、')}</div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {tab === 'detail' && (
            <>
              <div class="zone-head" style="padding:0;border:none;margin-bottom:6px">需求（精確值）</div>
              {/* ★ 每一條需求都要自己說明它在幹什麼、以及怎麼回復。
                  使用者對清潔的抱怨有兩半：「不知道用途」＋「找不到怎麼回復」——兩半都要答。 */}
              {NEEDS.map(([k, name]) => {
                const eta = etaMinutes(k, s.needs[k])
                const info = IDX.text.needs[k]
                return (
                  <>
                    <div class="detail-row">
                      <span>{name}{eta !== null && <span style="color:#5f564b;font-size:11px">　{fmtEta(eta)}</span>}</span>
                      <span style={`color:${needColor(s.needs[k])}`}>{s.needs[k].toFixed(1)}</span>
                    </div>
                    {info && (
                      <div class="need-explain">
                        {info.does}<br /><span class="exits">回復：{info.exits}</span>
                      </div>
                    )}
                  </>
                )
              })}

              <div class="zone-head" style="padding:0;border:none;margin:14px 0 6px">傷病</div>
              {s.injuries.length === 0 && <div style="color:#5f564b;font-size:12.5px">沒有傷。</div>}
              {s.injuries.map((i) => (
                <>
                  <div class="detail-row expandable" onClick={() => setOpenInj(openInj === i.id ? null : i.id)}>
                    <span>{openInj === i.id ? '▾' : '▸'} {i.type}</span>
                    <span style={`color:${i.infected ? '#d4483a' : i.treatedDay !== null ? '#6d8a5a' : '#b5892f'}`}>
                      {i.infected ? '化膿' : i.treatedDay !== null ? '已處理' : '未處理'}
                    </span>
                  </div>
                  {openInj === i.id && (
                    <div class="expand-body">
                      受傷於第 {i.sinceDay} 日（已 {s.clock.day - i.sinceDay} 天）<br />
                      嚴重度 {i.severity} / 3<br />
                      {i.treatedDay !== null ? `第 ${i.treatedDay} 日處理過` : '尚未處理'}<br />
                      {/* ★ 這一段是第五輪徹查抓到的最後一處謊言：它描述的是【舊版的每夜重擲模型】
                          （「每日 40% 惡化、嚴重後每日 38.5% 致死」），那個模型讓一道擦傷 14 日內 95.6% 致死。
                          現在每階段只判定一次、各有 2 日處置窗口，而機率一律由引擎實算。 */}
                      {(() => {
                        const stage = i.severity >= 3 ? 'crisis' : i.infected ? 'infected' : 'fresh'
                        const t: 'none' | 'herbs' | 'sterile' =
                          s.flags[`treated:${i.id}:sterile`] ? 'sterile' : s.flags[`treated:${i.id}:herbs`] ? 'herbs' : 'none'
                        const daysLeft = Math.max(0, 2 - (s.clock.day - i.stageDay))
                        if (i.healDay !== null) {
                          return `正在結疤，第 ${i.healDay} 日痊癒。它不會再壞下去。`
                        }
                        if (stage === 'fresh') {
                          return `未化膿。還有 ${daysLeft} 日可以處置；到期只判定一次，${t === 'none' ? '未處置' : '已處置'}的化膿率 `
                            + `${Math.round(quoteSuppuration(s, t) * 100)}%（清潔與體溫越低越高）。`
                        }
                        if (stage === 'infected') {
                          return `★ 已化膿，發燒中——今天上不了工。還有 ${daysLeft} 日可處置；`
                            + `到期只判定一次是否惡化為嚴重（未處置 ${Math.round(P_WORSEN * 100)}%，已處置 ${Math.round(P_WORSEN_TREATED * 100)}%）。`
                        }
                        return `★★ 嚴重且化膿。還有 ${daysLeft} 日；到期只判定一次生死`
                          + `（未處置 ${(P_DEATH_SEVERE * 100).toFixed(1)}%，已處置 ${Math.round(P_DEATH_SEVERE_TREATED * 100)}%）。你永遠不能被光耀系治癒。`
                      })()}
                    </div>
                  )}
                </>
              ))}

              <div class="zone-head" style="padding:0;border:none;margin:14px 0 6px">已知的隱蔽路線</div>
              {s.knownRoutes.length === 0
                ? <div style="color:#5f564b;font-size:12.5px">還沒學會任何近路。地圖上的虛線就是那些你知道有、卻還不會走的路。</div>
                : s.knownRoutes.map((e) => <div class="detail-row"><span>{IDX.edge.get(e)?.name}</span><span>已習得</span></div>)}
            </>
          )}

          {tab === 'set' && (
            <>
              <div class="zone-head" style="padding:0;border:none;margin-bottom:6px">存檔</div>
              {!STORAGE_OK && (
                <div class="notice">這個瀏覽器不允許存檔（localStorage 被停用，或在無痕模式）。</div>
              )}
              {STORAGE_OK && slots.map((x) => (
                <div class="slot">
                  <div class="slot-head">
                    <span>{slotLabel(x.slot)}</span>
                    {x.broken && <span class="no">壞檔</span>}
                  </div>
                  <div class="slot-body">{describeSlot(x, IDX)}</div>
                  <div class="slot-acts">
                    {x.slot !== AUTO_SLOT && (
                      <button class="inv-act" onClick={() => doSave(x.slot)}>
                        {x.summary ? '覆蓋' : '存檔'}
                      </button>
                    )}
                    <button class="inv-act" disabled={!x.summary && !x.broken} onClick={() => doLoad(x.slot)}>讀取</button>
                    <button class="inv-act" disabled={!x.summary && !x.broken} onClick={() => doErase(x.slot)}>刪除</button>
                  </div>
                </div>
              ))}
              {notice && <div class="notice" style="margin:8px 0">{notice}</div>}
              <div class="inv-desc" style="margin:10px 0 14px">
                死亡是永久的——但你可以讀回更早的存檔。自動存檔在每天天亮時寫入，<b>且死了不存</b>，
                所以它永遠是「還活著的那個早上」。
              </div>

              <div class="detail-row"><span>貨幣</span><span>1 金帝 ＝ 240 銅（非十進）</span></div>
              <div class="detail-row"><span>版本</span><span>P0.5</span></div>
              <div class="detail-row"><span>種子</span><span style="font-size:11px">{s.meta.seed.slice(-8)}</span></div>
              <div class="detail-row"><span>目標</span><span>活過第 {LAST_DAY} 日</span></div>
              <div style="margin-top:14px">
                <button class="inv-act" style="width:100%" onClick={() => location.reload()}>重新開始</button>
              </div>
              <div class="inv-desc" style="margin-top:14px">
                死亡是永久的。這一輪 P0.5 尚未實作存檔——重新開始會回到最初。
              </div>
            </>
          )}
        </div>
      </div>

      {/* ═══ 下：地圖 ═══ */}
      <div class="zone zone-map">
        <MapView s={s} idx={IDX} tide={tide} highlight={hoverRoute ?? undefined} routeMode={travelTo} />
      </div>
    </div>
  )
}

/**
 * 局末畫面。死亡走 Summary（紅色語域），活到最後走這裡。
 * ★「還沒有」不借用任何一條結局的名字，不套死亡的語域，
 *   而且【不印任何「你離某個結局還差多少」的讀數】——
 *   用讀數告訴玩家他離最低的那個結局還差幾步，會把「沒有優劣」反過來釘在畫面上。
 */
function EndScreen({ s, res, onLoad, slotList }: {
  s: GameState
  res: ReturnType<typeof resolveEnding>
  onLoad?: (slot: SlotId) => void
  slotList: ReturnType<typeof listSlots>
}) {
  if (s.dead) return <Summary s={s} onLoad={onLoad} slotList={slotList} />

  if (res.kind === 'ending') {
    const d = res.def
    return (
      <div class="center-stage" style="align-items:flex-start">
        <div class="summary">
          <div class="sec-label hot">{d.name}</div>
          <div class="ending-tag">{d.tagline}</div>
          {d.text.split('\n\n').map((p) => <p class="narr">{p}</p>)}
          <div class="sec-label" style="margin-top:22px">你放棄的</div>
          <div class="ending-gave">{d.gaveUp}</div>
          <div class="sec-label" style="margin-top:22px">這一輪</div>
          <Stats s={s} />
          <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="choice" style="width:200px" onClick={() => location.reload()}>再走一輪</button>
          </div>
        </div>
      </div>
    )
  }

  // ── 還沒有 ──
  return (
    <div class="center-stage" style="align-items:flex-start">
      <div class="summary">
        <div class="sec-label">還沒有</div>
        <p class="narr">
          {res.declared
            ? '這一輪過完了。你說過你要什麼，但它還沒有成。'
            : '這一輪過完了。你沒有說過你要什麼——所以也沒有什麼是成了或沒成。'}
        </p>
        <p class="narr">
          月亮又缺了一次。碼頭明天還是五點開工。
        </p>
        <div class="sec-label" style="margin-top:20px">三扇門各自要什麼</div>
        <div class="ending-doors">
          {res.all.map((d) => (
            <div class="door">
              <div class="door-name">{d.name}</div>
              <div class="door-tag">{d.tagline}</div>
              <div class="door-asks">{d.asks}</div>
            </div>
          ))}
        </div>
        <div class="sec-label" style="margin-top:22px">這一輪</div>
        <Stats s={s} />
        <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="choice" style="width:200px" onClick={() => location.reload()}>再走一輪</button>
          {onLoad && slotList.filter((x) => x.summary && !x.summary.dead).map((x) => (
            <button class="choice" style="width:240px" onClick={() => onLoad(x.slot)}>
              讀取{slotLabel(x.slot)}
              <span class="choice-meta">{x.summary && `第 ${x.summary.day} 日　${x.summary.at}`}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 局末統計。結局畫面與死亡回溯共用——★ 數字只有一個算法。 */
function Stats({ s }: { s: GameState }) {
  const wore = s.flags['wears-local'] === true
  /**
   * ★ 那片滓的下場。
   *
   * 它在這裡而不在別處，是因為建置期的「flag 設了但沒人讀」警告抓到一件對的事：
   * ev-dross-settle 收掉了 dross-kept 這條死路，卻換來 dross-carried／dross-buried
   * 兩個沒人讀的新 flag——一個不留下任何痕跡的決定，跟沒有這個決定是一樣的。
   *
   * ★★ 而它只是【一行事實】，不帶任何評價，也不進任何結局的達成條件：
   *   四種下場沒有優劣，同一條原則貫穿到底（見 engine/ending.ts 檔頭）。
   */
  const dross = s.flags['dross-buried'] ? '埋回她出現的那面牆根'
    : s.flags['dross-sold'] ? '賣給灰棚巷收滓的（120 銅）'
    : s.flags['dross-carried'] ? '留著。它是唯一的證據'
    : s.flags['dross-kept'] ? '還在她袖口，她沒有再想過它'
    : null
  /**
   * ★ 「怎麼來的」——同一個東西有幾種拿法，而摘要記【哪一種】。
   *
   * 這一節同樣是建置期警告逼出來的：path-forge／path-vouch／prentice-by-gang／
   * prentice-by-guild／guild-roll／hollow-roll 六個 flag 都【設了沒人讀】，
   * 而它們全都是「她是怎麼拿到的」的記錄。一個玩家付了錢買一個死人的名字，
   * 與一個玩家被石窟街擔保，在遊戲裡拿到的是同一張身分——
   * 但那不是同一件事，而在此之前遊戲【一個字都沒有記下來】。
   *
   * ★★ 一律只陳述，不加形容詞，不排序。同一條原則：沒有優劣。
   */
  const how: Array<[string, string]> = []
  const id = s.flags['path-token'] ? '自己弄到一塊通行牌'
    : s.flags['path-forge'] ? '付錢接下灰姐給的那個名字'
    : s.flags['path-vouch'] ? '石窟街替她擔保'
    : null
  if (id) how.push(['被算進去的方式', id])
  if (s.flags['prentice-by-gang']) how.push(['武館的學徒名額', '幫派供養那一條'])
  if (s.flags['prentice-by-guild']) how.push(['武館的學徒名額', '工會旬僱名冊那一條'])
  if (s.flags['guild-roll']) how.push(['承認', '工會名冊上有她一行'])
  if (s.flags['hollow-roll']) how.push(['承認', '石窟街那塊青石片，她刻完了'])
  if (s.flags['grotto-known']) how.push(['石窟街的老匠人', '看過她那把鑰匙'])
  if (s.flags['first-wage']) how.push(['第一筆工錢', '她收好了，沒有當天花掉'])
  return (
    <table class="sum">
      <tr><td>總收入</td><td>{s.stats.earnedCopper} 銅</td></tr>
      <tr><td>總支出</td><td>{s.stats.spentCopper} 銅</td></tr>
      <tr><td>剩餘</td><td>{s.purse.copper} 銅</td></tr>
      <tr><td>上了工的日子</td><td>{s.stats.wageDays} 天</td></tr>
      <tr><td>有人指名要你</td><td>{s.stats.namedAsks} 次</td></tr>
      <tr><td>把東西給出去</td><td>{s.stats.givenAway} 次</td></tr>
      <tr><td>最久空腹</td><td>{Math.round(s.stats.maxStarveMinutes / 60)} 小時</td></tr>
      <tr><td>受過的傷</td><td>{s.stats.injuriesTaken} 道（化膿 {s.stats.injuriesInfected}／痊癒 {s.stats.injuriesHealed}）</td></tr>
      <tr><td>認識的人</td><td>{Object.keys(s.npcs).length}</td></tr>
      <tr><td>不重複事件</td><td>{s.stats.eventsSeen.length}</td></tr>
      <tr><td>★ 里程碑：換上本地舊衣</td><td>{wore ? '達成' : '未達成'}</td></tr>
      {dross && <tr><td>那片滓</td><td>{dross}</td></tr>}
      {how.map(([k, v]) => <tr key={k + v}><td>{k}</td><td>{v}</td></tr>)}
    </table>
  )
}

function Summary({ s, onLoad, slotList }: {
  s: GameState
  onLoad?: (slot: SlotId) => void
  slotList: ReturnType<typeof listSlots>
}) {
  const wore = s.flags['wears-local'] === true
  return (
    <div class="center-stage" style="align-items:flex-start">
      <div class="summary">
        <div class="sec-label hot">{s.dead ? '死亡回溯' : `第 ${LAST_DAY} 日結束`}</div>
        {s.dead && (
          <div class="epitaph">
            {s.dead.cause}　—— 第 {s.dead.day} 日
            <div style="font-size:13px;color:#a8907c;margin-top:6px;font-family:inherit">
              當下：飽食 {Math.round(s.needs.satiety)}　水分 {Math.round(s.needs.hydration)}
              體溫 {Math.round(s.needs.warmth)}　清潔 {Math.round(s.needs.hygiene)}
              理智 {Math.round(s.needs.sanity)}　身上 {s.purse.copper} 銅
            </div>
          </div>
        )}
        <div class="two-col">
          <div>
            <table class="sum">
              <tr><td>總收入</td><td>{s.stats.earnedCopper} 銅</td></tr>
              <tr><td>總支出</td><td>{s.stats.spentCopper} 銅</td></tr>
              <tr><td>剩餘</td><td>{s.purse.copper} 銅</td></tr>
              <tr><td>最久空腹</td><td>{Math.round(s.stats.maxStarveMinutes / 60)} 小時</td></tr>
              <tr><td>最久缺水</td><td>{Math.round(s.stats.maxThirstMinutes / 60)} 小時</td></tr>
              <tr><td>受過的傷</td><td>{s.stats.injuriesTaken} 道（化膿 {s.stats.injuriesInfected}／痊癒 {s.stats.injuriesHealed}）</td></tr>
              <tr><td>★ 白跑一趟</td><td>{s.stats.wastedTrips} 次</td></tr>
              <tr><td>不重複事件</td><td>{s.stats.eventsSeen.length}</td></tr>
              <tr><td>學會的隱蔽路線</td><td>{s.knownRoutes.length}</td></tr>
              <tr><td>認識的人</td><td>{Object.keys(s.npcs).length}</td></tr>
              <tr><td>★ 里程碑：換上本地舊衣</td><td>{wore ? '達成' : '未達成'}</td></tr>
            </table>
            <div class="sec-label">你走過的路</div>
            <table class="sum">
              {Object.entries(s.stats.edgeUse).sort((a, b) => b[1] - a[1]).map(([e, n]) => (
                <tr><td>{IDX.edge.get(e)?.name ?? e}</td><td>{n} 次</td></tr>
              ))}
            </table>
          </div>
          <div>
            <div class="sec-label">決策鏈{s.dead ? '（是什麼把你拖到這裡的）' : ''}</div>
            <div class="ledger">
              {/* ★ 身體的每一步全部保留；玩家的動作留最後 30 筆。
                  舊版 slice(-50) 會把「第 2 日那條黑渣徑上受的傷」截掉，
                  於是死於敗血的人在決策鏈上看不到起因。 */}
              {[...s.ledger.filter((l) => l.kind === 'body'), ...s.ledger.filter((l) => l.kind !== 'body').slice(-30)]
                .sort((x, y) => (x.day * 1440 + x.minute) - (y.day * 1440 + y.minute))
                .map((l) => (
                <div style={l.kind === 'body' ? 'color:#d4977f' : ''}>
                  第{l.day}日 {String(Math.floor(l.minute / 60)).padStart(2, '0')}:{String(l.minute % 60).padStart(2, '0')}
                  <b style={l.kind === 'body' ? 'color:#c9704f' : 'color:#9c8f7e'}>{l.action}</b>｜{l.detail}
                  {l.kind !== 'body' && `　（${l.copperBefore}→${l.copperAfter} 銅）`}
                  {l.alternatives.length > 0 && <div class="alt">　當時還可以：{l.alternatives.join('、')}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div class="sec-label">請你回答這五題</div>
        <ol class="q">
          <li>「一天不夠用」的感覺有出現嗎？</li>
          <li>你有沒有一次真的在兩條路線之間猶豫？</li>
          <li>{s.dead ? '你看得懂自己是怎麼被拖垮的嗎？' : '如果你死了，你覺得你會看得懂原因嗎？'}</li>
          <li>錢的壓力是太鬆、太緊、還是剛好？</li>
          <li><strong>你會想再玩一次嗎？</strong></li>
        </ol>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="choice" style="width:200px" onClick={() => location.reload()}>從頭再玩一次</button>
          {onLoad && slotList.filter((x) => x.summary && !x.summary.dead).map((x) => (
            <button class="choice" style="width:260px" onClick={() => onLoad(x.slot)}>
              讀取{slotLabel(x.slot)}
              <span class="choice-meta">{x.summary && `第 ${x.summary.day} 日　${x.summary.at}　${x.summary.copper} 銅`}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
