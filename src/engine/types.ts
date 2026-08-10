/**
 * 型別定義：遊戲狀態 + 內容資料。
 *
 * 紀律 1：本檔（與整個 engine/）不得 import 任何 UI 套件。
 * 紀律 3：金錢一律以【銅】為整數。1 金帝 = 240 銅，非十進。絕不以浮點金帝儲存。
 * 紀律 8：時間一律以【整數分鐘】計。禁止小數分鐘。
 */

// ─────────────────────────── 基本別名 ───────────────────────────

export type NodeId = string // 一律帶城市前綴，如 'bh:quays'（紀律 9）
export type EdgeId = string
export type ItemId = string
export type JobId = string
export type EventId = string
export type FactionId = string

/** 出處標記：每個資料數值都要帶，供建置期統計 invented 比例 */
export type Src = string // 'canon:...' | 'derived:...' | 'invented:...'

export type Tide = 'rise' | 'ebb'

// ─────────────────────────── 條件 DSL ───────────────────────────

/** 比較式：'<15' '>=30' '=0' '!=0' */
export type Cmp = string

export interface Cond {
  all?: Cond[]
  any?: Cond[]
  not?: Cond

  at?: NodeId | NodeId[]
  onEdge?: EdgeId
  /** [from, to)；from > to 視為跨午夜 */
  hours?: [number, number]
  /** 遊戲日比較。★ 主線章節的節奏閘門——沒有它，一個下午就能把三章跑完（試玩實測）。 */
  day?: Cmp
  tide?: Tide
  tideJustTurned?: Tide

  /** 需求數值比較，key 為 needs 欄位名 */
  needs?: Partial<Record<NeedKey, Cmp>>
  /** 錢包比較（銅） */
  copper?: Cmp

  has?: { item: ItemId; min?: number }
  injury?: {
    infected?: boolean
    untreated?: boolean
    minSeverity?: number
    minAgeDays?: number
  }

  /** 引用物價表求值，而非寫死常數 */
  canAfford?: ItemId
  cannotAfford?: ItemId

  knowsRoutes?: Cmp
  knowsRoute?: EdgeId
  rep?: { faction: FactionId; op: string; value: number }
  nodeSecurity?: Cmp
  /** NPC 三軸比較：{ npc, axis, cmp } */
  npc?: { id: NpcId; axis: 'acquaintance' | 'trust' | 'affection'; is: Cmp }
  /**
   * ★ 「有幾個人認得她」——第五章「平凡」要的是【廣度】而不是深度。
   * 05_main_story.md 已把 acquaintance 定義為「他認得你的臉」、
   * affection 定義為「安家線的伴侶；平凡線的鄰人」。深度關係是安家的；
   * 平凡要的是鄰人——多而不深。這條分工是既有裁決，不是為結局發明的。
   */
  npcCount?: { axis: 'acquaintance' | 'trust' | 'affection'; is: Cmp; atLeast: number }
  /**
   * ★ 認得她的人裡，有幾個【所在節點沒有任何工作】。
   *   實作查工作表而非寫死名字——理由見 cond.ts 該分支的註解。
   */
  npcOffWage?: { axis: 'acquaintance' | 'trust' | 'affection'; is: Cmp; atLeast: number }
  /** 有人指名要她手藝的次數 */
  namedAsks?: Cmp
  /** 她去上了工的日數（量可靠性，不量成功） */
  wageDays?: Cmp
  /** 無償把東西給出去的次數 */
  givenAway?: Cmp
  flag?: string
}

// ─────────────────────────── 內容資料 ───────────────────────────

/**
 * ★★ 節點設施的【封閉詞彙表】。
 *
 * 加它的理由：`services` 原本是 `string[]`，於是
 *   · 打錯字沒有任何人會發現（`wash` 打成 `wasch` → 洗滌場的按鈕靜默不 render）
 *   · 而 tsc 也幫不上忙，因為 data/*.json 一律 `as Content` 硬轉，
 *     JSON 的值對型別是不透明的
 *
 * ★ 更重要的是它讓一件事變得可查：資料裡有 20 種 service 值，
 *   而 src 真正讀到的只有 5 種（wash/well/rinse 走 mind.ts 的 CLEAN 表，
 *   sleep-bunk/sleep-room 在 App.tsx）。其餘 15 種是純裝飾。
 *   validate-data 會逼每一種都給出「有讀取端」或「寫下來的理由」二選一——
 *   否則「寫了 service 就會有那個設施」會變成一個假直覺。
 */
export const SERVICES = [
  // 有讀取端的（機制）
  'wash', 'well', 'rinse', 'sleep-bunk', 'sleep-room',
  // 目前為氛圍標記
  'buy', 'sell', 'alms', 'craft', 'repair', 'sell-metal', 'buy-blackmarket',
  'food-cheap', 'food-cheapest', 'drink', 'sleep-rough',
  'job-dayhire', 'job-errand', 'job-rake', 'job-rope',
] as const
export type Service = typeof SERVICES[number]

export interface WorldNode {
  id: NodeId
  name: string
  canonRef: string
  elevation: number // 公尺
  security: 1 | 2 | 3 | 4 // 1 最嚴，4 為城防死角
  outsideWalls?: boolean
  services: Service[]
  /** 此地販售的商品（★ 必須明列。原本靠 services 猜，導致任何地點都能買到全部商品） */
  sells: ItemId[]
  /** 此地收購的物品 */
  buys: ItemId[]
  /**
   * ★ 可獨處的時段（24 時制，from > to 視為跨午夜）。不填 ＝ 永不可獨處。
   * 隱私是【推導值】而不是第七條需求——唯一的消費者是 mind.canUnwind，
   * 所以它不會變成第二個像 services:'wash' 那樣寫了卻沒人讀的孤兒欄位。
   */
  privateHours?: [number, number]
  /** 地圖上的相對方位（0–100，僅供 SVG 排版；Y 由 elevation 決定） */
  mapX?: number
  desc: string
  src: Src
}

export type NpcId = string

export interface NpcDef {
  id: NpcId
  name: string
  at: NodeId
  /** 出現時段（24 時制）；不填為全時 */
  when?: [number, number]
  role: string
  race: string
  grade: string
  desc: string
  /** 熟識度對機制的影響說明（給玩家看的） */
  effect: string
  /**
   * 閒聊台詞池。鐵律 5：敘事文本一律在 data，不得纏進程式碼。
   * 依當下絕對分鐘取模挑選 —— 決定性，同 seed 重播不漂移。
   */
  talkLines: string[]
  src: Src
}

export interface NpcState {
  /** 三軸，各 0–100 */
  acquaintance: number
  trust: number
  affection: number
  lastSeenDay: number | null
  /** 她告訴過對方什麼（★ 說出你從哪來是有風險的，canon-07 §6） */
  knownFacts: string[]
}

export interface WorldEdge {
  id: EdgeId
  a: NodeId
  b: NodeId
  name: string
  minutes: number // 整數
  /** a → b 之高程差（公尺）。體力消耗由 minutes + 高程在 map.ts 計算，不另存欄位（避免兩個真相來源） */
  elevationDelta: number
  /** 爬升代價倍率：坡道 1；石階 2.5（同樣的高度，階梯遠比坡道累） */
  climbFactor?: number
  riskDay: number
  riskNight: number
  knowledge: 'public' | 'learned'
  requiresTide?: Tide
  tell?: string
  src: Src
}

export interface ItemDef {
  id: ItemId
  name: string
  priceCopper: number | null // null = 不可購得
  sellCopper?: number
  uses?: number // 消耗品次數；不填為不限
  weight: number
  desc: string
  modern?: boolean // 外來之物：canon-07 §5
  riskIfSeen?: number // 被看見的風險（外來之物）
  src: Src
}

export interface JobDef {
  id: JobId
  name: string
  at: NodeId
  when: [number, number]
  minutes: number
  payCopper: number
  /** 錄取機率；1 = 保證錄取 */
  hireChance: number
  /**
   * ★ 一天最多能【嘗試】幾次（不是錄取幾次）。
   * 試玩第二輪抓到的經濟破口：跑腿送信一天可連做三趟 ＝ 24 銅，
   * 使「一天的工剛好只夠買一天的生存」這條正典推導出來的貧窮陷阱失效。
   * 依據：挑人一天只挑一次；委託單也是有限的（canon 日薪工一年僅 80–160 天有工可做）。
   */
  maxPerDay: number
  /**
   * ★★ 這不是工，是【領救濟】。它用 job 機制是因為排隊領救濟本來就是 job 的形狀
   * （去一個地方、花掉一段時間、拿到東西、一天一次），而 costs 的正值即為增益。
   *
   * ★ 但它【不得計入 wageDays】，而這一格就是為了那件事存在的：
   *   wageDays 是「平凡地度過一生」的可靠性條件（≥18 日），
   *   它的錨點是陶恩替那一戶寫了十八年同一行字的理由——「從不遲到、也從不多要」。
   *   若排施捨隊算上工，她就能靠領救濟滿足「可靠」，而那把那句話的意思整個顛倒過來。
   *   這是一個【只會在條件與內容之間】出錯的缺陷，正是本專案反覆踩到的那個類別。
   */
  charity?: boolean
  /** 錄取機率受此需求調節（每低 50 點降至 hireChanceAtZero） */
  hireModBy?: NeedKey
  hireChanceAtZero?: number
  /**
   * ★ 完成這份工會養誰的關係。
   * 試玩實測：關係只靠一次性事件推，事件用完 NPC 就變成死的，
   * 於是主線三條路的信任門檻（35–45）永遠到不了。
   * 而她每天本來就在替老克瓦扛貨、替穗爾跑單——【關係應該從她已經在做的事長出來】，
   * 而不是另外開一條刷好感的支線。
   */
  npcOnComplete?: { id: NpcId; acquaintance?: number; trust?: number; affection?: number }
  requires?: Cond
  costs: Partial<Record<NeedKey, number>>
  risks?: Array<{ chance: number; tell: string; injury: string }>
  tell: string
  desc: string
  src: Src
}

export interface Choice {
  label: string
  cost?: { minutes?: number } & Partial<Record<NeedKey, number>>
  gain?: {
    copper?: number; item?: ItemId; learnRoute?: EdgeId
    /**
     * 一或多個 flag。
     * ★ 支援陣列是為了修一個真缺陷：`identity-obtained` 在 design/05_main_story.md
     *   已宣告為第三章的出章 flag，但在 events.json 裡【出現 0 次】——
     *   因為 gain.flag 只放得下一個字串，而那三個成功分支各自已經佔用了 path-*。
     *   建置期現在強制「設 path-* 者必須同時設 identity-obtained」，兩者不可能分歧。
     */
    flag?: string | string[]
    /**
     * ★ 敘事選項也能把人移走。缺這格會讓「繞路走回去」這種選項變成原地不動
     * （試玩實測：因此被困在蒸發池三天渴死）。
     */
    moveTo?: NodeId
    /**
     * ★ 事件選項直接處置傷口。
     * 舊版 ev-wound-notice 寫的是全域 flag `treated-herbs`，
     * 而 body.ts 讀的是 `treated:<傷口id>:<方式>` —— 兩邊對不上，
     * 於是玩家付了 1 銅／燒掉一片 OK 繃，化膿率【一點都沒降】，
     * 而遊戲當場回饋「你成功了」。這是最惡劣的一種死法。
     */
    treatInjury?: 'herbs' | 'sterile'
    /** 這一次是「有人指名要她的手藝」 */
    namedAsk?: boolean
    /** 這一次是「無償把東西給出去」 */
    giveAway?: boolean
    npc?: { id: NpcId; acquaintance?: number; trust?: number; affection?: number; fact?: string } }
  spend?: { copper?: number; item?: ItemId }
  requires?: Cond
  risks?: Array<{ chance: number; tell: string; injury?: string; loseCopper?: number }>
  resultText?: string
}

export interface EventDef {
  id: EventId
  /** 人看得懂的短名 —— 會出現在死亡回溯的決策鏈裡（試玩發現原本顯示內部 id，讀不懂） */
  name: string
  where?: Cond
  when?: Cond
  requires?: Cond
  weight: number
  once?: boolean
  cooldownDays?: number
  /** 帶致命風險者必須有 tell —— 建置期強制檢查 */
  tell?: string
  lethal?: boolean
  text: string
  choices: Choice[]
  src: Src
}

// ─────────────────────────── 狀態 ───────────────────────────

export type NeedKey = 'satiety' | 'hydration' | 'stamina' | 'warmth' | 'hygiene' | 'sanity'

/**
 * ★ 只有六個鍵，而且【沒有慾望】。
 *
 * 使用者裁定：「**慾望是理智的一部分**，因此宣洩慾望時可以恢復理智，
 * 所以我們不會對慾望設計專屬槽位，他只是一個可以用於恢復理智的分支之一，
 * 就像吃到好吃的東西、睡在好的環境一樣。」
 *
 * 於是全遊戲沒有那個量——連 `GameState` 裡都沒有欄位可以放它。
 * `00_pillars.md` 支柱二條款 2「不設慾望槽」因此【字面成立】，不需要任何修憲。
 *
 * sanity 進 NeedKey 的好處是免費獲得四樣既有基礎設施：
 * Cond DSL（`needs.sanity`）、`job.costs`、`Choice.cost`、
 * 以及 `LedgerEntry.needsAfter`（死亡回溯自動列出它）。
 *
 * 「進 needs 就會變成被時間追殺的槽」這個顧慮在本 codebase 不成立：
 * DECAY_PER_MIN 的 stamina 與 warmth 早就是 0（見 clock.ts），這張表本來就允許 0。
 */

export interface Injury {
  id: string
  type: string
  severity: number // 1 輕 / 2 中 / 3 嚴重
  sinceDay: number
  treatedDay: number | null
  infected: boolean
  feverSinceDay: number | null
  /** 進入【目前這一階段】的那一天。每階段只判定一次，窗口從這天起算。 */
  stageDay: number
  /**
   * 痊癒日；null = 還在惡化路徑上。
   * ★ 舊版沒有這格，所以傷口永不痊癒，一道擦傷在 14 日內 95.6% 致死。
   */
  healDay: number | null
}

/** 決策記錄：紀律 5 —— 不做死亡回溯畫面可以，不記帳不行 */
export interface LedgerEntry {
  /**
   * 'action' = 玩家的決定；'body' = 身體發生的事。
   * ★ 舊版 126 筆 ledger 裡含「傷／膿／燒／敗血／餓／渴／死」字樣者是 0 筆——
   *   死於敗血的玩家在決策鏈上看不到自己是在哪一步受的傷。
   */
  kind: 'action' | 'body'
  day: number
  minute: number
  at: NodeId
  action: string
  detail: string
  copperBefore: number
  copperAfter: number
  needsAfter: Record<NeedKey, number>
  /** 當時存在、但未被選擇的替代方案 */
  alternatives: string[]
}

export interface GameState {
  meta: { schemaVersion: number; seed: string; startedAt: string }
  clock: { day: number; minute: number } // minute: 0..1439
  at: NodeId
  needs: Record<NeedKey, number> // 0..100
  /**
   * ★ 連續剝奪分鐘。這是使用者回報「角色無法死亡」的修法核心。
   * 舊版用 stats.hungryTicks / thirstyTicks，【只在 case 'sleep' 遞增】，
   * 且是「起床那一瞬間的快照」——實測不吃不喝但不睡覺，遊蕩 16.7 天不會死。
   * 改為連續分鐘後，歸零的每一分鐘都在計費，睡覺也計費。
   */
  deprivation: { starveMinutes: number; thirstMinutes: number }
  /**
   * 心理狀態的旁支。
   * ★ 這裡【沒有 desire】：使用者裁定「慾望是理智的一部分，不設專屬槽位」，
   *   於是全遊戲沒有那個量。見 mind.ts 檔中段的說明。
   */
  mind: {
    /** 昨夜睡在哪。日界結算讀它；null = 沒睡。 */
    lastShelter: 'rough' | 'bunk' | 'room' | null
    lastUnwindDay: number | null
  }
  injuries: Injury[]
  purse: { copper: number } // 整數銅
  carry: Array<{ item: ItemId; count: number; usesLeft?: number }>
  knownRoutes: EdgeId[]
  rep: Record<FactionId, number>
  npcs: Record<NpcId, NpcState>
  flags: Record<string, boolean>
  eventHistory: Record<EventId, number> // eventId -> 最後發生的絕對分鐘（day*1440+minute）
  ledger: LedgerEntry[]
  /** 統計：供局末摘要 */
  stats: {
    earnedCopper: number
    spentCopper: number
    /** 全局最久的連續空腹／缺水（分鐘），供局末摘要。取代語意錯誤的「餓到發昏 N 次」 */
    maxStarveMinutes: number
    maxThirstMinutes: number
    injuriesTaken: number
    injuriesInfected: number
    injuriesHealed: number
    wastedTrips: number
    edgeUse: Record<EdgeId, number>
    eventsSeen: EventId[]
    /** 當日已嘗試次數，鍵為 `${day}|${jobId}`（含落選——挑人一天只挑一次） */
    jobAttempts: Record<string, number>
    /**
     * ★ 第五章結局所需的三個具名計數器。
     * 它們刻意是【計數】而不是 flag：結局要問的是「幾次」，不是「有沒有」。
     *
     * · namedAsks  有人【指名】要她的手藝的次數。這是 05_main_story.md 早就寫著、
     *              但從未兌現的那句「有一門別人需要你的手藝」——第 4 層的非階位形式。
     * · wageDays   她去上了工的【日數】（不是次數）。量的是可靠性，不是成功；
     *              錨點是陶恩替馬可那一戶寫了十八年同一行字的理由：
     *              「那一戶從不遲到、也從不多要。」
     * · givenAway  無償把東西給出去的次數。代價一律是機會成本而不是 1 銅——
     *              當天唯一的熱食、處置自己傷口用的那塊布、一個工作名額。
     *              ★ 只計凡俗物；modern:true 的外來之物一律不計（canon/07 §5.2）。
     */
    namedAsks: number
    wageDays: number
    givenAway: number
    /** 已計入 wageDays 的日子，避免同一天重複計（鍵為 day） */
    wageDaySeen: Record<string, boolean>
  }
  dead: null | { day: number; cause: string }
  ended: boolean
}

/** data/conditions.json 的形狀。engine 只認 key，文本一律由此提供。 */
export interface ConditionText {
  deprivation: Record<string, { name: string; stages: string[]; death: string; eta: string }>
  warmth: { warn: string; note: string }
  shelter: Record<string, string>
  injury: Record<string, string>
  treat: Record<string, string>
  needs: Record<string, { what: string; does: string; exits: string }>
  sanity: { bands: Record<string, string>; note: string; rows: Record<string, string> }
  unwind: Record<string, string>
  clean: Record<string, string>
  hygiene: Record<string, string>
  alternatives: Record<string, string>
  modern: Record<string, string>
}

/** 結局定義。實作在 ending.ts；型別放這裡以免 types ⇄ ending 循環 import。 */
export interface EndingDef {
  id: string
  aim: string
  name: string
  tagline: string
  asks: string
  requires: Cond
  text: string
  gaveUp: string
  opensLongform?: boolean
  src: Src
}

export interface Content {
  npcs: NpcDef[]
  nodes: WorldNode[]
  edges: WorldEdge[]
  items: ItemDef[]
  jobs: JobDef[]
  events: EventDef[]
  conditions: ConditionText
  endings: EndingDef[]
}

/** 索引化的內容，供求值器 O(1) 查找 */
export interface Index {
  node: Map<NodeId, WorldNode>
  edge: Map<EdgeId, WorldEdge>
  item: Map<ItemId, ItemDef>
  job: Map<JobId, JobDef>
  event: Map<EventId, EventDef>
  npc: Map<NpcId, NpcDef>
  ending: Map<string, EndingDef>
  /** 敘事文本（鐵律 5：engine 不持有文本，只持有它的 key） */
  text: ConditionText
  /** 鄰接表：nodeId -> 該點所有邊 */
  adj: Map<NodeId, WorldEdge[]>
}

export function must<K, V>(m: Map<K, V>, k: K, what: string): V {
  const v = m.get(k)
  if (v === undefined) throw new Error(`[content] 找不到${what}：${String(k)}`)
  return v
}

export function buildIndex(c: Content): Index {
  const idx: Index = {
    node: new Map(c.nodes.map((n) => [n.id, n])),
    edge: new Map(c.edges.map((e) => [e.id, e])),
    item: new Map(c.items.map((i) => [i.id, i])),
    job: new Map(c.jobs.map((j) => [j.id, j])),
    event: new Map(c.events.map((e) => [e.id, e])),
    npc: new Map((c.npcs ?? []).map((n) => [n.id, n])),
    ending: new Map((c.endings ?? []).map((e) => [e.id, e])),
    text: c.conditions,
    adj: new Map(),
  }
  for (const n of c.nodes) idx.adj.set(n.id, [])
  for (const e of c.edges) {
    idx.adj.get(e.a)?.push(e)
    idx.adj.get(e.b)?.push(e)
  }
  return idx
}
