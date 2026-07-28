# SightScore

視奏（sight-reading）隨機題目生成器。樂譜不掃描、不打譜，而是用規則庫即時生成：
依 Grade 規則隨機組出合法的音符與節奏序列 → 直接輸出 MusicXML 字串 → 交給 OSMD 渲染。

```bash
npm install
npm run serve     # http://localhost:5173
npm test          # 生成器與 MusicXML 的單元測試
npm run sample -- --grade 3 --seed 42 --out test.musicxml
node scripts/smoke.js --screenshot app.png   # 用瀏覽器實際渲染每個級數
```

## 結構

| 路徑 | 說明 |
|---|---|
| [`docs/abrsm-sight-reading-analysis.md`](docs/abrsm-sight-reading-analysis.md) | ABRSM 鋼琴 Grade 1–8 視奏內容分析：調性、音域、小節數、節奏、articulation |
| [`src/rules/abrsm-piano-grades.json`](src/rules/abrsm-piano-grades.json) | Grade 1–8 規則表。改參數只要動這份 |
| `src/generator/theory.js` | 以「音級（diatonic step）」為單位的音高拼寫，確保 d 小調的升七級寫成 C♯ 而不是 D♭ |
| `src/generator/rhythm.js` | 節奏細胞庫。以「拍」為單位抽細胞，小節長度、連桿分組自動正確 |
| `src/generator/harmony.js` | 和弦骨架（開頭 I、結尾 V–I） |
| `src/generator/melody.js` | 音高選擇：和弦音、級進比例、跳進上限、把位限制 |
| `src/generator/musicxml.js` | MusicXML 4.0 大譜表序列化 |
| `src/generator/fingerprint.js` | 題目指紋與出題紀錄，避免短期重複 |
| `src/app/` | 瀏覽器介面：OSMD 渲染、30 秒倒數、Web Audio 播放 |

## 已完成

- Grade 1–8 規則表，每級標註 `confidence`（`verified` / `partial` / `inferred`）
- 生成器：和弦骨架 → 節奏細胞 → 音高約束 → 表情記號
- Grade 1 的雙手輪流、Grade 1–2 的五指把位、G3 以上的把位移動與和弦
- MusicXML 輸出（兩個 staff、beam、tuplet、accidental、slur、dynamics）
- 22 項單元測試 + 瀏覽器 smoke test（八個級數都實際用 OSMD 渲染過）
- UI：選級數、產生新題目、30 秒倒數、播放正確版本、下載 MusicXML、出題紀錄去重

## 待辦

- 音高層級的模進（目前動機重複只做在節奏層）
- 跨小節連結線、G6 以上的變換拍號
- Grade 6–8 參數需以官方大綱核對（見分析文件第 0 節與第 4 節）
