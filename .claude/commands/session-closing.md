---
description: Close out the working session — update CLAUDE.md, TODO, progress notes, and produce a Resume.md
---

End-of-session handoff. Do the following, in order, and only write to a file if it actually needs to change — don't touch one just to touch it.

1. **CLAUDE.md** — if this session established or changed a convention, workflow, gotcha, or architectural decision worth remembering, add or update it here. Keep entries short and load-bearing; delete anything now stale rather than letting it accumulate.
2. **TODO.md** (create at the repo root if none exists) — reconcile against what actually got done this session: check off completed items, add newly discovered work, remove anything no longer relevant. Don't just append — the list should reflect current reality, not a running log.
3. **Progress notes** (`PROGRESS.md` or this project's existing equivalent, if any) — a brief record of what was accomplished this session, in the project's existing format if one exists.
4. **Resume.md** — write (overwrite) `Resume.md` at the repo root: a short brief for whoever — human or a fresh Claude session — picks this up next. Include: what was just done, what's in progress and exactly where it was left off, any known issues or open questions, and the very next concrete step. Write it assuming the reader has zero memory of this conversation.
5. Finally, tell the user plainly whether this session's context is getting long or expensive to keep going. If so, suggest starting a new session and point them at `Resume.md` as the handoff document.

This step exists to make the *next* session cheap to start, not to produce paperwork — keep every file short, and skip any of the above that has nothing new to say.
