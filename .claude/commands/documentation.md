---
description: Update README, API docs, component docs and changelog to match the current code
---

Bring documentation in sync with the current state of the code. Document what the code *does*, not what it was originally intended to do.

1. **README** — update setup/usage instructions if they've drifted from reality (new scripts, changed config, renamed commands). Verify a command actually exists and works before writing it down.
2. **API / component docs** — for any public function, endpoint, or component whose signature or behavior changed in this session, update its doc accordingly. Don't restate the code in prose; document the *why* and the *contract* (inputs, outputs, side effects, error cases).
3. **Changelog** — add an entry for user-visible changes made in this session, in whatever format this repo's changelog already uses (check its existing entries for style before adding your own; if none exists, ask before inventing a new file).

Keep it proportionate: don't generate boilerplate documentation for trivial internal helpers nobody outside this file will ever call. If nothing meaningfully changed since the last update, say so instead of padding the docs.
