---
description: Set up or extend unit/integration tests — Jest, Vitest, or Playwright depending on the project
---

Depending on $ARGUMENTS:

**A. No test setup exists yet**
1. Detect the project's stack (check `package.json`, existing config files) and pick the conventional tool for it — Vitest for Vite projects, Jest for most other Node/React setups unless one is already implied, Playwright for browser/e2e coverage, or Node's built-in `node --test` for a plain Node project with no framework already chosen (as this repo does — see `test/`). Don't install a second test runner if one is already configured; extend it instead.
2. Set up the minimal working config, a sample test, and the npm script to run it.

**B. Tests exist — add or extend coverage**
1. Read existing tests first and match their style and helpers rather than introducing a second convention.
2. Prioritize, in order: (1) the code path the user is actually working on, (2) logic with branching/edge cases, (3) a regression test for any bug just fixed in this session.
3. Unit tests for pure logic; integration tests where multiple units interact through a real (not over-mocked) boundary; Playwright for actual UI/browser behavior. Pick the right layer — don't reach for a browser test to check a pure function.
4. Run the full test suite after adding tests and report the actual result. Never claim tests pass without having run them.

Favor a few well-chosen tests over exhaustive but shallow coverage of every branch. State plainly what is *not* covered and why, if anything significant is left out.
