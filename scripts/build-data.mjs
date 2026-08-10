/**
 * 內容管線：content/*.yaml（作者手寫，唯一真相來源）→ data/*.json（產物，會提交）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 為什麼要 YAML
 *
 * 事件文本是多行繁中散文。寫在 JSON 裡就是一整行 `"…\n\n…\n\n…"`，
 * 於是【寫的時候要手動轉義、審閱的時候 diff 完全讀不出改了哪一句】。
 * 46 個事件還撐得住，但內容一定會破 100——地基要先打。
 *
 * ★ 我原本反對這件事，理由是「兩個真相來源」，而那個顧慮是真的：
 *   YAML 當來源、JSON 當產物，只要有人直接改 JSON（我自己的修改腳本一直在這麼做），
 *   YAML 就會靜默過期。這個專案反覆被咬的正是這類分歧。
 *
 * ★ 所以這條管線內建【漂移偵測】：`--check` 會重新生成一次並與已提交的 JSON 逐位元比對，
 *   任何差異都讓建置失敗並指名是哪一檔。於是兩者【不可能靜默分歧】——
 *   直接改 JSON 不是「會過期」，是「會紅」。
 * ══════════════════════════════════════════════════════════════════
 *
 * 用法：
 *   node scripts/build-data.mjs          生成 data/*.json
 *   node scripts/build-data.mjs --check  只比對，不寫檔（給 npm run check 用）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', 'content')
const outDir = path.join(here, '..', 'data')

/** 產物的正規形式。★ 只有這一處決定格式，否則漂移偵測會抓到假差異。 */
const render = (obj) => JSON.stringify(obj, null, 2) + '\n'

const checkOnly = process.argv.includes('--check')

if (!fs.existsSync(srcDir)) {
  console.error(`[build-data] 找不到 ${srcDir}——內容來源不存在`)
  process.exit(1)
}

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.yaml')).sort()
if (files.length === 0) {
  console.error('[build-data] content/ 底下沒有任何 .yaml')
  process.exit(1)
}

const drift = []
const wrote = []

for (const f of files) {
  const name = f.replace(/\.yaml$/, '.json')
  const yamlPath = path.join(srcDir, f)
  const jsonPath = path.join(outDir, name)

  let parsed
  try {
    parsed = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'))
  } catch (e) {
    console.error(`[build-data] ${f} 解析失敗：${e.message}`)
    process.exit(1)
  }
  const next = render(parsed)

  if (checkOnly) {
    const cur = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, 'utf-8').replace(/\r\n/g, '\n') : null
    if (cur === null) drift.push(`${name} 不存在（跑 npm run build:data）`)
    else if (cur !== next) {
      // 給出第一處差異的行號，否則「有差異」這句話沒有可行動性
      const a = cur.split('\n'), b = next.split('\n')
      let i = 0
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
      drift.push(`${name} 與 ${f} 不一致（第 ${i + 1} 行起）\n      JSON: ${(a[i] ?? '(檔尾)').trim().slice(0, 90)}\n      YAML: ${(b[i] ?? '(檔尾)').trim().slice(0, 90)}`)
    }
  } else {
    fs.writeFileSync(jsonPath, next, 'utf-8')
    wrote.push(`${f} → ${name}（${Array.isArray(parsed) ? parsed.length + ' 筆' : Object.keys(parsed).length + ' 鍵'}）`)
  }
}

if (checkOnly) {
  if (drift.length > 0) {
    console.log('=== 內容漂移 ===\n')
    console.log('★ data/*.json 是【產物】，來源是 content/*.yaml。下列檔案不一致：\n')
    for (const d of drift) console.log('  x ' + d)
    console.log('\n若你改的是 YAML：跑 `npm run build:data`。')
    console.log('若你（或某個腳本）直接改了 JSON：那個改動會被下一次建置覆蓋，')
    console.log('請把它搬到 content/*.yaml 去。')
    process.exit(1)
  }
  console.log(`[PASS] 內容無漂移（${files.length} 份 YAML 與 data/ 一致）`)
} else {
  console.log('=== 內容建置 ===')
  for (const w of wrote) console.log('  ' + w)
  console.log(`\n[PASS] 已生成 ${wrote.length} 份 JSON。`)
}
