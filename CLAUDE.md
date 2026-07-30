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

Entry point `src/generator/generate.js`. Order of generation (see `docs/abrsm-sight-reading-analysis.md §3`):

1. Pick key, time signature and bar count from `src/rules/abrsm-piano-grades.json` for the grade.
2. Build a one-chord-per-bar harmonic skeleton (`harmony.js`): opens on I, cadences V–I.
3. **Left hand is written first**: bars of rhythm cells (`rhythm.js`) with pitches assigned against the chord progression (`melody.js`'s `assignPitches`). Its notes become a sounding-bass timeline (`soundingTimeline`).
4. **Right hand is written second**, checked note-by-note against what the left hand is sounding at that same instant (the `against` timeline) — clashing vertical intervals are rejected or repaired during pitch selection, not patched after the fact.
5. `harmoniseLeadingNotes` reconciles minor-key leading-tone raises between the two hands (disagreement there is a "false relation," the harshest thing the generator can produce).
6. `applyExpression` adds dynamics, wedges, slurs, staccato and rall. within what the grade's rules allow — and, from Grade 6, sustain-pedal spans, a mid-piece rit./a tempo, and (Grade 7+) grace-note ornaments; see "Grade 6-8 extras" below.
7. `toMusicXml` (`musicxml.js`) serializes the score to MusicXML 4.0: one `<part>`, two staves, staff 2 reached via `<backup>`.

Key data structures/conventions to know before touching the generator:

- **dstep (diatonic step)**: pitches are generated in diatonic-step space, not MIDI (`theory.js`: `dstep = 7*octave + letterIndex`), so spelling is correct by construction — e.g. the raised 7th in D minor always comes out as C#, never Db.
- **score object**: `{seed, grade, confidence, key, timeSignature, barCount, divisions, tempoTerm, tempoBpm, title, progression, staves: {1: rightHandBars, 2: leftHandBars}}`. Each bar is `{events, beatDuration, directions}`; each event carries `dur` in `DIVISIONS`-per-quarter units, `type`, `rest`, and — if pitched — `pitch`/`dstep`/`chordDegrees`, plus optionally `grace` (see below).
- **rhythm cells** (`rhythm.js`): whole-beat idiomatic figures drawn from a fixed library, not built note-by-note. This guarantees bars always sum correctly and that beaming/dots/tuplets only appear once a grade's rules permit them. `meter.js` rescales the (quarter-note-beat) cell library for other beat units and swaps in a separate cell set for compound time (x/8 meters).
- **fingerprinting** (`fingerprint.js`): a test's fingerprint hashes its musical content (key, metre, bar count, every pitch/duration) rather than the MusicXML text, so two renders differing only in dynamics still count as the same test for dedup purposes (`generateUnique` + the browser's localStorage history).
- **`pickWeighted` (`melody.js`) picks a move category before a pitch**: step vs. leap vs. repeat is decided first, weighted directly by `generatorHints.stepwiseBiasPercent`, and only then does a candidate get picked within that category. Scoring every individual dstep candidate on one shared scale (the previous design) let `stepwiseBias` mean nothing in practice — there are always exactly two possible step candidates but often a dozen+ legal leap candidates, so their combined weight routinely beat the two steps' even at a high bias. Relatedly, a passing/neighbour tone's resolution (stepping onward in the same direction it was approached from) is *forced*, not just weighted, whenever a non-clashing option exists — leaving it to chance meant `repairNonChordTones` would silently discard and relocate an unresolved passing tone later, quietly turning an intended stepwise pair into two leaps.

### Grade 6-8 extras

Confirmed against the official Grade 6-8 specimen books (the syllabus PDFs, not fetchable from this environment but readable if the user attaches them): from Grade 6, every test has an actual piece title above the tempo/character word, not just the tempo word on its own — `score.title` (`generate.js`'s `TITLES` pool, original names in the same spirit, not the specific titles those books use) is only set for `grade >= 6`. `toMusicXml` has to put `<sound tempo>` on the *title's* `<direction>`, not the tempo term's — OSMD hoists whichever same-measure direction carries `<sound>` above any other, so leaving it on the tempo line would print the tempo word above the title instead of below it.

The rules table had also long documented pedal marks, ornaments and mid-piece tempo changes as Grade 6-8 features with no code behind them — `applyExpression` now implements all three: `addPedalMarking` (a bracket pedal line, `<pedal type="start/stop" line="yes"/>`, gated on the rules table's pedal mention — English at Grade 5 ("pedal"), Chinese at Grade 6-8 ("踏板"), so the gate checks both), `addMidPieceTempoChange` (a rit./a tempo pair around the halfway bar, `grade >= 6`), and `addOrnaments` (a step-wise acciaccatura on 1-2 melody notes, `grade >= 7`). A grace note is `event.grace = {pitch}` on the note it decorates, not a separate event — MusicXML forbids `<duration>` on a grace note (it borrows its time from the main note), so it can't be a normal bar-filling event; `musicxml.js`'s `renderGraceNote` emits it as its own `<note><grace slash="yes"/>...</note>` immediately before the main note.

### Rules table is the single source of truth

`src/rules/abrsm-piano-grades.json` drives every grade-specific parameter: keys, time signatures, bar-count ranges, rhythm vocabulary, hand range/tessitura, texture (five-finger position, hands-together, chord stacking), dynamics, articulations, tempo terms. Each grade carries a `confidence` marker (`verified`/`partial`/`inferred`), surfaced to the user in the UI whenever it isn't `verified`. Changing generation behavior for a specific grade should almost always mean editing this JSON rather than the generator code. `docs/abrsm-sight-reading-analysis.md` and `docs/abrsm-sight-reading-knowledge-base.md` are the source analysis behind the table's numbers.

### Frontend (`src/app/`)

- `app.js` — orchestrates everything: loads the rules JSON, initializes OSMD, wires the generate/prepare/play/stop/download buttons, runs the 30-second preparation countdown, and auto-fits layout (`fitScore`) by shrinking zoom and then forcing a uniform bars-per-line count so no line is ever left with a single orphaned bar.
- `stage.js` — reading-stage geometry. Reads bar/system bounding boxes directly out of the rendered SVG (`g.vf-measure`, `g.staffline`) rather than OSMD's internal graphic model, and drives the playback highlight box, moving playhead, and auto-scroll-to-system.
- `playback.js` — reference audio playback matching a sibling app's ("ScrollScore") audio chain: real Salamander piano samples, pitch-shifted to the nearest recorded note → gain envelope → stereo pan by pitch → reverb send (a synthesized impulse response, not a downloaded IR) → limiter → output. Falls back to a synthesized oscillator tone if the samples can't be fetched.

The whole test always renders in normal page flow, no cropped follow-window (that was tried and dropped — see git history around "Drop fullscreen, always show the whole test on the page"). The `#fullscreen` toggle (`app.js`'s `enterFullscreen`/`exitFullscreen`) puts the *entire page* into the Fullscreen API on `<html>`, not just the score frame. Browsers with no `Element.requestFullscreen` (older iOS Safari) fall back to a `.pseudo-fullscreen` CSS class with the same visual effect.

Fullscreen is a dedicated distraction-free view, not just "the same page with the browser chrome gone": the title, the status message, the footer and the preparation checklist's text all disappear (`html:fullscreen`/`.pseudo-fullscreen` selectors in `styles.css`), and the countdown/meta strip plus every control collapse onto one row pinned to the top; everything else on screen is the score. `#status` and `.controls` are unrelated siblings in the DOM, but CSS Grid (`grid-template-areas`) lets two siblings share one row — meta on the left, controls on the right — without moving anything. Two sizing traps bit this: `align-items` on the grid container defaults items to stretch, and setting it to `center` (to vertically centre the top row) stops the `main` track from stretching too, so the tall score SVG overflowed upward over the controls — fixed by leaving the container's `align-items` alone and centering only the two top-row items via `align-self`. And a bare `1fr` column won't shrink below its content's min-content width, so the meta strip and the button row together overflowed a phone's viewport — fixed with `minmax(0, 1fr)` plus letting the meta strip (not the button row) wrap to a second line on narrow screens, since "no wrap" in the request was about the buttons specifically.

## Conventions

- No build step, no bundler. `vendor/opensheetmusicdisplay.min.js` is committed directly (not `node_modules/`, which is never deployed) — see `vendor/README.md` before touching it.
- The rules table (`src/rules/abrsm-piano-grades.json`) is the single source of truth for per-grade parameters. Grade 6–8 numbers are `inferred` and need checking against the official ABRSM syllabus if it ever becomes reachable.
- `www.abrsm.org` and the piano sample host (`tonejs.github.io`) are blocked by this environment's egress policy — cannot be fetched directly from a session in this environment.
- Two hands are never generated independently — the left hand is written first and the right hand is checked against it (see `src/generator/melody.js`), or dissonant intervals fall out of two separate random walks.
- Any change to the follow-view (`src/app/stage.js`) or fullscreen behaviour should be re-verified with `npm run devices`, not just visually — several past bugs there only showed up in a real headless-browser trace (e.g. `.stage`'s `overflow:hidden` silently blocking its own horizontal scroll from ever running).
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
