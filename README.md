# SightScore

視奏（sight-reading）隨機題目生成器。樂譜不掃描、不打譜，而是用規則庫即時生成：
依 Grade 規則隨機組出合法的音符與節奏序列 → 直接輸出 MusicXML 字串 → 交給 OSMD 渲染。

## 目前內容

| 檔案 | 說明 |
|---|---|
| [`docs/abrsm-sight-reading-analysis.md`](docs/abrsm-sight-reading-analysis.md) | ABRSM 鋼琴 Grade 1–8 視奏內容分析：調性、音域、小節數、節奏、articulation，以及生成器設計建議 |
| [`src/rules/abrsm-piano-grades.json`](src/rules/abrsm-piano-grades.json) | 機器可讀的 Grade 1–8 規則表，生成器直接讀這份 |

規則表中每一級都有 `confidence` 欄位（`verified` / `partial` / `inferred`），標示該級參數的資料來源強度。
Grade 6–8 目前為推估值，需以官方大綱核對後修正——詳見分析文件第 0 節與第 4 節。

## 下一步

1. 節奏細胞庫與音高生成邏輯（依規則表）
2. MusicXML 序列化（鋼琴大譜表，兩個 staff）
3. UI：選 Grade、產生新題目、30 秒倒數、播放正確版本
4. 已出題目指紋記錄，避免短期重複
