# SightScore — project notes for Claude

Rule-based ABRSM sight-reading test generator. Plain static site (no build step, no framework): `index.html` + `src/`, deployed as-is to GitHub Pages. See `README.md` for the full architecture rundown.

## Commands

```bash
npm test              # generator + MusicXML unit tests (node --test)
npm run devices       # Playwright layout/behaviour check across 5 device sizes
npm run smoke         # Playwright render check across all 8 grades
npm run serve         # local static server
```

## Conventions

- No build step, no bundler. `vendor/opensheetmusicdisplay.min.js` is committed directly (not `node_modules/`, which is never deployed) — see `vendor/README.md` before touching it.
- The rules table (`src/rules/abrsm-piano-grades.json`) is the single source of truth for per-grade parameters. Each grade carries a `confidence` marker (`verified`/`partial`/`inferred`) — Grade 6–8 numbers are inferred and need checking against the official ABRSM syllabus if it ever becomes reachable.
- `www.abrsm.org` and the piano sample host (`tonejs.github.io`) are blocked by this environment's egress policy — cannot be fetched directly from a session in this environment.
- Two hands are never generated independently — the left hand is written first and the right hand is checked against it (see `src/generator/melody.js`), or dissonant intervals fall out of two separate random walks.
- Any change to the follow-view (`src/app/stage.js`) or fullscreen behaviour should be re-verified with `npm run devices`, not just visually — several past bugs there only showed up in a real headless-browser trace (e.g. `.stage`'s `overflow:hidden` silently blocking its own horizontal scroll from ever running).

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
