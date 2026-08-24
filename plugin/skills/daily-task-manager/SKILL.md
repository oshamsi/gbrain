---
name: daily-task-manager
version: 2.1.0
description: |
  Task lifecycle management with stable task IDs. Add, complete, defer, remove,
  and review tasks with deterministic action routing and fail-closed ambiguity
  handling. Maintains a running task list as a brain page.
triggers:
  - "add task"
  - "complete task"
  - "what are my tasks"
  - "task list"
  - "defer task"
tools:
  - search
  - get_page
  - put_page
  - add_timeline_entry
mutating: true
upstream: daily-task-manager@fc834ee
---

# Daily Task Manager

## Contract

This skill guarantees:
- Tasks stored as a brain page (`ops/tasks`) with structured format and a stable `id` per task
- Task lifecycle: add → in-progress → complete | defer | remove
- Priority levels: P0 (urgent), P1 (today), P2 (this week), P3 (backlog)
- Completed tasks archived with completion date; deferred tasks carry a target date + reason
- Mutations never drop unrelated tasks or unknown sections
- Every action returns the structured result below (Returns)

### Returns

After every action, report a structured result so callers (including sub-agents) can chain reliably:

```
{action, task_id, status: ok|not_found|ambiguous|needs_confirmation, priority, date, page: "ops/tasks", saved: true|false}
```

For `review`, return the grouped active-task list instead of a single task_id. When invoked with the trigger "task list json", return a JSON array of task objects `{id, description, priority, due, status}` instead of markdown.

## Tool Interface

Use ONLY the declared tools. `get_page("ops/tasks", include_content: true)` to read, `put_page("ops/tasks", …)` to write, `add_timeline_entry` for the audit trail, `search` for cross-referencing. Do not shell out to `gbrain` CLI verbs from this skill; the tools are the interface. (When the user runs this manually outside an agent, the CLI equivalents are `gbrain get ops/tasks` / `gbrain put ops/tasks` — equivalents only, not the skill's interface.)

## Action Routing

Map user intent deterministically before touching state:
- "add / remind me to / put X on my list" → **add**
- "done with X / finished X / completed X / ✅ X" → **complete**
- "push X / defer X / move X to next week" → **defer**
- "delete X / remove X / kill task X" → **remove** (explicit delete words only — never infer remove)
- "what are my tasks / task list / what's on my plate (today)" → **review** ("today" filters to P0+P1)

## Phases

1. **Load.** `get_page("ops/tasks", include_content: true)`. Keep the returned canonical `content` and full `content_hash` together as one snapshot. **First run:** if the page does not exist, create it from the Output Format template, then immediately call `get_page("ops/tasks", include_content: true)` again and proceed only from that returned canonical `content` + `content_hash`; the create response does not provide the hash needed for the next write.
2. **Validate.** Determine the action via Action Routing. If required fields are missing (see per-action rules), ask ONE concise clarification before mutating state. Never fabricate priorities, due dates, or defer reasons.
3. **Identify the target task** (complete/defer/remove): match by `id` when given; otherwise fuzzy-match description against ACTIVE tasks only. Zero matches → return `not_found`, do not mutate. Multiple matches → list candidates with IDs, return `ambiguous`, do not mutate.
4. **Execute:**
   - **Add:** Require a description. Priority: use the user's stated/clearly-implied level; otherwise default to **P3 and say so in the reply + timeline entry**. Due date only if supplied or explicit in the user's words. Mint a new task ID (`t-YYYYMMDD-NN`, NN = next free ordinal that day). Add a timeline entry.
   - **Complete:** Mark `[x]`, move to Completed with `(completed: YYYY-MM-DD)`.
   - **Defer:** Require a target date/timeframe AND a reason; ask if missing. Move to Deferred preserving original text, ID, and priority unless the user changes them.
   - **Remove:** Destructive — require explicit confirmation unless the user's message already contains it. Prefer suggesting complete or defer.
   - **Review:** Read-only. Never mutates. Active tasks grouped by priority, IDs shown.
5. **Save.** Apply the ONE intended mutation to the canonical `content` from Load, then call `put_page("ops/tasks", content: <updated>, expected_content_hash: <hash from Load>)`. For an explicit Remove action only, also pass `removed_task_ids: [<task-id>]`; completion and deferral retain the id in the page and never use that field. Diff-mindset: touch only the affected lines; preserve all other content, including sections this skill doesn't recognize. Add the audit timeline entry only after `put_page` succeeds.

## Edge Cases

- **First run:** page missing → create from template, re-read it to acquire canonical content + hash, then act; `status: ok`, note "initialized".
- **Malformed page:** if `ops/tasks` exists but doesn't match the schema, do NOT rewrite it wholesale. Append/edit within it minimally, preserve unknown content verbatim, and flag the malformation in the reply.
- **Retry/duplicate add:** if an identical description already exists in active tasks, do not add a duplicate — report the existing task ID instead.
- **Dates:** ISO 8601 (`YYYY-MM-DD`) everywhere. Compute "today"/"next week" with code/clock, never guess.
- **Page identifier:** always `ops/tasks` (**no** `.md` extension) in tool calls; this is the single canonical location. gbrain's write-through appends `.md` itself, so passing `ops/tasks.md` writes the malformed file `brain/ops/tasks.md.md` and creates a duplicate page. (Learned 2026-08-16: the first write of this page did exactly that. Sibling skill `daily-task-prep` already used the extensionless form, so the two skills were pointing at different pages.)
- **Concurrent-write rejection.** `put_page` rejects a stale `expected_content_hash` with `write_conflict`; it also rejects duplicate IDs or unexplained active-ID drops with `task_guard_failed`. On either rejection, do NOT resubmit the old whole page. Re-run `get_page("ops/tasks", include_content: true)`, re-identify the target by stable ID, reapply only this turn's ONE intended mutation to the fresh `content` (for Add, recompute the next free ordinal), and retry ONCE with the fresh hash. If that bounded retry is rejected, return `saved: false` and report the conflict; never loop or merge unrelated differences from memory.

## Output Format

### Persisted page format

Each task carries a stable ID so later actions can target it safely:

```markdown
# Tasks

## P0 — Urgent
- [ ] <!-- id: t-20260115-01 --> {task description} (due: {date})

## P1 — Today
- [ ] <!-- id: {task-id} --> {task description} (due: {date optional})

## P2 — This Week
- [ ] <!-- id: {task-id} --> {task description} (due: {date optional})

## P3 — Backlog
- [ ] <!-- id: {task-id} --> {task description}

## Deferred
- [ ] <!-- id: {task-id} --> {task description} (deferred until: {date}; reason: {reason})

## Completed
- [x] <!-- id: {task-id} --> {task description} (completed: {date})
```

### User-facing response

After a mutation: one concise line — action, task ID, priority/status, relevant date, saved-or-not. For review: active tasks grouped by priority. Keep replies compact; avoid tables on narrow chat surfaces.

## Anti-Patterns

Each with its corrective action:
- Adding a task without priority → default P3 and SAY the default was applied (never silent).
- Mutating on an ambiguous reference → stop, list candidates with IDs, ask.
- Completing without a completion date → always stamp `(completed: YYYY-MM-DD)`.
- Deferring without target date + reason → ask for both first.
- Removing without explicit confirmation → confirm first; offer complete/defer instead.
- Overwriting the page wholesale / dropping unknown sections → minimal diff edits only.
- Using undeclared tools or CLI verbs → `get_page`/`put_page`/`search`/`add_timeline_entry` only.
- Fabricating due dates, priorities, or reasons → never invent required fields; ask.
- Unbounded list growth → when Backlog exceeds ~20 items, prompt a weekly review.
- Storing tasks outside the brain page → everything lives in `ops/tasks` (searchable).
- Retrying a rejected write with stale full-page content → re-read, re-identify by stable ID, reapply only one intended mutation, and retry once with the fresh hash.

## Design Rationale (failure modes this version closes)

- **Interface drift:** an earlier version declared `get_page`/`put_page` as tools but instructed CLI verbs in the body — models picked one at random. The declared tools are now the interface; CLI is relegated to a human-equivalent note.
- **Unmatchable tasks:** without task IDs, "complete the deploy task" against two similar tasks silently mutated the wrong one. Stable `t-YYYYMMDD-NN` IDs + fail-closed ambiguity handling fix this.
- **First-run crash:** assuming `ops/tasks` exists made a missing page undefined behavior. Create-from-template followed by an immediate hash-bearing re-read fixes this.
- **Wholesale overwrite risk:** "write updated task list" invited full-page rewrites that drop concurrent edits. Minimal-diff mandate + preserve-unknown-content rule fix this.
- **Concurrent overwrite risk:** optimistic `expected_content_hash` compare-and-swap rejects stale writes, while the `ops/tasks` semantic guard rejects duplicate IDs and any active ID that disappears without an explicit complete/defer/remove transition.
