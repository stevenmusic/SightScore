# SightScore

視奏（sight-reading）隨機題目生成器。樂譜不掃描、不打譜，而是用規則庫即時生成：
依 Grade 規則隨機組出合法的音符與節奏序列 → 直接輸出 MusicXML 字串 → 交給 OSMD 渲染。

```bash
npm install
npm run serve     # http://localhost:5173
npm test          # 生成器與 MusicXML 的單元測試
npm run sample -- --grade 3 --seed 42 --out test.musicxml
npm run audit     # 蒙地卡羅：每級大量生成，檢查和聲／節奏／旋律／織體的分布
node scripts/smoke.js --screenshot app.png   # 用瀏覽器實際渲染每個級數
```

## 部署（GitHub Pages）

網站是**純靜態**的，沒有 build step：OSMD 已經放進 `vendor/`（見 [`vendor/README.md`](vendor/README.md)），
`node_modules/` 不需要、也不該進版控。

Pages 只要指向含有 `index.html` 的分支根目錄即可。注意兩件事：

1. **Pages 服務的分支必須有 `index.html`。** 若分支上只有 `README.md`，Pages 會改用 Jekyll 把 README
   渲染成一個標題加一條底線的頁面 —— 看起來就像「一片空白」。
2. 倉庫根目錄有 `.nojekyll`，讓 Pages 直接原樣提供檔案，不經過 Jekyll 處理。

## 結構

| 路徑 | 說明 |
|---|---|
| [`docs/abrsm-sight-reading-analysis.md`](docs/abrsm-sight-reading-analysis.md) | ABRSM 鋼琴 Grade 1–8 視奏內容分析：調性、音域、小節數、節奏、articulation |
| [`docs/abrsm-sight-reading-knowledge-base.md`](docs/abrsm-sight-reading-knowledge-base.md) | 視奏知識庫：評分向度、30 秒準備清單、各級語法特徵、記譜合法性規則 |
| [`src/rules/abrsm-piano-grades.json`](src/rules/abrsm-piano-grades.json) | Grade 1–8 規則表。改參數只要動這份 |
| `src/generator/theory.js` | 以「音級（diatonic step）」為單位的音高拼寫，確保 d 小調的升七級寫成 C♯ 而不是 D♭ |
| `src/generator/rhythm.js` | 節奏細胞庫。以「拍」為單位抽細胞，小節長度、連桿分組自動正確 |
| `src/generator/harmony.js` | 和弦骨架（開頭 I、結尾 V–I） |
| `src/generator/melody.js` | 音高選擇：和弦音、級進比例、跳進上限、把位限制 |
| `src/generator/musicxml.js` | MusicXML 4.0 大譜表序列化 |
| `src/generator/fingerprint.js` | 題目指紋與出題紀錄，避免短期重複 |
| `src/app/` | 瀏覽器介面：OSMD 渲染、30 秒倒數、取樣鋼琴播放 |
| `src/app/stage.js` | 播放跟譜：小節色塊、播放軸、兩行捲動視窗、全螢幕 |

## 已完成

- Grade 1–8 規則表，每級標註 `confidence`（`verified` / `partial` / `inferred`）
- 生成器：和弦骨架 → 節奏細胞 → 音高約束 → 表情記號
- **樂句結構**：前後樂句（period）、中間的半終止、後樂句重述前樂句開頭
- **旋律模進**：動機重複同時做在節奏與音高兩層，移位量取兩小節和弦根音的距離
- **旋律輪廓**：全曲一條拱形（起於中低音、約三分之二處到達高點、再落回終止）
- **終止式**：旋律一律級進進入結束的主音（導音上行或上主音下行）
- Grade 1 的雙手輪流、Grade 1–2 的五指把位、G3 以上的把位移動與和弦
- 各級和弦厚度依 `maxNotesPerChord` / `maxNotesTotal` 產生（G5 起旋律手也有和弦）
- MusicXML 輸出（兩個 staff、beam、tuplet、accidental、slur、dynamics）
- 43 項單元測試 + 瀏覽器 smoke test（八個級數都實際用 OSMD 渲染過）
- UI：選級數、產生新題目、30 秒倒數、播放正確版本、出題紀錄去重

## 待辦

- 跨小節連結線、G6 以上的變換拍號
- Grade 6–8 參數需以官方大綱核對（見分析文件第 0 節與第 4 節）
