/**
 * 傷病進程與剝奪（飢/渴）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★ 本檔在第五輪徹查後整體重寫。舊版有一個把遊戲玩壞的結構性錯誤：
 *
 *   舊版把三段判定寫成【每一夜重擲的馬可夫鏈】，而傷口【永不痊癒】。
 *   於是任何一道 2% 路段擦傷，在 14 日窗口內的累積死亡率是 95.6%。
 *   實測 300 seed × 14 日：死亡率 87%，其中 93% 死因是敗血，平均第 8.2 日。
 *
 *   而本檔舊版的檔頭、UI 的按鈕、煙霧測試 ④ 三處都宣稱那是 5.2%。
 *   —— 註解算的是「一生一次」，程式跑的是「每夜一次」。
 *
 *   罪魁禍首是 `design/01_architecture.md` 舊第 269 行：
 *   「無魔法可用者的嚴重創傷感染死亡率為 38.5%，她在任何地方都適用那個數字」。
 *   那句話與 `canon/07` §4.1 的但書直接牴觸——38.5% 只限【嚴重創傷】，
 *   且是【一次】判定，不是每夜重抽。設計文件已同步更正。
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ 機率錨定（每一格都指得出出處）：
 *
 *   傷口未處理 → 化膿          34%    canon: world/catalogs/hollow-flora.md 化膿率
 *   草藥＋清水處理 → 化膿      21%    canon: 同上（凡俗處置後）
 *   OK 繃（無菌敷料）→ 化膿    ~8%    derived: 外插，此世不存在無菌敷料
 *   化膿 → 惡化為「嚴重」      40%    invented: 設計值，待試玩校正
 *   嚴重 → 死亡                38.5%  canon: canon-07 §4.1（僅【嚴重創傷】且無 光耀+淨）
 *   嚴重（已處置）→ 死亡       19%    derived: canon 三具名案例於凡俗處置後皆存活
 *                                     （brek-anneal 燙傷臥床 38 日、still-ward-tally 化膿虎口
 *                                      臥床 21 日、dret-scale-cuff 截趾）→ 取 38.5% 折半
 *
 *   → 未處理割傷最終死亡率 = 0.34 × 0.40 × 0.385 ≈ 5.2%   ← 現在程式真的是這個數
 *   → 一片 OK 繃把它降到約 1.2%
 *
 * ★ 每一階段【只判定一次】，且各有 2 日處置窗口。
 *
 *   期程錨定用的是【憲法自己的範例鏈】：00_pillars.md 寫「第 3 日割傷 → 第 9 日死於敗血」
 *   ＝ 6 日走完三階 ＝ 每階段 2 日。
 *   （canon 的實際感染病程是 17–21 日：brek 同窖學徒第 17 日死亡、
 *    dret 同班守衛第 21 日死亡；遊戲按 14 日窗口壓縮，與 clock.ts 的時間壓縮同層。）
 *
 *   ★ 一開始我填 3 日，結果三階要 9 天，而多數死亡發生在第 8 日——
 *     傷病鏈根本跑不完，300 局跑分裡敗血死亡零例。
 *     憲法的 6 日才是對的錨點，我的 1:6 壓縮是猜的。
 *
 * ★ 感染的主要後果【不是死亡，是失能】：
 *   發燒者無法上工 → 沒收入 → 沒錢吃飯。
 *   這才是 `00_pillars.md` 憲法範例鏈的字面意思——**不是骰子殺了你，是貧窮殺了你**。
 *   舊版的 DayProgress.incapacitated 自始存在卻從未被 reduce 讀取，是死碼；現已接線。
 *
 * 主角為 0 靈聾／閉血（canon-07 §4），【永遠】不能被 光耀+淨 治癒。
 * 她的醫療階梯只有：草藥（買得起）→ 血晶器物（幾乎買不起）→ 魔法治癒（物理上不可能）。
 */

import { roll } from './rng.ts'
import type { GameState, Injury, NeedKey } from './types.ts'

export const P_SUPPURATE_UNTREATED = 0.34
export const P_SUPPURATE_HERBS = 0.21
export const P_SUPPURATE_STERILE = 0.08
export const P_WORSEN = 0.4
/**
 * 處置過的化膿傷口仍然會惡化的機率。
 *
 * ★ 第一次修這條時我讓「處置 = 100% 保證痊癒」，結果 300 局跑分裡
 *   敗血死亡【零例】，死因 100% 是脫水——傷病系統對結果毫無貢獻。
 *   而 canon 不支持那種保證：dret-scale-cuff 的同班守衛【處置過仍在第 21 日死亡】。
 *   光耀+淨 才是確定的治癒，而她永遠不能被它治癒（canon-07 §4）。
 * derived: canon 三具名案例中處置後多數存活但仍有一例致死 → 約六分之一
 */
export const P_WORSEN_TREATED = 0.15
export const P_DEATH_SEVERE = 0.385
/** 凡俗處置後的嚴重創傷死亡率。canon 未直接給值，取 38.5% 折半（見檔頭）。 */
export const P_DEATH_SEVERE_TREATED = 0.19

/** 各階段的處置窗口（日）。玩家在窗口內永遠有事情可做——支柱三要求「每一步都有出口」。 */
export const DAYS_TO_SUPPURATE = 2
export const DAYS_TO_WORSEN = 2
export const DAYS_TO_CRISIS = 2
/** 痊癒所需日數：已處置的傷好得快。傷口【必須會痊癒】，否則傷害是永久累積的。 */
export const DAYS_TO_HEAL_TREATED = 3
export const DAYS_TO_HEAL_UNTREATED = 6

export type Treatment = 'none' | 'herbs' | 'sterile'

export function newInjury(id: string, type: string, severity: number, day: number): Injury {
  return {
    id, type, severity, sinceDay: day,
    treatedDay: null, infected: false, feverSinceDay: null,
    stageDay: day, healDay: null,
  }
}

/**
 * 髒污的化膿率乘數。
 *
 * ★★ 第六輪重新錨定。舊版是 `1 + (1 − h/100) × 0.5`，把 canon 的 34%
 *    當成「hygiene = 100」的基準往上加。但那個 34% 量的是
 *    【不每日沐浴的常態瑟瑞恩勞工】——它本來就是「典型」而不是「潔淨」。
 *
 *    舊版的後果：實測未處置化膿率第 10 日起穩定在 59.7%，
 *    最壞（hygiene 0 ＋ warmth 0）是 0.34 × 1.5 × 1.3 = **66.3%**，
 *    ＝ 釘死值的 1.95 倍。而本輪要把這個數字【印在畫面上】，
 *    於是那個超模會從隱形變成一個印出來的謊。
 *
 *    新錨點：**hygiene 60 ＝ canon 的 34%**（典型勞工），
 *    比典型乾淨則低於 34%，比典型髒則高於 34%，並夾住上下限。
 *    hygiene 100 → ×0.85／60 → ×1.00／0 → ×1.25
 */
function hygieneMul(hygiene: number): number {
  return Math.max(0.85, Math.min(1.25, 1 + (0.6 - hygiene / 100) * 0.5))
}

/**
 * ★ 低體溫是【傷病放大器】，不是獨立死因。
 * warmth 100 → ×1.0；warmth 0 → ×1.3。係數弱於髒污（0.5），因為
 * canon 明載鹽澤是海洋性氣候、四季溫差適中（world/geography/saltmarch/_region.md），
 * 且枯收季＝秋高氣爽（world/daily_life/calendar-and-festivals.md）。
 * 全知識庫可引用的低溫致死數據【全部】在斷脈／大寂原的灰冬，
 * 套到 C.R. 837 枯收季的鹵港會是憑空發明——故本作不設凍死路徑，見 §Q2 裁決。
 */
function coldMul(warmth: number): number {
  // 同樣以「典型」為錨（warmth 60 ＝ ×1.0），並夾住上下限。
  // 兩個乘數相乘後的最壞情況因此是 0.34 × 1.25 × 1.15 ≈ 48.9%（1.44 倍），
  // 而不是舊版的 66.3%（1.95 倍）。
  return Math.max(0.9, Math.min(1.15, 1 + (0.6 - warmth / 100) * 0.3))
}

export function suppurationChance(t: Treatment, hygiene: number, warmth = 100): number {
  const base =
    t === 'sterile' ? P_SUPPURATE_STERILE : t === 'herbs' ? P_SUPPURATE_HERBS : P_SUPPURATE_UNTREATED
  return Math.min(0.95, base * hygieneMul(hygiene) * coldMul(warmth))
}

/** 供 UI 顯示【實算】機率，禁止介面自己硬寫百分比（第五輪徹查：UI 的 34%→21% 是騙人的）。 */
export function quoteSuppuration(s: GameState, t: Treatment): number {
  return suppurationChance(t, s.needs.hygiene, s.needs.warmth)
}

/**
 * 把化膿率拆成具名的三部分，讓 UI 能說「清潔讓它 +N%」而不必自己相減湊數。
 * ★ 這是「整潔度到底在幹什麼」這個問題的機器可讀答案。
 */
export function explainSuppuration(s: GameState, t: Treatment): {
  base: number; hygieneMul: number; coldMul: number; total: number
} {
  const base = t === 'sterile' ? P_SUPPURATE_STERILE : t === 'herbs' ? P_SUPPURATE_HERBS : P_SUPPURATE_UNTREATED
  const hm = hygieneMul(s.needs.hygiene)
  const cm = coldMul(s.needs.warmth)
  return { base, hygieneMul: hm, coldMul: cm, total: Math.min(0.95, base * hm * cm) }
}

/** 發燒無法上工。感染的主要後果是斷了收入，不是骰死亡。 */
export function isIncapacitated(s: GameState): boolean {
  return s.injuries.some((i) => i.infected && i.healDay === null)
}

/** 這道傷此刻是否還需要（且還能）處置 */
export function needsTreatment(i: Injury): boolean {
  return i.healDay === null && i.treatedDay === null
}

export interface BodyEvent {
  key: 'suppurate' | 'worsen' | 'crisis' | 'healed'
  injury: string
  text: string
}

export interface DayProgress {
  injuries: Injury[]
  events: BodyEvent[]
  death: string | null
  /** 發燒失能：當日無法工作 */
  incapacitated: boolean
}

function treatmentOf(s: GameState, i: Injury): Treatment {
  if (s.flags[`treated:${i.id}:sterile`]) return 'sterile'
  if (s.flags[`treated:${i.id}:herbs`]) return 'herbs'
  return 'none'
}

/**
 * 每日結算（於睡眠時呼叫）。決定性：同 seed 同 day 同傷口 → 同結果。
 *
 * ★ 與舊版的關鍵差異：每一階段【只擲一次】，命中才前進，沒命中就走向痊癒。
 *   舊版每夜重擲全部三段，所以擦傷必死。
 */
export function progressInjuries(s: GameState): DayProgress {
  const events: BodyEvent[] = []
  let death: string | null = null
  let incapacitated = false
  const day = s.clock.day
  const out: Injury[] = []

  for (const inj of s.injuries) {
    const next = { ...inj }

    // ⓿ 已在痊癒期：到期就從身上消失
    if (next.healDay !== null) {
      if (day >= next.healDay) {
        events.push({ key: 'healed', injury: next.type, text: `${next.type}結疤了。它不再痛，只留一道痕。` })
        continue // 移除
      }
      out.push(next)
      continue
    }

    const elapsed = day - next.stageDay
    const t = treatmentOf(s, next)

    // ① 未化膿：窗口滿了才擲【一次】化膿判定
    if (!next.infected && next.severity > 0) {
      if (elapsed >= DAYS_TO_SUPPURATE) {
        const p = suppurationChance(t, s.needs.hygiene, s.needs.warmth)
        if (roll(s.meta.seed, 'injury', p, 'suppurate', next.id, day)) {
          next.infected = true
          next.feverSinceDay = day
          next.stageDay = day
          events.push({ key: 'suppurate', injury: next.type, text: `${next.type}的傷口邊緣泛紅發熱——化膿了。你開始發燙，今天沒辦法上工。` })
        } else {
          // ★ 沒化膿就開始好。傷口會痊癒——這是舊版最缺的一塊。
          next.healDay = day + (t === 'none' ? DAYS_TO_HEAL_UNTREATED : DAYS_TO_HEAL_TREATED)
        }
      }
      out.push(next)
      if (next.infected) incapacitated = true
      continue
    }

    // ② 已化膿、未達嚴重：窗口滿了才擲【一次】惡化判定
    //    ★ 化膿後【處置仍然有效】：把惡化率從 40% 壓到 15%。
    //    舊版的 ① 被 !infected 擋住，導致化膿後治療的效果【精確為 0】，
    //    而 UI 還在收 1 銅並宣稱「34% → 21%」。
    //    canon 明載化膿後的凡俗處置是有效的
    //    （still-ward-tally：石灰水沖洗＋燒灼＋蜂蜜敷、臥床 21 日而癒），
    //    但不是保證（dret-scale-cuff 的同班守衛處置過仍在第 21 日死亡）。
    if (next.infected && next.severity < 3) {
      if (elapsed >= DAYS_TO_WORSEN) {
        // ★ 處置【大幅降低】惡化率，但不是免疫。
        //   第一次修這條時我讓「處置 ＝ 100% 保證痊癒」，結果 300 局跑分裡
        //   敗血死亡零例、死因 100% 是脫水——傷病系統對結果毫無貢獻。
        //   canon 也不支持那種保證：dret-scale-cuff 的同班守衛處置過仍在第 21 日死亡。
        const pw = t === 'none' ? P_WORSEN : P_WORSEN_TREATED
        if (roll(s.meta.seed, 'injury', pw, 'worsen', next.id, day)) {
          next.severity = 3
          next.stageDay = day
          events.push({ key: 'worsen', injury: next.type, text: `${next.type}的傷勢惡化了。你開始發冷，而且冷得不對。` })
        } else {
          next.healDay = day + (t === 'none' ? DAYS_TO_HEAL_UNTREATED : DAYS_TO_HEAL_TREATED)
          events.push({
            key: 'healed', injury: next.type,
            text: t === 'none'
              ? `${next.type}的紅腫自己退了一點。你運氣好。`
              : `${next.type}的紅腫退了一圈。處置起了作用。`,
          })
        }
      }
      out.push(next)
      incapacitated = true
      continue
    }

    // ③ 嚴重＋化膿：窗口滿了才擲【一次】死亡判定
    //    她永遠不能被 光耀+淨 治癒（canon-07 §4）。處置只能把 38.5% 壓到 19%。
    if (next.severity >= 3 && next.infected) {
      if (elapsed >= DAYS_TO_CRISIS) {
        const p = t === 'none' ? P_DEATH_SEVERE : P_DEATH_SEVERE_TREATED
        if (death === null && roll(s.meta.seed, 'injury', p, 'death', next.id, day)) {
          death = `死於${next.type}引發的敗血`
        } else {
          next.healDay = day + DAYS_TO_HEAL_UNTREATED
          events.push({ key: 'crisis', injury: next.type, text: `${next.type}的燒退了。你撐過來了——這一次。` })
        }
      }
      out.push(next)
      incapacitated = true
      continue
    }

    out.push(next)
  }

  return { injuries: out, events, death, incapacitated }
}

// ─────────────────────── 剝奪（飢／渴）───────────────────────

/**
 * ★★ 第五輪徹查抓到的、也就是使用者回報的「角色無法死亡」的根因。
 *
 * 舊版：hungryTicks / thirstyTicks 【只在 case 'sleep' 遞增】，
 *       而且是「起床那一瞬間的快照」——needs 必須剛好在黎明為 0 才算一次。
 *       實測：不吃不喝但【不睡覺】，在城裡遊蕩 16.7 天不會死，兩個計數器恆為 0。
 *       白天挨餓完全零代價，且只要每三個黎明有一次 satiety>0 就永不餓死。
 *
 * 新版：改為【連續剝奪分鐘】。歸零後每一分鐘都在計費，睡覺也計費——
 *       脫水不會因為睡著而暫停。吃一餐／喝一次水則以 1:1 消退，
 *       與「一日一份主食」的 canon 錨點同構。
 *
 * 門檻是把 clock.ts 檔頭既有的宣告落實，不是新數字：
 *   「無水約 3 日致死（thirst），飢餓約 4 日」
 *   渴：歸零後 720 / 1440 / 2160 分（＝1.5 日）→ 加上歸零所需的 1400 分 ≈ 無水 2.75 日
 *   餓：歸零後 1440 / 2880 / 4320 分（＝3 日）→ 加上歸零所需的 1600 分 ≈ 無食 4.4 日
 */
export const DEPRIVATION_STAGES: Record<'thirst' | 'starve', [number, number, number]> = {
  thirst: [720, 1440, 2160],
  starve: [1440, 2880, 4320],
}

export type DeprivationKey = 'thirst' | 'starve'
export const DEPRIVATION_NEED: Record<DeprivationKey, NeedKey> = {
  thirst: 'hydration',
  starve: 'satiety',
}

export interface Deprivation { starveMinutes: number; thirstMinutes: number }

/** 目前處於第幾階（0 = 沒事，1/2 = 警告，3 = 死） */
export function stageOf(k: DeprivationKey, minutes: number): 0 | 1 | 2 | 3 {
  const [a, b, c] = DEPRIVATION_STAGES[k]
  if (minutes >= c) return 3
  if (minutes >= b) return 2
  if (minutes >= a) return 1
  return 0
}

/** 離死還有幾分鐘（尚未進入剝奪則回傳 null） */
export function minutesToDeath(k: DeprivationKey, minutes: number): number | null {
  if (minutes <= 0) return null
  return Math.max(0, DEPRIVATION_STAGES[k][2] - minutes)
}

/**
 * 推進剝奪計時。純函數。
 * 需求 <= 0 → 累加；> 0 → 以 1:1 消退（不瞬間歸零，所以「吃一餐」買回的是等量時間）。
 */
export function deprive(dep: Deprivation, minutes: number, needs: GameState['needs']): Deprivation {
  const step = (cur: number, atZero: boolean) =>
    atZero ? cur + minutes : Math.max(0, cur - minutes)
  return {
    starveMinutes: step(dep.starveMinutes, needs.satiety <= 0),
    thirstMinutes: step(dep.thirstMinutes, needs.hydration <= 0),
  }
}

export interface Hazard {
  death: string | null
  /** 給 UI 的純數值警訊，零文本（文本在 data/conditions.json） */
  warnings: Array<{ key: DeprivationKey; stage: 1 | 2; minutesToDeath: number }>
}

/**
 * 需求剝奪的後果。★ 零文本：只回傳 key + stage + 倒數。
 * 敘事一律由資料層提供（鐵律 5：內容零邏輯）。
 */
export function needsHazard(s: GameState): Hazard {
  const warnings: Hazard['warnings'] = []
  let death: string | null = null
  const DEATH_TEXT: Record<DeprivationKey, string> = { thirst: '死於脫水', starve: '死於飢餓' }

  for (const k of ['thirst', 'starve'] as DeprivationKey[]) {
    const m = k === 'thirst' ? s.deprivation.thirstMinutes : s.deprivation.starveMinutes
    const st = stageOf(k, m)
    if (st === 3) death = death ?? DEATH_TEXT[k]
    else if (st === 1 || st === 2) warnings.push({ key: k, stage: st, minutesToDeath: minutesToDeath(k, m) ?? 0 })
  }
  return { death, warnings }
}
