# ABRSM 視奏（Sight-Reading）內容分析

本文件是 SightScore 視奏隨機生成器的規則來源分析。目標：把 ABRSM 鋼琴 Grade 1–8 視奏測驗的**可程式化參數**（調性、音域、小節數、節奏、articulation 等）整理成一份可直接轉成 JSON 規則表的規格。

對應的機器可讀規則表：[`src/rules/abrsm-piano-grades.json`](../src/rules/abrsm-piano-grades.json)

---

## 0. 資料來源與可信度標示（重要）

ABRSM 的視奏參數表印在官方 Practical Grades 鋼琴大綱 PDF 的第 16 頁（2025 & 2026 與 2027 & 2028 兩版的視奏要求完全相同，沒有變動）。

**本次無法直接取得該 PDF**：這個工作階段的網路輸出政策封鎖了 `www.abrsm.org`（CONNECT 回傳 403），不是網站問題也不是暫時性錯誤。因此下表的資料來自公開的第三方整理（教師網站、書評、教材說明）與範例集（Specimen / More Piano Sight-Reading）的觀察報告。

每一級都標了可信度：

| 標示 | 意義 |
|---|---|
| ✅ **verified** | 多個獨立來源說法一致，可直接用 |
| ⚠️ **partial** | 主要參數（調、拍號、新元素）有佐證，但小節數／音域為推估 |
| ❗ **inferred** | 依級數演進趨勢與範例集觀察推得，**上線前必須用官方大綱 p.16 核對** |

Grade 1–4 為 ✅、Grade 5 為 ⚠️、Grade 6–8 為 ❗。實務建議：先用這份規則表把生成器做起來（參數都在 JSON 裡，改一個數字即可），等你手上有官方 PDF 或範例集，再把 Grade 6–8 校準一次。

---

## 1. 測驗框架（所有級數共通）

| 項目 | 內容 |
|---|---|
| 形式 | 未曾看過的短曲，鋼琴為**大譜表（兩行五線譜，高音＋低音譜號）** |
| 準備時間 | **30 秒**（可試彈全部或任一部分） |
| 配分 | **21 / 150 分**（14%），與音階琶音同分量 |
| 及格線 | 100（Merit 120、Distinction 130） |
| 評分向度 | 音高正確、節奏正確、**連貫性/流暢度**、音樂細節（力度、articulation、性格） |
| 參數累積性 | 參數表是**累加的**：某元素在 Grade N 出現後，Grade N+1 以上都可能出現 |

> **對 UI 的意涵**：倒數計時預設 30 秒；計時結束後才允許播放/評分。「連貫性」是評分重點，代表 App 若要模擬考試，應鼓勵「不停頓地彈完」而不是重來。

---

## 2. Grade 1–8 參數總表

以下為橫向比較（累積制，每格只列**該級新增**者，未列者沿用前級）。

### 2.1 調性範圍

| Grade | 大調 | 小調 | 最多升降記號 |
|---|---|---|---|
| 1 ✅ | C, G, F | a, d | 1 |
| 2 ✅ | ＋D | ＋e, g | 2 |
| 3 ✅ | ＋A, Bb, Eb | ＋b | 3 |
| 4 ✅ | （無新增） | （無新增） | 3 |
| 5 ⚠️ | ＋E, Ab | ＋f#, c（**不含 c# 小調**） | 4 |
| 6 ❗ | ＋B, Db | ＋c#, f | 5 |
| 7 ❗ | ＋F#, Gb | ＋g#, bb | 6 |
| 8 ❗ | 全部大小調 | 全部大小調 | 6（曲中可轉調） |

**生成器注意**：小調的「升高第七級」是調號外的臨時記號，但它**不算**參數表意義下的「chromatic notes」（半音）。也就是說 Grade 1–3 雖然標示不含半音，a 小調的 G♯ 仍然合法。規則表用 `harmony.raisedSeventhInMinor` 與 `harmony.chromaticNotes` 兩個獨立旗標區分這件事。

### 2.2 拍號與長度

| Grade | 拍號 | 長度（小節） |
|---|---|---|
| 1 ✅ | 2/4, 3/4, 4/4 | 2/4 為 **6 小節**；3/4 與 4/4 為 **4 小節** |
| 2 ✅ | 同上 | 4–8 ⚠️ |
| 3 ✅ | ＋3/8 | 最多 8 |
| 4 ✅ | ＋**6/8**（首次出現複拍子） | 6–8 |
| 5 ⚠️ | 同上 | **8–12** |
| 6 ❗ | ＋9/8, 12/8, 2/2；**允許變換拍號（脈動不變）** | 10–14 |
| 7 ❗ | ＋5/4 | 12–16 |
| 8 ❗ | ＋7/8 等不規則拍 | 12–16 |

Grade 1 的「2/4 六小節、3/4 與 4/4 四小節」是少數有明確數字的規格，**總長度大致固定在 12–16 拍**。這個「以總拍數而非小節數為準」的思路值得沿用到高級數：生成器內部用 `totalBeats` 決定長度，再依拍號換算小節數，題目難度才會穩定。

### 2.3 音域與織體

ABRSM 沒有公布明確的 MIDI 音域數字；下表是從範例集觀察歸納的**工程預設值**，可調。

| Grade | 織體 | 右手音域 | 左手音域 | 加線 |
|---|---|---|---|---|
| 1 ✅ | **雙手不同時發聲**（輪流），固定五指位置 | C4–G4 | C3–G3 | 0 |
| 2 ✅ | **雙手同時**，仍在五指位置 | C4–C5 | G2–C4 | 1 |
| 3 ✅ | **離開五指位置**（換把位），兩音和弦 | B3–G5 | F2–C4 | 2 |
| 4 ✅ | 兩手節奏開始獨立 | A3–A5 | D2–D4 | 3 |
| 5 ⚠️ | 四部和弦（**每手最多 2 音**） | G3–C6 | C2–E4 | 3 |
| 6 ❗ | 內聲部、三音和弦 | F3–D6 | A1–F4 | 4 |
| 7 ❗ | 多聲部、**譜號變換** | D3–E6 | G1–G4 | 4 |
| 8 ❗ | 完整鋼琴織體、跨譜表 | C3–G6 | E1–A4 | 5 |

**Grade 1 是特例**：雙手輪流、絕不同時，這對生成器的資料結構有直接影響——Grade 1 產生的是「兩段單聲部旋律接力」，Grade 2 以上才是真正的雙聲部對位。建議 Grade 1 走獨立的生成路徑。

### 2.4 節奏變化

| Grade | 音符值 | 新增節奏元素 |
|---|---|---|
| 1 ✅ | 全、附點二分、二分、四分、八分（成對） | — |
| 2 ✅ | ＋附點四分 | **連結線 tie**、附點四分＋八分、弱起拍 |
| 3 ✅ | ＋十六分 | 十六分音型、八分休止符、附點四分休止符 |
| 4 ✅ | ＋附點八分 | **複拍子分組**（6/8 的三個八分一拍） |
| 5 ⚠️ | 同上 | **三連音**、**切分音**（簡單） |
| 6 ❗ | 同上 | 變換拍號、簡單的 2 對 3 |
| 7 ❗ | ＋三十二分 | 裝飾音、2 對 3 交錯節奏、二連音 |
| 8 ❗ | 同上 | 五連音/六連音、3 對 4 |

**節奏生成的關鍵設計**：不要逐一隨機挑音符值再湊滿一小節（會產生 ABRSM 不會寫的怪節奏）。正確做法是**節奏細胞庫（rhythm cell library）**——每個拍子（beat）從該級允許的細胞清單裡抽，例如 4/4 一拍可以是 `[♩]`、`[♪♪]`、`[♬♬]`、`[♩. ♪]`（跨兩拍）。這樣天然保證：
- 小節總長一定正確
- 八分音符成對出現、beam 分組符合記譜慣例
- 附點與切分只在該級允許時才進入細胞庫

### 2.5 力度（Dynamics）

| Grade | 新增 |
|---|---|
| 1 ✅ | p, mp, mf, f；cresc. / dim.（漸強漸弱線） |
| 2 ✅ | **pp** |
| 3 ✅ | ff |
| 4 ✅ | （無新增） |
| 5 ⚠️ | sf |
| 6 ❗ | fp |
| 7 ❗ | ppp, sfz |
| 8 ❗ | fff |

### 2.6 Articulation 與其他記號

| Grade | 新增 articulation / 記號 |
|---|---|
| 1 ✅ | **圓滑線 slur / 樂句線**、**斷奏 staccato**、開頭的速度/性格術語 |
| 2 ✅ | **重音 accent**、連結線 tie |
| 3 ✅ | （articulation 無新增；重點在把位移動與和弦） |
| 4 ✅ | **tenuto**、**延長記號 fermata**、更廣的義大利文術語 |
| 5 ⚠️ | **踏板記號**、結尾 rall. / rit.、a tempo |
| 6 ❗ | staccatissimo、accel.、更長的樂句結構 |
| 7 ❗ | **裝飾音**（acciaccatura 等）、marcato、**譜號變換**、rubato |
| 8 ❗ | 曲中轉調、半音音群、複雜表情變化 |

> 注意：ABRSM 視奏題**每題開頭都有速度/性格術語**（Andante、Allegretto、Con moto…），而且評分會看你是否反映它。生成器應該把 tempo term 當成必填欄位，並且與所選節奏密度相配（不要在 Adagio 底下塞滿十六分音符）。

---

## 3. 從「規則」到「像 ABRSM 的題目」——生成器設計建議

這是分析中最實務的一節。**符合參數表 ≠ 像考題**。純隨機在音階內挑音會產生無調性感、無樂句感的音串，考生練起來沒有遷移效果。建議加上四層約束：

1. **和聲骨架優先**
   先產生一條和弦進行（Grade 1–3 用 I–V–I / I–IV–V–I 這類），再讓旋律在強拍落在和弦音上，弱拍才允許級進的非和弦音。這一步是「聽起來像音樂」的最大單一因素。

2. **旋律輪廓約束**
   - 級進為主（Grade 1 約 75%，逐級遞減到 Grade 8 約 52%）
   - 跳進上限依級數限制（`generatorHints.maxLeapSemitones`）
   - 大跳之後反向級進填補（古典寫作慣例）
   - Grade 1–2 全曲不離開五指位置：先決定位置的最低音，之後所有音都限制在該五音內

3. **樂句結構（motivic repetition）**
   ABRSM 題目幾乎都有「第 1–2 小節的動機，在第 3–4 小節模進或變化重複」的結構。生成器應該先生成 1–2 小節的動機，再用「原樣重複 / 移位模進 / 節奏相同但音高改變」三種操作展開，最後一小節收在主音（配 V–I）。

4. **可讀性後處理**
   - beam 分組依拍號（4/4 以拍為單位、6/8 以三個八分為一組）
   - 臨時記號的顯示規則（同小節內不重複標示）
   - 避免同一小節內大量加線
   - 左右手音域不交叉（低級數）

### 生成流程建議

```
選 Grade → 讀規則表
  → 抽調號 / 拍號 / 小節數（依 totalBeats）
  → 生成和弦進行骨架
  → 每小節從節奏細胞庫抽節奏
  → 依骨架 + 輪廓約束填音高（左右手分別）
  → 套用動機重複 / 模進
  → 加上力度、articulation、tempo term（依該級允許清單）
  → 輸出 MusicXML → OSMD 渲染
```

### MusicXML 產出注意事項（鋼琴大譜表）

- 一個 `<part>`，`<attributes>` 內 `<staves>2</staves>`，兩個 `<clef number="1">G</clef>` / `<clef number="2">F</clef>`
- 每個 `<note>` 要有 `<staff>` 與 `<voice>`；右手 voice 1 / staff 1，左手 voice 2 / staff 2
- 同一小節寫完右手後用 `<backup>` 回到小節開頭再寫左手
- 力度用 `<direction><direction-type><dynamics>`，`placement="below"`（力度置於兩譜表之間時 `<direction>` 掛在 staff 1 並設 `placement="below"`）
- articulation 用 `<notations><articulations><staccato/>`、`<accent/>`、`<tenuto/>`
- 圓滑線 `<slur type="start|stop" number="1">`；連結線需要 `<tie type="start"/>` **和** `<notations><tied type="start"/>` 兩者
- 拍號、調號變更要放在該小節的 `<attributes>` 內
- `<divisions>` 建議設 4（十六分音符 = 1）或 12（能同時表達三連音與十六分音符）；Grade 5 以上有三連音，直接用 12 或 24 比較安全

### 避免重複出題

用「規則參數的正規化雜湊」當題目指紋：把調號、拍號、每小節節奏細胞 ID 序列、音高序列串成字串取 hash，存進 `localStorage` 的環狀緩衝（例如最近 50 題）。生成時若撞到既有 hash 就重抽。比起存整份 MusicXML 省空間，也能偵測「只有力度不同、音符完全一樣」的實質重複。

---

## 4. 尚待確認的項目（建議下一步）

需要拿到官方大綱 p.16 表格才能定案的部分：

1. **Grade 6–8 的調性上限**——目前是依演進推估（5/6/6 個升降記號）
2. **Grade 5–8 的小節數**——只有 Grade 1 有確定數字，其餘為推估
3. **Grade 6 變換拍號的具體允許組合**——已確認「脈動不變」這個限制，但未確認允許哪些拍號對
4. **Grade 7 裝飾音的種類範圍**——是否只有 acciaccatura，或含 mordent / turn
5. **各級的實際音域上下限**——ABRSM 可能根本沒有明文規定，若如此，就以範例集統計值為準

取得 PDF 的可行途徑：本機（非本工作階段）下載官方 PDF，或直接翻 *Piano Specimen Sight-Reading Tests* / *More Piano Sight-Reading* 各級書前的說明頁。

---

## 5. 適用範圍說明

本分析針對 **ABRSM 鋼琴（Piano）Practical Grades**。ABRSM 其他樂器（小提琴、長笛、吉他等）的視奏參數表是**各自獨立**的：單旋律樂器只有一行譜、音域依樂器而定、調性進度也不同（例如管樂常見降記號調較早出現）。若之後要擴充樂器，規則表的 schema 已預留 `instrument` 欄位，但 `texture`（雙手、大譜表）相關欄位需要改成樂器無關的形式。

---

## 參考來源

- [ABRSM Sight Reading: What to Expect at Each Grade (1-8) — MasterPiano](https://www.masterpiano.com/sight-reading/abrsm-guide)
- [Sight-Reading ABRSM — Piano & Theory Lessons](https://www.pianoandtheory.co.nz/resources-page/2020/3/30/abrsm-sight-reading-books)
- [ABRSM and Trinity - Sight Reading Piano Tips — Hampstead Piano Academy](https://hampsteadpianoacademy.com/abrsm-trinity-sight-reading-piano-tips/)
- [Grade 4 & 5 Sight reading - ABRSM — pianolessonsuk](https://pianolessonsuk.co.uk/pianolessonsuk-blog/2017-03-30-grade-4-5-sight-reading-abrsm/)
- [Sight reading tips for Grades 1 and 2 ABRSM — pianolessonsuk](https://pianolessonsuk.co.uk/pianolessonsuk-blog/sight-reading-tips-grades-1-and-2-abrsm/)
- [How to practise piano sight reading at Grade 1 — SightReader](https://sightreader.app/blog/how-to-practise-piano-sight-reading-grade-1)
- [How to practise piano sight reading at Grade 2 — SightReader](https://sightreader.app/blog/how-to-practise-piano-sight-reading-grade-2)
- [Review: ABRSM More Piano Sight-Reading, Grades 1-8 — David Barton Music](https://www.davidbartonmusic.co.uk/review-abrsm-more-piano-sight-reading-grades-1-8/)
- [ABRSM: Sight-reading（官方說明頁）](https://us.abrsm.org/en/our-exams/what-is-a-graded-music-exam/sight-reading/)
- [ABRSM Practical Music Grades: Piano Syllabus 2025 & 2026（官方大綱，本階段無法存取）](https://www.abrsm.org/sites/default/files/2024-06/Piano%202025%20&%202026%20Prac%20syllabus%2020240524_access.pdf)
