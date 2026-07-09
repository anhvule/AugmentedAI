# Deem — Desktop-first AI Engineering (design spec)

Date: 2026-07-09
Sources: `Requirement.rtf` (product owner chat transcript, Vietnamese), demo video
(`My Movie 2-compressed.mp4`), debug-dashboard photo.

## Product intent (from the requirement transcript)

- A non-engineer writes a plain-English task description → the system plans,
  implements, evaluates, improves, reviews, tests and writes a report — no
  engineer needed in the loop.
- Output quality must be **systematic, not random**: run it 10 times, get 10
  results of equivalent, high quality. This is achieved with a standard flow
  and explicit criteria (rubrics, acceptance thresholds, retries).
- Works with **all AI LLM agents** (Claude Code, Codex, …), across **many
  projects**, many tasks per project, parallel runs.
- Full control surface: stop / resume / retry, token & budget checks, handoff
  between phases, skills/RAG hooks.
- Deep debug when needed: which process is running, which tool is being
  called, memory/CPU consumption, session transcript — but a casual user never
  needs to look at it.
- Future: control via chat app.

## What the demo video shows (feature checklist)

1. **Login** (workspace profile) → **Operational Dashboard**: Running Now /
   Tasks Tracked / Projects counters; Active workflow work list; Projects list
   (newest first) with agent badge (CLAUDE CODE / CODEX), task count, health,
   latest task activity; Add New Project.
2. **Project page**: description, agent badge, health, task count, branch,
   local repo path; Update settings; task directory with status filter chips —
   All, Pending, Planned, Implemented, Reviewed, Test Planned, Tested, Done,
   Failed, Archived; + New Task.
3. **Create task** modal: Task name*, Description, Requirements (one per line
   → checklist), Notes, Initial status, Preview.
4. **Task detail**: header (name, phase badge, ACCEPTED badge, View Log, Back
   to Project); tabs **Task / Plan / Execution / Review / Test Plan / Test
   Results / Summary**; right sidebar with **Task Metadata** (task id, LLM
   process id, project, agent, provider, run status, task status, priority,
   workspace, branch, current phase, attempts n/N, updated) and **Workflow
   progress** (each phase DONE / RUNNING / READY / BLOCKED).
5. **Plan tab**: numbered steps, each with description, Deliverables,
   Validation, LOCAL RUNNER badge; plan acceptance.
6. **Execution tab**: RUNNING → COMPLETED; Execution Summary; Steps Completed;
   Deviations from Plan; Files Changed; **Implementation Retries** (auto retry
   up to 3 times until accepted or budget exhausted); **Implementation
   Evaluation** score /60 with six criteria ×10 (Requirements Met, Code
   Correctness, Plan Adherence, No Regression Risk, Code Quality,
   Completeness); **Auto Run** toggles; Export Execution.md.
7. **Review tab**: Verdict (Approved) + score /60 progress bar; prose summary;
   Strengths; Issues; Review Scores (Correctness, Plan Adherence, Code
   Quality, Risk and Regressions, Completeness, Improvement Opportunities);
   Export Review.md.
8. **Test Plan tab**: environment notes; auto test cases (AUTO-RUN / priority
   badges, related changes, setup, commands, expected results, notes, test
   file, implementation notes) and manual cases (manual steps); “Implement
   auto tests” button; Manually Update Test Plan; Go to Test Results.
9. Agent works on a real local repo: per-task git branch (`task/<slug>`),
   commits, merge back — shown in a git client in the demo.
10. **Debug view** (photo): PROCESS — pid, command, cwd, CPU, uptime, idle;
    TOOL ACTIVITY — session id, transcript lines, total tool calls, last
    tool, session file path, per-tool call counts with bars.

## Architecture

Local single-user web app ("desktop-first" layout; Electron wrapper is future
work).

- **Backend** `server/` — Node + Express. JSON file store (`data/deem.json`,
  atomic writes). Server-Sent Events for live updates. Spawns and monitors
  agent processes.
- **Frontend** `web/` — Vite + React + react-router. One stylesheet matching
  the demo’s cream/navy aesthetic.
- **Agent adapters** `server/agents/` — uniform interface
  `run({phase, prompt, cwd, onEvent}) → {text, json, stats}`:
  - `mock` (default): deterministic simulated agent; produces realistic
    artifacts for every phase, actually writes a demo file in the repo,
    emits tool events. Lets the whole product run with zero API cost.
  - `claude-code`: spawns `claude -p … --output-format stream-json`.
  - `codex`: spawns `codex exec --json …`.
- **Workflow engine** `server/workflow.js` — the quality pipeline:

  `plan → execution → review → test_plan → test_results → summary`

  - Each phase runs the agent with a structured prompt and stores a JSON
    artifact; phase statuses: `blocked → ready → running → done/failed`.
  - Auto-run toggles per phase (plan approval, execution, review, tests).
  - **Evaluation** after execution: six criteria ×10; score ≥ threshold
    (42/60) and review verdict `approved` → accepted; otherwise **auto-retry**
    with the evaluator/reviewer feedback folded into the next attempt, up to
    `maxAttempts` (default 4).
  - Stop kills the agent process; rerun restarts the current phase.
  - Task status derived from pipeline: pending, planned, implemented,
    reviewed, test_planned, tested, done, failed (+ archived).
- **Process monitor** `server/monitor.js` — polls `ps` for pid/CPU/RSS/uptime
  of the running agent; aggregates per-tool call counts from adapter events;
  records transcript lines and session file path.
- **Exports** — every phase artifact renders to Markdown
  (`Task.md`, `Plan.md`, `Execution.md`, `Review.md`, `TestPlan.md`,
  `TestResults.md`, `Summary.md`).

## Data model (JSON store)

- `profile` { name, email }
- `projects[]` { id, name, description, repoPath, agent, provider, branch,
  health, createdAt }
- `tasks[]` { id, projectId, name, description, requirements[], notes,
  status, priority, branch, workspace, llmProcessId, currentPhase,
  attempts, maxAttempts, autoRun {execution, review, tests}, acceptance
  {threshold}, accepted, createdAt, updatedAt }
- `phases[]` { taskId, phase, status, startedAt, finishedAt, data (artifact),
  evaluation }
- `logs[]` { taskId, ts, level, source, message }
- `activity` per task { sessionId, transcriptLines, totalToolCalls, lastTool,
  sessionFile, tools {name: count}, process {pid, cpu, rss, elapsed, idle,
  command, cwd} }

## Iteration 2 (same day): "build everything"

All former non-goals were implemented:

- **Auth** (`server/auth.js`): users with scrypt password hashes, cookie
  sessions (30-day TTL), auth middleware over the whole API.
- **Token metering**: adapters emit `usage` events (mock synthesizes
  deterministic counts; claude parses result usage/cost; codex reads
  `token_count`); the workflow accumulates per-task usage and fails retries
  when the token budget is exhausted. Default budget in workspace settings.
- **Skills + Knowledge/RAG** (`server/rag.js`): per-project skills (standing
  instructions) and knowledge entries (1200-char chunks, keyword-overlap
  scoring, top-3 injected into every phase prompt). Managed from the project
  settings modal (General / Skills / Knowledge tabs).
- **Chat control** (`server/chat.js`): deterministic command engine (status /
  projects / tasks / new task / run / stop / report) shared by the in-app
  Command Center page and the Telegram long-poll bridge
  (`server/telegram.js`, dormant until a bot token is saved in settings).
- **Electron shell** (`electron/main.cjs`): boots the API in-process and
  opens the app window; `npm run app`.

Remaining future ideas: installers (electron-builder), embedding-based
retrieval, roles/permissions, more chat platforms.

## Iteration 3: ground-truth verification (anti-hallucination)

Principle: agent claims are hypotheses; only harness-observable artifacts
(git diffs, exit codes, processes) are facts. Implemented in
`server/verify.js` + workflow gates:

- `verifyExecution`: after every execution run, the harness resolves the task
  branch and computes the diff vs the project base branch. It overwrites the
  agent's `filesChanged`/`branch` with git truth and attaches a
  `verification` record. Checked-but-unverified (no branch / empty diff) →
  automatic rejection → retry with explicit feedback, regardless of
  self-reported scores.
- `runTestCommands`: the harness executes every auto case's commands
  (bash, 120 s timeout, output captured); exit codes decide pass/fail and
  overwrite the agent's claimed results (`harnessRun: true`,
  `agentClaimed` retained). Any failure routes back through `retryOrFail`.
- Review grounding: the review prompt embeds the real `git diff` (7 kB cap)
  and demands an `evidence` array citing file + observation for every claim;
  uncited claims are to be omitted. UI shows Evidence card; empty evidence
  is flagged as suspicious.
- All phase prompts carry an anti-invention clause (`write "unknown", never
  fabricate; claims are cross-checked`).
- Known mock quirk: stacked task branches mean the diff vs main can include
  earlier tasks' artifact files; real agents branch from the base.
