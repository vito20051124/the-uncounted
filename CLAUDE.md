# CLAUDE.md — `game/`《無籍者》The Uncounted

> 本檔為 `game/` 目錄的專屬指示，**疊加**在 repo 根目錄 `CLAUDE.md` 之上。兩者衝突時以根目錄者為準（世界法優先於遊戲法）。

## 這是什麼

`game/` 是一款以《瑟瑞恩 Serein》世界觀為基底的**生存沙盒文字遊戲**，工作名 **《無籍者》The Uncounted**。

> 一個現代女性在半夜下樓買宵夜，回程遇上元血之世遺物誤觸發，被扔進鹵港的一條巷子，身上只有出門時帶的三樣東西。她不會魔法、治不好傷、不被任何政體登記。

**參照對象是 Degrees of Lewdity 的「架構」，不是它的內容。** 三條刻意的反向設計已寫進 `design/00_pillars.md`：
1. **弧線相反**——DoL 是下墜，本作是往上爬（馬斯洛五層需求為進程脊椎）
2. **性是點綴不是骨架**——不存在環境性的性暴力；性內容全部移除後遊戲仍須完整可玩
3. **地圖是有代價的網不是可以點的圖**——有向圖＋路段屬性＋知識模型

## 鐵律（每次動 `game/**` 都適用）

1. **世界法優先。** `canon/00–07` 是憲法，`registries/` 是一致性基準。**遊戲不得為了方便而改動世界設定**——要改就走 world-forge 流程正式改 canon，由 Claude 執筆。
2. **`design/00_pillars.md` 是遊戲側憲法**，其下所有設計不得牴觸。新增設計前先讀它的「一句話測試」三問。
3. **`canon/07_the_outsider.md` 是本作的地基**，尤其：
   - 主角 **0 靈聾／閉血**，永遠不能施法、**永遠不能被 `光耀+淨` 治癒**、只能購買不能生產魔法
   - **不可逆**：全境 0 名樞階，回家沒有可行路徑，禁止寫出伏筆
   - 外來之物**不授予任何超凡能力**，電量**嚴格單調遞減且永不回升**
   - **禁止技術躍進**（她是一個人，不是一條供應鏈）
   - **禁止出現第二名活著的現代來客**
4. **SSOT 仍是 markdown。** 地點、人物、物價、階制、生物一律引用 `world/**` 與 `registries/`，**不得在 `game/` 內另立一套平行設定**。遊戲資料只存「遊戲才需要的東西」（數值、排程、事件），世界事實一律引用既有 id。
5. **內容即資料。** 事件、工作、物品、對話寫成 `data/` 下的 YAML，由引擎解譯。**禁止把敘事文本與邏輯纏在程式碼裡**——這正是 DoL 最大的維護債。
6. **繁體中文**，禁簡體字；貨幣 **1 金帝 ＝ 240 銅**（非十進）；族名 **寂裔 the Hollowborn**。

## 目錄結構

```
game/
├── CLAUDE.md              # 本檔
├── design/                # 設計文件（Claude 執筆，等同遊戲側 canon）
│   ├── 00_pillars.md      # ★ 遊戲憲法，最先讀
│   └── 01_architecture.md # 系統架構總覽
├── data/                  # 遊戲內容（YAML）：事件/工作/物品/路網/NPC 排程
├── src/                   # 引擎（TypeScript）
├── art/                   # 美術資產與風格規格
└── _generation/           # 內容生產流水線（briefs / outbox / reviews），比照 world-forge
```

## 內容生產流水線

沿用已驗證的 world-forge 六步循環，但寫的是遊戲內容而非世界條目：

**Claude 定向（寫 GBRIEF）→ 生成 → Claude 審核 → 整合 → 更新資料 → loop**

- BRIEF 放 `game/_generation/briefs/GBRIEF-<NNN-slug>.md`
- 審核依 `.claude/skills/world-forge/references/review-rubric.md` 的**九項＋機械驗算五查**，另加遊戲側三問（見 `design/00_pillars.md` 結尾）
- **遊戲內容多一項世界條目沒有的驗收：可玩性。** 審核擋得住矛盾，擋不住無聊——**新事件必須實際跑過一次**

## 技術決策（已定案，勿回退）

- **不使用 Twine／SugarCube。** 使用者要「優化 DoL」，而 DoL 的維護問題**就是** Twine 的架構問題（上千個全域 `$變數`、文本與邏輯纏繞、存檔臃腫、無法測試、在地化須 fork）。
- **TypeScript ＋ 內容即資料 ＋ 具型別具 schema 的狀態**，存檔須有版本與 migration（存檔相容是 DoL 的慢性病）。
- **全離線、無 CDN**，比照 `codex/` 的既有紀律：重型前端函式庫由 Claude 親自 vendored。
- **可重用 `codex/server/loader.js` 的解析邏輯**讀取同一份 markdown SSOT。

## 美術（v1 範圍已定案）

- **做**：場景圖（約 50–150 張）、NPC 立繪（一人一張＋2–3 表情）、物品圖示、關鍵劇情插圖、UI 材質
- **不做**：分層紙娃娃。AI 生圖在結構上無法產出可疊合、對位一致、跨上萬組合保持身分一致的圖層。
- 風格一致性須寫成 `art/style-spec.md`（prompt ＋ 模型/LoRA ＋ seed 政策），比照 `naming_conventions.md` 的紀律
- **圖片會是專案體積大頭**，須先訂體積預算

## Windows／PowerShell 陷阱（承襲根目錄，勿回退）

- 腳本保持**純 ASCII**、以 `$PSScriptRoot` 反推路徑（PowerShell 5.1 會把 UTF-8-無-BOM 檔當 ANSI 解碼而弄亂 CJK 路徑）
- **Node 讀寫 markdown／YAML 一律指定 UTF-8**（繁中 UTF-8-無-BOM）
- PowerShell here-string `@"..."@` 中**反引號是逸出字元**（`` `f ``→formfeed、`` `t ``→tab），寫入含反引號的 markdown 請改用 Node 腳本或單引號 here-string
- 啟動本地服務前先 `Get-Process node | Stop-Process` 避免佔埠連到過期版本

## 內容界線

本作為成人向生存遊戲，但**露骨性描寫不由 Claude 產出**。Claude 負責引擎、系統、世界整合、敘事、角色、關係、以及非露骨的成人主題；涉及未成年或非合意的性內容一律不產出。此界線不影響架構與其餘所有內容的協作。
