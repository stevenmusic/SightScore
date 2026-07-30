---
description: Debug an issue by finding the root cause with multiple hypotheses, not by guessing fixes
---

The user has described a bug or unexpected behavior ($ARGUMENTS). Do not immediately change code. Follow this process:

1. **Reproduce first.** Find or write the smallest case that reproduces the problem (a failing test, a specific input, a specific user flow). If you cannot reproduce it, say so and ask for more detail rather than guessing at a fix blind.
2. **Generate multiple hypotheses** for the root cause — at least 2-3 when the cause isn't already obvious from a stack trace. For each, state what evidence would confirm or rule it out.
3. **Gather evidence** — read the actual code path, add temporary logging/assertions if needed, run the reproduction, inspect real values — rather than reasoning from memory about what the code "probably" does.
4. **Identify the actual root cause**, distinguishing it from a symptom. If a symptom-level fix is separately worth doing as a defensive measure, say so explicitly, but do not present it as the root-cause fix.
5. **Propose the fix** only after the root cause is confirmed, and explain why it addresses the cause and not just this one instance of it.
6. Add or update a test that would have caught this bug, when practical.

Do not randomly try changes and see what sticks. Every code change should follow from a stated, evidenced diagnosis — if you're not sure yet, say what you're still not sure of instead of shipping a guess.
