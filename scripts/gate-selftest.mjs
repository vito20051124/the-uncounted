/**
 * 閘門自測：對【每一道閘】注入一個真違規，斷言它會 exit 1。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 這份檔案存在的唯一理由，是一句被實證過的話：
 *
 *     「一道我沒見過它失敗的閘，等於一道我還沒驗證的閘。」
 *
 * 這不是格言，是本專案的病歷：
 *   · ⑥ 的「結構上永遠為假」那一支從未執行過，而它【根本不會觸發】——
 *     驗證器把自己註解裡的 ctxOf(s, idx, onEdge?, justTurned?) 當成一個
 *     四參數呼叫點，整道檢查靜默失效。
 *   · 修它的時候我只拿掉了 warns 分支、忘了把 exec 換成 anchor，
 *     結果錨點失效變成【完全無聲】——比原本的警告版更糟。
 *   · ⑧ 第一次跑就把動作名 `case 'buy':` 誤判成 service 的讀取端。
 *   · ⑨ 第一次跑就讓一個鬼鍵通過（動態索引讓整個群組都算「有人讀」）。
 *
 * 四次都是【只有刻意注入違規才看得見】。而一次對抗式稽核在三道新閘上
 * 找出 21 個漏洞、【全部是偽綠燈方向】，結論寫得很清楚：
 *   「這三道反向閘之所以被穿透，就是因為沒有人對閘門本身寫回歸測試。」
 *
 * 所以那些臨時的反向測試不能停在對話裡。它們在這裡，跑在 npm run check 上。
 * ══════════════════════════════════════════════════════════════════
 *
 * 做法：把 data/*.json（或 src 檔）暫時改壞 → 跑那道閘 → 斷言它 exit ≠ 0
 * → 【一律還原】。每個案例都有 finally，且結束時驗證工作樹乾淨。
 *
 * ★ 為什麼改 data/ 而不改 content/：這裡測的是【閘門】而不是內容管線，
 *   而 build-data --check 的漂移偵測是另一道獨立的閘（它自己也有案例）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const P = (rel) => path.join(root, rel)

/** 跑一個腳本，回傳 exit code（不吃它的輸出） */
function runGate(script, args = []) {
  try {
    execFileSync(process.execPath, [P(`scripts/${script}`), ...args], { cwd: root, stdio: 'pipe' })
    return 0
  } catch (e) {
    return e.status ?? 1
  }
}

/** 讀 / 寫 JSON */
const readJson = (rel) => JSON.parse(fs.readFileSync(P(rel), 'utf-8'))
const writeJson = (rel, v) => fs.writeFileSync(P(rel), JSON.stringify(v, null, 2))

const results = []
const T = (gate, name, ok, note = '') => results.push({ gate, name, ok, note })

/**
 * 一個案例：暫時改壞 files 裡的每個檔，跑 gate，斷言非零，然後還原。
 * @param mutate  (helpers) => void   —— 改壞
 */
function selfTest({ gate, name, script = 'validate-data.mjs', args = [], files, mutate }) {
  const backups = new Map()
  for (const f of files) backups.set(f, fs.readFileSync(P(f)))
  try {
    mutate({ readJson, writeJson, readText: (f) => fs.readFileSync(P(f), 'utf-8'),
      writeText: (f, t) => fs.writeFileSync(P(f), t) })
    const code = runGate(script, args)
    T(gate, name, code !== 0, code !== 0 ? `exit ${code}` : '★ 閘門【放行】了這個違規')
  } catch (err) {
    T(gate, name, false, `自測本身出錯：${err.message}`)
  } finally {
    for (const [f, buf] of backups) fs.writeFileSync(P(f), buf)
  }
}

/**
 * ★ 開始前先記下工作樹的【基線】。
 *   收尾時要比對的是「有沒有殘留」，而不是「工作樹是不是乾淨」——
 *   開發中本來就會有未提交的改動，拿乾淨樹當標準會讓這一項恆紅。
 *   （而恆紅的斷言跟恆真的斷言一樣沒有用。）
 */
const gitStatus = () => {
  try { return execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf-8' }).trim() }
  catch { return null }
}
const baseline = gitStatus()

// ── 先確認乾淨的 HEAD 是綠的（F-1：任何新閘上線第一件事）──
{
  const code = runGate('validate-data.mjs')
  T('前置', '乾淨的工作樹必須通過 validate-data（否則以下每個案例都無意義）',
    code === 0, code === 0 ? '' : `★ exit ${code} —— 先修這個`)
}

// ══════════════ ④ learned 邊必須有教學來源 ══════════════
selfTest({
  gate: '④', name: '一條 learned 邊沒有任何事件教它',
  files: ['data/edges.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/edges.json')
    d.find((e) => e.id === 'e:grotto-market-lane').knowledge = 'learned'
    writeJson('data/edges.json', d)
  },
})
selfTest({
  gate: '④', name: '教學事件自我指涉（漏了 not，正向要求已經知道那條路）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d.find((e) => e.id === 'ev-learn-fishlane').requires = { knowsRoute: 'e:alley-quays-fishlane' }
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '④', name: '教學事件的閘門結構上恆假（day 超出局長度）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d.find((e) => e.id === 'ev-learn-fishlane').requires = { all: [{ day: '>=99' }] }
    writeJson('data/events.json', d)
  },
})

// ══════════════ ⑤ 宣告 uses 的消耗品必須有消耗路徑 ══════════════
selfTest({
  gate: '⑤', name: '一個沒有任何消耗路徑的物品宣告 uses',
  files: ['data/items.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/items.json')
    d.find((i) => i.id === 'item-local-clothes').uses = 5
    writeJson('data/items.json', d)
  },
})
selfTest({
  gate: '⑤', name: '★ 把引擎的 removeItem 註解掉（最常見的「暫時停用」手法）',
  files: ['src/engine/reduce.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/reduce.ts')
    writeText('src/engine/reduce.ts',
      t.replace("carry = removeItem(s, 'item-ash-salve')", "/* carry = removeItem(s, 'item-ash-salve') */ carry = carry"))
  },
})
selfTest({
  gate: '⑤', name: 'spend.item 落在一個恆假的條件下（不是真通道）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    const ev = d.find((e) => (e.choices ?? []).some((c) => c.spend?.item === 'item-lighter'))
    ev.requires = { all: [{ hours: [6, 7] }, { hours: [20, 21] }] }
    writeJson('data/events.json', d)
  },
})

// ══════════════ ⑥ 謂詞必須有實例且結構上可能為真 ══════════════
selfTest({
  gate: '⑥', name: '★ 用一個 Cond 沒宣告的謂詞（門禁會【整條消失】而非變成恆假）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[0].requires = { all: [{ flagg: 'never-set' }] }
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '⑥', name: '★ 用 onEdge（結構上永遠為假：沒有呼叫點會填它）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[0].requires = { all: [{ onEdge: 'e:alley-quays-fishlane' }] }
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '⑥', name: '★ 用 rep（只有讀取端，恆為「拿 0 去比」）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[3].requires = { all: [{ rep: { faction: 'f-x', op: '>=', value: 10 } }] }
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '⑥', name: '★★ 把 Cond 介面改名（掃描錨點失效必須 error，不得靜默跳過）',
  files: ['src/engine/types.ts'],
  mutate: ({ readText, writeText }) => {
    writeText('src/engine/types.ts',
      readText('src/engine/types.ts').replace('export interface Cond {', 'export interface CondRenamed {'))
  },
})
selfTest({
  gate: '⑥', name: 'COND_KEYS 與型別 Cond 分歧（缺一個鍵）',
  files: ['src/engine/cond.ts'],
  mutate: ({ readText, writeText }) => {
    // ★ 一律用容忍 \r?\n 的正則：這個 repo 在 Windows 上是 CRLF（git autocrlf），
    //   而寫死 '\n' 的字面替換會【靜默不生效】——於是這個自測案例自己變成偽綠燈。
    //   第一次跑就踩到了，而它剛好是「檢查閘門會不會誤放」的那個案例。
    writeText('src/engine/cond.ts', readText('src/engine/cond.ts').replace(/\r?\n\s*'flag',/, ''))
  },
})
selfTest({
  gate: '⑥', name: '同行 JSDoc 讓一個新謂詞隱形（L16：不得靠縮排抓頂層鍵）',
  files: ['src/engine/types.ts', 'src/engine/cond.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/types.ts').split('\n')
    const i = t.findIndex((l) => l.trim() === 'flag?: string')
    t.splice(i, 0, '  /** 出門前看天色 */ weather?: string')
    writeText('src/engine/types.ts', t.join('\n'))
  },
})

// ══════════════ ⑦ item 雙向斷鏈 ══════════════
selfTest({
  gate: '⑦', name: '條件讀一個【取得不到】的物品（死事件）',
  files: ['data/events.json', 'data/nodes.json'],
  mutate: ({ readJson, writeJson }) => {
    const n = readJson('data/nodes.json')
    for (const x of n) x.sells = (x.sells ?? []).filter((i) => i !== 'item-holy-water')
    writeJson('data/nodes.json', n)
    const d = readJson('data/events.json')
    d[8].requires = { all: [{ has: { item: 'item-holy-water' } }] }
    writeJson('data/events.json', d)
  },
})

// ══════════════ ⑧ services 詞彙表 ══════════════
selfTest({
  gate: '⑧', name: 'service 拼錯（設施的按鈕會靜默不 render）',
  files: ['data/nodes.json'],
  mutate: ({ readJson, writeJson }) => {
    const n = readJson('data/nodes.json')
    n.find((x) => x.id === 'bh:market').services.push('sleep-romo')
    writeJson('data/nodes.json', n)
  },
})

// ══════════════ ⑨ conditions.json 雙向對應 ══════════════
selfTest({
  gate: '⑨', name: '★ 引擎會產生的鍵沒有對應文案（玩家會看到內部英文鍵）',
  files: ['data/conditions.json'],
  mutate: ({ readJson, writeJson }) => {
    const c = readJson('data/conditions.json')
    delete c.sanity.rows.roughNight
    writeJson('data/conditions.json', c)
  },
})
selfTest({
  gate: '⑨', name: '資料有文案但引擎不會產生那個鍵（死文案）',
  files: ['data/conditions.json'],
  mutate: ({ readJson, writeJson }) => {
    const c = readJson('data/conditions.json')
    c.sanity.rows.zzzGhost = '沒有人會產生這個鍵'
    writeJson('data/conditions.json', c)
  },
})

// ══════════════ ⑫ 敘事變體必須每一則都抽得到 ══════════════
selfTest({
  gate: '⑫', name: '池子裡有兩則一模一樣（複製貼上寫壞，玩家照樣讀到重複）',
  script: 'unit-test.ts',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    const ev = d.find((e) => e.id === 'ev-market-well')
    ev.variants[1] = ev.variants[0]
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '⑫', name: '★ 把選則邏輯改成永遠取第 0 則（尾巴那幾百個字變成白寫，畫面上完全正常）',
  script: 'unit-test.ts',
  files: ['src/engine/events.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/events.ts')
    const from = "const i = Math.floor(rand(s.meta.seed, 'flavor'"
    if (!t.includes(from)) throw new Error('注入錨點失效：eventText 的選則行找不到')
    writeText('src/engine/events.ts',
      t.replace(from, "const i = 0 * Math.floor(rand(s.meta.seed, 'flavor'"))
  },
})
selfTest({
  gate: '⑫', name: '★ salt 拿掉 minute（同一天的第二次取水會一字不差）',
  script: 'unit-test.ts',
  files: ['src/engine/events.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/events.ts')
    const from = 's.clock.day, s.clock.minute, s.at'
    if (!t.includes(from)) throw new Error('注入錨點失效：eventText 的 salt 找不到')
    // 只留 day：可抽到的組合從 30×144×節點數 掉到 30×節點數，
    // 池子大的那一幕就會出現抽不到的則。
    writeText('src/engine/events.ts', t.replace(from, "s.clock.day, 0, 'bh:market'"))
  },
})

// ══════════════ ②-bis 玩家可見欄位不得含設計註記 ══════════════
selfTest({
  gate: '②-bis', name: '★ 設計註記寫進 gain.npc.fact（白名單反轉前漏掉的欄位）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[0].choices[0].gain = Object.assign({}, d[0].choices[0].gain,
      { npc: { id: 'npc-quays-foreman', fact: '見 design/05_main_story.md 的支柱三樣板' } })
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: '②-bis', name: '設計註記寫進 ending.name（宣稱只豁免 event.name）',
  files: ['data/endings.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/endings.json')
    d[0].name = '安家 ★ 見 canon/07'
    writeJson('data/endings.json', d)
  },
})

// ══════════════ 事件抽取權重 ══════════════
selfTest({
  gate: 'weight', name: 'weight: 0（恆不被抽中）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[5].weight = 0
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: 'weight', name: 'cooldownDays 大於局長度（「一局一次」的偽裝寫法）',
  files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d[5].cooldownDays = 400
    writeJson('data/events.json', d)
  },
})

// ══════════════ 路段值域與連通性 ══════════════
selfTest({
  gate: '值域', name: "requiresTide 拼錯（那條路段會【兩種潮汐都不通】)",
  files: ['data/edges.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/edges.json')
    d.find((e) => e.requiresTide).requiresTide = 'ebbing'
    writeJson('data/edges.json', d)
  },
})
selfTest({
  gate: '連通', name: '一個節點只剩 learned 邊連著它（實際上永遠進不去）',
  files: ['data/edges.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/edges.json')
    for (const e of d) if (e.a === 'bh:cathedral' || e.b === 'bh:cathedral') e.knowledge = 'learned'
    writeJson('data/edges.json', d)
  },
})

// ══════════════ live-reach：靜態分析【原理上】抓不到的五種形狀 ══════════════
//
// ★ 這五個案例是對抗式稽核裡「靜態閘全部放行」的那幾種。它們的共同點是
//   問題不在任何單一資料列，而在整張圖的連通性——所以逐案補規則永遠補不完，
//   只有行為式的不動點閉包抓得到。
const LR = 'live-reach.ts'
selfTest({
  gate: 'live-reach', name: '★ 地理雞生蛋：教 X 的事件在一個必須先走 X 才到得了的節點',
  script: LR, files: ['data/events.json', 'data/edges.json'],
  mutate: ({ readJson, writeJson }) => {
    // 讓大聖堂只能經崖上崖下小徑（learned）進入，而教那條路的事件搬到大聖堂
    const ed = readJson('data/edges.json')
    for (const e of ed) {
      if (e.id === 'e:market-cathedral-steps') e.knowledge = 'learned'
    }
    writeJson('data/edges.json', ed)
    const ev = readJson('data/events.json')
    ev.find((x) => x.id === 'ev-learn-cliffpath').where = { at: 'bh:cathedral' }
    writeJson('data/events.json', ev)
  },
})
selfTest({
  gate: 'live-reach', name: '★ 兩條 learned 邊互鎖（A 教 B、B 教 A，兩條都學不到）',
  script: LR, files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const ev = readJson('data/events.json')
    // 魚巷的教學事件改成要先知道石階；石階的教學事件改成要先知道魚巷
    ev.find((x) => x.id === 'ev-learn-fishlane').requires = {
      all: [{ knowsRoute: 'e:quays-grotto-stair' }, { not: { knowsRoute: 'e:alley-quays-fishlane' } }],
    }
    ev.find((x) => x.id === 'ev-learn-grotto-stair').requires = {
      all: [{ knowsRoute: 'e:alley-quays-fishlane' }, { not: { knowsRoute: 'e:quays-grotto-stair' } }],
    }
    writeJson('data/events.json', ev)
  },
})
selfTest({
  gate: 'live-reach', name: '★ 事件的條件在物理上不可能（npc 三軸上限是 100）',
  script: LR, files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const ev = readJson('data/events.json')
    ev[10].requires = { npc: { id: 'npc-quays-foreman', axis: 'trust', is: '>=200' } }
    writeJson('data/events.json', ev)
  },
})
selfTest({
  gate: 'live-reach', name: '★ 一個選項的 requires 在任何狀態下都不成立',
  script: LR, files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const ev = readJson('data/events.json')
    ev[12].choices[0].requires = { npcCount: { axis: 'trust', is: '>=99', atLeast: 99 } }
    writeJson('data/events.json', ev)
  },
})
selfTest({
  gate: 'live-reach', name: '★ 一個物品在任何地方都取得不到（不賣、無 gain、非開場物）',
  script: LR, files: ['data/nodes.json'],
  mutate: ({ readJson, writeJson }) => {
    // ★ 必須挑一個【只靠販售】取得的物品。
    //   第一版挑了 item-local-clothes，而它有 gain.item 兜著（里程碑事件會給），
    //   於是把它從 sells 移除【不是】一個違規——閘門放行是正確的。
    //   私煉灰膏只在灰棚巷賣、沒有任何 gain.item，才是這個案例要的形狀。
    const n = readJson('data/nodes.json')
    for (const x of n) x.sells = (x.sells ?? []).filter((i) => i !== 'item-ash-salve')
    writeJson('data/nodes.json', n)
  },
})

// ══════════════ 平衡：沒有人被靜默鎖死在三條結局之外 ══════════════
//
// ★ 這一項不是資料驗證，是【跑分】——所以它比其他案例慢（60 seed 約 8 秒）。
//   值得：它守的是本作唯一一個「既不是死亡、也不是選擇」的失敗狀態。
//   拿掉查籍那一幕的保底入口，實測就有 26/340 局活著卻不可能拿到任何結局。
selfTest({
  gate: '平衡', name: '★★ 拿掉查籍的保底入口 → 有人活著卻不可能拿到任何結局',
  script: 'balance.ts', args: ['60'], files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    const e = d.find((x) => x.id === 'ev-guard-census')
    const inner = e.requires.all[0].all
    const i = inner.findIndex((c) => c.any)
    inner[i] = { flag: 'saw-dross' } // 退回只有一個入口的舊版
    writeJson('data/events.json', d)
  },
})

selfTest({
  gate: '平衡', name: '★★ 一份工作的門檻高到沒有人上得了（宣告與程式一致，只有跑分看得見）',
  script: 'balance.ts', args: ['60'], files: ['data/jobs.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/jobs.json')
    const j = d.find((x) => x.id === 'job-yards-ropewalk')
    // 熟識上限是 100，>=100 幾乎不可能達到 —— 這正是它 0.4% 時的形狀
    j.requires.all.find((c) => c.npc).npc.is = '>=100'
    writeJson('data/jobs.json', d)
  },
})

// ══════════════ reach-test 探針：放寬必須只沿事件自己問的那個軸 ══════════════
//
// probeWants() 讓探針在事件要求「缺」的時候跟著變窮／帶傷。
// 這是把量尺放寬，所以必須證明它【沒有順手把真違規也放行】。
selfTest({
  gate: 'reach 探針', name: '★ 條件要求的錢是負數（探針變窮也不該讓它變成可達）',
  script: 'reach-test.ts', files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d.find((e) => e.id === 'ev-orun-share').requires.all.push({ copper: '<0' })
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: 'reach 探針', name: '★ 上工日數要求超過局長度（單調軸給滿也不該蓋掉它）',
  script: 'reach-test.ts', files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    d.find((e) => e.id === 'ev-wage-body').requires.all[0].wageDays = '>=999'
    writeJson('data/events.json', d)
  },
})
selfTest({
  gate: 'reach 探針', name: '★ 要求身上有傷，但探針只在事件自己問的時候才給傷',
  script: 'reach-test.ts', files: ['data/events.json'],
  mutate: ({ readJson, writeJson }) => {
    const d = readJson('data/events.json')
    // 把「要有沒處置的傷」換成一個【探針不會去湊】的不可能條件：
    // 傷的嚴重度上限是 3，要求 minAgeDays 超過局長度即永不成立。
    d.find((e) => e.id === 'ev-dasha-finds').requires.all
      .find((c) => c.injury).injury.minAgeDays = 99
    writeJson('data/events.json', d)
  },
})

// ══════════════ ⑬ 上工判斷只能有一份實作 ══════════════
selfTest({
  gate: '⑬', name: '★★ 讓 reducer 繞過 requires（就是修掉之前的那個形狀）',
  script: 'unit-test.ts',
  files: ['src/engine/reduce.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/reduce.ts')
    const from = "  if (!evaluate(job.requires, c)) return 'requires'"
    if (!t.includes(from)) throw new Error('注入錨點失效：workBlock 的 requires 分支找不到')
    // workBlock 仍然宣告「擋住」，但 reducer 那一側等於沒看——兩條路徑分歧
    writeText('src/engine/reduce.ts', t.replace(
      "      const blocked = workBlock(s, job, idx)",
      "      const blocked = evaluate(job.requires, ctxOf(s, idx)) ? workBlock(s, job, idx) : null"))
  },
})
selfTest({
  gate: '⑬', name: '★ workBlock 少看一條（時段），reducer 照舊 —— 反方向的分歧',
  script: 'unit-test.ts',
  files: ['src/engine/reduce.ts'],
  mutate: ({ readText, writeText }) => {
    const t = readText('src/engine/reduce.ts')
    const from = "  if (!evaluate({ hours: job.when }, c)) return 'hours'"
    if (!t.includes(from)) throw new Error('注入錨點失效：workBlock 的時段分支找不到')
    writeText('src/engine/reduce.ts', t.replace(from, "  // (injected) " + from.trim()))
  },
})

// ══════════════ 內容漂移（build-data --check 是獨立的一道閘）══════════════
{
  const backup = fs.readFileSync(P('data/events.json'))
  try {
    const d = JSON.parse(backup.toString('utf-8'))
    d[0].weight = d[0].weight + 1 // 只改 data，不改 content → 必須被漂移偵測抓到
    writeJson('data/events.json', d)
    let code = 0
    try {
      execFileSync(process.execPath, [P('scripts/build-data.mjs'), '--check'], { cwd: root, stdio: 'pipe' })
    } catch (e) { code = e.status ?? 1 }
    T('漂移', 'data/ 被直接改動（繞過 content/ 這個 SSOT）', code !== 0,
      code !== 0 ? `exit ${code}` : '★ 漂移偵測【放行】了')
  } finally {
    fs.writeFileSync(P('data/events.json'), backup)
  }
}

// ── 收尾：確認全部還原乾淨 ──
{
  const after = gitStatus()
  if (baseline === null || after === null) {
    T('收尾', '★ 全部注入都已還原', true, 'git 不可用，略過比對')
  } else {
    const base = new Set(baseline.split('\n').filter(Boolean))
    const leaked = after.split('\n').filter(Boolean).filter((l) => !base.has(l))
    T('收尾', '★ 全部注入都已還原（與開始前的基線逐行比對）',
      leaked.length === 0,
      leaked.length === 0 ? '' : `★ 殘留 ${leaked.length} 筆：${leaked.slice(0, 4).join(' / ')}`)
  }
}

// ── 輸出 ──
console.log('=== 無籍者 · 閘門自測（注入真違規 → 閘門必須 exit 1）===\n')
let pass = true
let lastGate = ''
for (const r of results) {
  if (!r.ok) pass = false
  if (r.gate !== lastGate) { console.log(`  ── ${r.gate} ──`); lastGate = r.gate }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  if (r.note) console.log(`        ${r.note}`)
}
console.log(`\n${results.length} 個案例`)
console.log(pass
  ? '\n[PASS] 每一道閘都在注入違規時確實擋下。'
  : '\n[FAIL] ★ 有閘門放行了真違規 —— 那道閘目前是裝飾品。')
process.exit(pass ? 0 : 1)
