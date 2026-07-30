---
description: Review the current diff for clean code, performance, security, readability and architectural fit
---

Review the pending changes in this repository — `git diff`, `git diff --staged`, and untracked new files via `git status`. If there is no diff, say so and ask what to review instead of inventing one.

Evaluate against five dimensions, most important first:

1. **Security** — injection, unsafe deserialization, secrets committed in code, missing input validation at trust boundaries, unsafe use of user input in file paths/shell commands/queries.
2. **Correctness / clean code** — dead code, unclear naming, functions doing more than one thing, magic numbers/strings that should be named constants, error handling that silently swallows failures.
3. **Performance** — obvious algorithmic issues (N+1 queries, unnecessary re-renders, O(n²) where O(n) is available), unbounded loops/allocations, blocking calls on a hot path.
4. **Readability** — would a new contributor understand this without asking you? Overly clever one-liners, formatting the linter wouldn't catch, comments explaining *what* instead of *why*.
5. **Architectural fit** — does this follow the project's existing folder/layering convention (check neighboring files for the actual pattern in use — don't assume one)? Does it introduce a dependency in the wrong direction?

Rules:
- Point to exact file:line for every finding. No vague "the code could be cleaner" without a location.
- Distinguish must-fix from nice-to-have explicitly.
- Do not invent issues to pad the list — if the diff is clean, say so plainly.
- Report findings first; do not rewrite the code yourself unless asked to fix it after reviewing.
- If the `ReportFindings` tool is available in this session, use it to report results in the typed format it expects; otherwise report the same content as clearly structured text.
