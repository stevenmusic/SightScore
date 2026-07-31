# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Rule-based ABRSM piano sight-reading test generator. It does not scan or hand-engrave scores — it procedurally generates a legal note/rhythm sequence from a per-grade rules table, serializes it straight to a MusicXML string, and renders that with OpenSheetMusicDisplay (OSMD) in the browser. Plain static site: `index.html` + `src/`, deployed as-is to GitHub Pages — no build step, no framework, no bundler.

The UI (`index.html`, user-facing strings in `src/app/app.js`) is in Traditional Chinese; code, comments and identifiers are English. `README.md` (also Chinese) has the architecture rundown this file summarizes for Claude.

## Commands

```bash
npm install
npm test                                                     # generator + MusicXML unit tests (node --test)
npm run serve                                                # local static server, http://localhost:5173
npm run sample -- --grade 3 --seed 42 --out test.musicxml   # print/save one generated test as MusicXML
npm run devices                                              # Playwright layout/behaviour check across 5 device sizes
npm run smoke                                                # Playwright render check across all 8 grades
npm run smoke -- --grade 3 --screenshot app.png              # smoke test a single grade, with a screenshot
```

Single test file: `node --test test/generator.test.js` (or `musicxml.test.js`, `notation.test.js`). `node --test` also supports `--test-name-pattern <regex>` to filter by test name.

## Architecture

### Generation pipeline

`generateTest(rulesTable, {grade, seed}) → score object → toMusicXml(score) → MusicXML string → OSMD renders it`

Entry point `src/generator/generate.js`; public surface re-exported from `src/generator/index.js`. All randomness runs through `random.js`'s seeded mulberry32 PRNG (`createRandom(seed)`) — every generation decision is a pure function of that one seed, so the same seed always reproduces the same test (`npm run sample -- --seed N`, and unit tests, rely on this). The UI and `fingerprint.js`'s `generateUnique` never pass a seed, so each call gets a fresh `randomSeed()`; dedup against recent history happens by retrying generation, not by choosing a seed. Order of generation (see `docs/abrsm-sight-reading-analysis.md §3`):

1. Pick key, time signature and bar count from `src/rules/abrsm-piano-grades.json` for the grade.
2. Build a harmonic skeleton (`harmony.js`): opens on I, cadences V–I, normally one chord per bar but occasionally two (see "Two chords in one bar" below).
3. **Left hand is written first**: bars of rhythm cells (`rhythm.js`) with pitches assigned against the chord progression (`melody.js`'s `assignPitches`). Its notes become a sounding-bass timeline (`soundingTimeline`).
4. **Right hand is written second**, checked note-by-note against what the left hand is sounding at that same instant — clashing vertical intervals are rejected or repaired during pitch selection, not patched after the fact.
5. `harmoniseLeadingNotes` reconciles minor-key leading-tone raises between the two hands (a cross-hand disagreement is a "false relation"). `harmoniseRepeatedLeadingNotes` catches the same problem *within* one hand: a clash repair flips only the clashing note's raised 7th to natural, which can leave an immediately-repeated note disagreeing with itself. Both run once per hand inside `assignPitches` and once more in `generate.js` after the cross-hand pass, since each repair can reintroduce the other's problem. `harmoniseLeadingNotes` iterates to a fixed point (not a single pass) — fixing one cross-hand pair can break agreement with a third overlapping note, so it loops until nothing changes.
   - **Minor keys are written as harmonic minor unconditionally**: the 7th degree raises wherever it occurs (`degreeOf(dstep, key) === 6`), not just under a dominant-function chord the way it used to. `pickWeighted`'s clash-screening must agree: it screens degree-7 candidates at their *raised* pitch (`soundingMidi` helper), not the natural one, or it'll happily pick a candidate that only clashes once raised and let `resolveClashes` silently un-raise it back to natural.
6. `applyExpression` adds dynamics, wedges, slurs, staccato and rall. within what the grade's rules allow — and, from Grade 6, sustain-pedal spans, a mid-piece rit./a tempo, and (Grade 7+) grace-note ornaments; see "Grade 6-8 extras" below.
7. `toMusicXml` (`musicxml.js`) serializes the score to MusicXML 4.0: one `<part>`, two staves, staff 2 reached via `<backup>`.

Key data structures/conventions to know before touching the generator:

- **dstep (diatonic step)**: pitches are generated in diatonic-step space, not MIDI (`theory.js`: `dstep = 7*octave + letterIndex`), so spelling is correct by construction — e.g. the raised 7th in D minor always comes out as C#, never Db.
- **score object**: `{seed, grade, confidence, key, timeSignature, barCount, divisions, tempoTerm, tempoBpm, progression, staves: {1: rightHandBars, 2: leftHandBars}}`. Each bar is `{events, beatDuration, directions}`; each event carries `dur`, `type`, `rest`, and — if pitched — `pitch`/`dstep`/`chordDegrees`, plus optionally `grace`. `progression[barIndex]` is normally a plain roman numeral, but for a split bar (see "Two chords in one bar") it's a `[first, second]` pair — code reading `score.progression` directly, rather than through `harmony.js`'s `firstChord`/`lastChord`/`chordAt`, needs to handle both shapes or a split bar compares as "always different" from its neighbours (array `!==` string is always true).
- **rhythm cells** (`rhythm.js`): whole-beat idiomatic figures from a fixed library, not built note-by-note, so bars always sum correctly and beaming/dots/tuplets only appear once a grade's rules permit them. `meter.js` rescales the library for other beat units and swaps in a separate cell set for compound time (x/8).
- **rhythmic repetition** (`generate.js`'s `buildStaff`) differs by hand role. A real accompaniment (Grade 2-3's left hand once hands sound together, `isAccompaniment`) draws one rhythm (`ostinato`) and reuses it for every bar. The melodic hand instead gets an occasional *phrase echo* — restating whichever regular bar most recently played at the same position two bars back (`bank[barIndex % 2]`, refreshed on every regular bar, not frozen at the first two — freezing it made every later phrase echo bars 1-2 specifically, reading as far more repetitive than a real test).
- **fingerprinting** (`fingerprint.js`): hashes musical content (key, metre, bar count, every pitch/duration), not the MusicXML text, so two renders differing only in dynamics still dedup as the same test (`generateUnique` + the browser's localStorage history).
- **`pickWeighted` (`melody.js`) picks a move category before a pitch**: step vs. leap vs. repeat is weighted first (via `generatorHints.stepwiseBiasPercent`), then a candidate is picked within that category — scoring every candidate on one shared scale let `stepwiseBias` mean nothing, since leap candidates usually outnumber the two step candidates. A passing/neighbour tone's resolution (continuing in its approach direction) is *forced* when a non-clashing option exists, or `repairNonChordTones` would later silently turn an intended stepwise pair into two leaps.
- **Run-continuation bias** (`runDirection`/`runLength` in `melody.js`): `pickWeighted` tracks how long the current same-direction step run is and grows the weight of continuing it (capped, tapering off), so scale-run figures read as real runs instead of independently-scored single steps. Layered on top of every other constraint — clash avoidance, range, chord-tone-only for the bass — not a bypass of them.

### Grade 6-8 extras

Grade 6-8 tests do **not** print a piece title above the tempo/character word (an earlier `TITLES`-pool design was dropped per request) — the heading is just the tempo/character word, same as every other grade.

`applyExpression` implements the rules table's long-documented-but-unbuilt pedal/ornament/tempo-change features: `addPedalMarking` (gated on the rules table mentioning pedal — English "pedal" at Grade 5, Chinese "踏板" at Grade 6-8, gate checks both), `addMidPieceTempoChange` (rit./a tempo pair around the halfway bar, `grade >= 6`), and `addOrnaments` (step-wise acciaccatura on 1-2 melody notes, `grade >= 7`). A grace note is `event.grace = {pitch}` on the note it decorates, not a separate event — MusicXML forbids `<duration>` on a grace note, so `musicxml.js`'s `renderGraceNote` emits it as its own `<note><grace slash="yes"/>...</note>` immediately before the main note.

`addPedalMarking` places a bracket pedal line over a 2-4 bar span. A plain start/stop pair would hold straight through whatever chord changes happen underneath, smearing unrelated harmonies together — no real pedalling does that. It walks the span and drops a `<pedal type="change"/>` (lift-and-immediately-redepress notch) at every bar where the sounding chord actually changes, including *inside* a split bar (see below), using a plain `stop` only at the very end.

### Two chords in one bar

`buildProgression` (`harmony.js`) can split a middle bar (never the opening I or the V–I cadence) into two chords occupying even halves of the bar, gated by `twoChordBarChance` (`generate.js` passes `grade >= 5 ? 0.3 : 0`). A split entry is `[first, second]` instead of a plain roman numeral; `firstChord`/`lastChord` unwrap either shape to the chord at the bar's start/end, and `chordAt(entry, offset, barDuration)` returns whichever half sounds at a given offset — `melody.js`'s `assignPitches`/`stackChordTones` call it once per event (not once per bar). `addPedalMarking` uses `firstChord`/`lastChord` for bar-boundary comparisons, and `addMidBarPedalChange` drops a `change` mark partway through any split bar in the pedal's span, at the first event starting at/after the bar's halfway point. That mark can't go at the front of `bar.directions` like every other direction — it has to land between two specific notes — so directions gained an `atEventIndex` field (default 0), and `musicxml.js`'s `renderBar` interleaves each direction immediately before the note at that index as it walks the bar.

### Rules table is the single source of truth

`src/rules/abrsm-piano-grades.json` drives every grade-specific parameter: keys, time signatures, bar-count ranges, rhythm vocabulary, hand range/tessitura, texture (five-finger position, hands-together, chord stacking), dynamics, articulations, tempo terms. Each grade carries a `confidence` marker (`verified`/`partial`/`inferred`), surfaced to the user in the UI whenever it isn't `verified`. Changing generation behavior for a specific grade should almost always mean editing this JSON rather than the generator code. `docs/abrsm-sight-reading-analysis.md` and `docs/abrsm-sight-reading-knowledge-base.md` are the source analysis behind the table's numbers.

### Frontend (`src/app/`)

- `app.js` — orchestrates everything: loads the rules JSON, initializes OSMD, wires the generate/prepare/play/stop buttons, runs the 30-second preparation countdown, and auto-fits layout (`fitScore`). `fitScore` searches bars-per-line counts from `MAX_MEASURES_PER_LINE` (4) down to 2, taking the first (most compact) count that still renders at `zoom >= MIN_ZOOM` with no line stranding a single bar, falling back to the natural wrap if none qualify — this prefers more bars per line over larger zoom, since a short/simple test could otherwise render conspicuously oversized at 1-2 bars/line. The `resize` listener that triggers `fitScore` filters to actual width changes only — mobile Safari fires `resize` on address-bar show/hide during ordinary scrolling (only `innerHeight` changes), and refitting on that reset scroll position.
- `stage.js` — reading-stage geometry. Reads bar/system bounding boxes directly out of the rendered SVG (`g.vf-measure`, `g.staffline`) rather than OSMD's internal graphic model, and drives the playback highlight box, moving playhead, and auto-scroll-to-system.
- `playback.js` — reference audio playback matching a sibling app's ("ScrollScore") audio chain: real Salamander piano samples, pitch-shifted to the nearest recorded note → gain envelope → stereo pan by pitch → reverb send (synthesized IR) → limiter → output. Falls back to a synthesized oscillator tone if the samples can't be fetched.

The whole test always renders in normal page flow, no cropped follow-window. The `#fullscreen` toggle (`app.js`'s `enterFullscreen`/`exitFullscreen`) puts the *entire page* into the Fullscreen API on `<html>`, not just the score frame; browsers with no `Element.requestFullscreen` fall back to a `.pseudo-fullscreen` CSS class with the same effect.

The title and transport controls share one row, `<header class="topbar">` wrapping `.title-block` (just the `h1`, no tagline) and `.controls` (generate/prepare/play/stop/fullscreen) side by side — title left, controls right, `justify-content: space-between`, identical markup/CSS in both normal and fullscreen mode. Fullscreen only hides text this view has no room for (footer, message, checklist) and compacts the status strip; it never touches `.topbar`'s own layout, so the row's position is identical in both modes by construction. `scripts/devices.js` asserts this — it captures `.controls`' bounding box before/after entering fullscreen and fails if its edges moved.

`.topbar` and `.score-frame` are styled after ScrollScore directly: no rounded corners, no drop shadow, no card border — `.topbar` is a flat full-width band with only a `border-bottom` hairline, `.score-frame` has no border/background of its own. Both bleed past the page's horizontal inset to the true viewport edge via a negative margin that cancels `--body-px` (a CSS variable holding the current inset, redeclared per breakpoint) — `margin-inline: calc(-1 * var(--body-px))` plus their own `padding-inline: var(--body-px)` restores a normal inset for content while the band/background reaches edge to edge. `body` has zero top padding — `.topbar` must sit flush against the viewport's actual top edge to match ScrollScore's toolbar.

The grade selector (`#grade`) is not in `.controls` — it's absolutely positioned at the top-left of `.score-frame` (`.grade-select`), reading as "what to generate onto this paper" rather than a playback control. `.score-frame` carries extra top padding to leave room for it without overlapping the first system.

The `#message` element (status/error text from `say()`/`fail()`) has no placeholder text — it's empty until the first real status is set. The local-history counter (`#history-info`, `app.js`'s `updateHistoryInfo`) lives outside the footer entirely, `position: fixed` to the viewport's bottom-left corner (`.history-badge`) rather than the footer's normal flow — on a short page the in-flow footer sits nowhere near the bottom of the screen, so pinning it is what actually reads as "bottom-left of the screen." Text is `已紀錄N題`. Hidden in fullscreen alongside footer/message/checklist.

The meta strip (`#meta`, `app.js`'s `showMeta`) has no labels — key, time signature, bar count and tempo print as plain values in a fixed order, separated by "丨" (e.g. `C 小調丨3/4丨12 小節丨Andantino leggiero (♩≈88)`). The first three fields each get a fixed CSS width (`.meta-key`/`.meta-time`/`.meta-bars`, sized above the widest possible string for that field) so the "丨" separators never shift position; only tempo is allowed to vary and shrink/ellipsize on a narrow phone. `scripts/devices.js` asserts every separator's on-screen position stays fixed across regenerations. Tempo must be the *only* shrink/clip boundary in the row — giving both the outer strip and the tempo span their own independent clip boundary broke the ellipsis (text got clipped by the outer, narrower boundary before the inner ellipsis could render).

## Conventions

- No build step, no bundler. `vendor/opensheetmusicdisplay.min.js` is committed directly (not `node_modules/`, which is never deployed) — see `vendor/README.md` before touching it.
- The rules table (`src/rules/abrsm-piano-grades.json`) is the single source of truth for per-grade parameters. Grade 6–8 numbers are `inferred` and need checking against the official ABRSM syllabus if it ever becomes reachable.
- `www.abrsm.org` and the piano sample host (`tonejs.github.io`) are blocked by this environment's egress policy — cannot be fetched directly from a session in this environment.
- Two hands are never generated independently — the left hand is written first and the right hand is checked against it (see `src/generator/melody.js`), or dissonant intervals fall out of two separate random walks.
- Any change to the follow-view (`src/app/stage.js`) or fullscreen behaviour should be re-verified with `npm run devices`, not just visually — several past bugs there only showed up in a real headless-browser trace.
- Tests (`test/*.test.js`) use `node --test` directly with no test-framework dependency; `test/helpers.js` holds the shared duration/XML-well-formedness assertions used across all three suites.

## Custom commands

This repo has project-level slash commands under `.claude/commands/`, used for the day-to-day workflow on this codebase:

| Command | Use for |
|---|---|
| `/architecture` | Planning or auditing feature layering, folder structure, dependency direction |
| `/code-review` | Reviewing the current diff: security, clean code, performance, readability, architectural fit |
| `/debug` | Root-cause debugging — multiple hypotheses, evidence-gathering, not guess-and-check |
| `/refactor` | SOLID/DRY/KISS refactors that preserve behavior |
| `/testing` | Setting up or extending unit/integration/Playwright tests |
| `/documentation` | Syncing README/API docs/changelog to the current code |
| `/session-closing` | End-of-session handoff: update this file, TODO.md, progress notes, produce Resume.md |
