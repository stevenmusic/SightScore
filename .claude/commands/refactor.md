---
description: Refactor code following SOLID, DRY, KISS — eliminate duplication without changing behavior
---

Refactor the code the user points to ($ARGUMENTS, or the current diff/selection if unspecified). A refactor must not change observable behavior. If tests exist for this code, they must still pass afterward; if they don't exist, say so before proceeding — a behavior-preserving refactor with no safety net is a real risk worth naming, not a reason to skip the refactor silently.

Apply, in order of what actually matters for this codebase — don't force all of these onto every change:

- **DRY** — eliminate real duplication (the same logic repeated), not superficially similar code that serves different purposes and will likely diverge. Don't over-abstract two things that only look alike today.
- **KISS** — prefer the simpler construct that does the same job; remove indirection that isn't earning its keep.
- **SOLID**, where it actually fits this codebase's paradigm. This matters far more in OOP-heavy code than in small functional/script-style code — don't force SRP/dependency-inversion ceremony onto a 50-line utility file.
- Naming and structure improvements that make the *next* change easier — not speculative flexibility for changes nobody has asked for.

Show the before/after only for what changed, not the whole file. Explain briefly why each change is safe (same behavior) and why it's actually better, not just different.
