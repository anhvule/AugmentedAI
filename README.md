# Deem — Desktop-first AI Engineering

Describe a task in plain English. Deem drives an AI coding agent through a
standardized quality pipeline — **plan → execution → review → test plan →
test results → summary** — with rubric evaluation, acceptance thresholds and
bounded auto-retry, so output quality is *systematic, not random*.

Built from the product owner's requirement transcript, demo video and debug
dashboard reference (see [docs/specs](docs/specs/2026-07-09-deem-design.md)).

## Quick start

```bash
npm install
npm run dev        # web on http://localhost:4500, API on :4501
npm run app        # or: build + launch as an Electron desktop app
```

Open http://localhost:4500, create an account (email + password), then:

1. **Add New Project** — point it at any local git repository and pick an
   agent (Mock runner works with zero setup and zero API cost).
2. **+ New Task** — name, plain-English description, one requirement per line.
3. Watch the pipeline run: plan is generated and accepted, implementation is
   committed to a `task/<slug>` branch in your repo, evaluated against a
   6-criteria rubric (accepted at ≥42/60, auto-retried otherwise, up to 4
   attempts), independently reviewed, test-planned, tested and summarized.
4. **View Log** on any task shows the debug session: agent process (PID, CPU,
   memory, uptime, idle), per-tool call counts, session id/file and the live
   transcript.
5. Every tab exports its artifact as Markdown (`Plan.md`, `Execution.md`,
   `Review.md`, …).

## Ground truth over agent claims (anti-hallucination)

An agent's report is treated as a hypothesis; only what the harness can
observe counts as fact:

- **Execution is verified from git** — after every implementation run, Deem
  computes the real diff on the task branch. `filesChanged` comes from
  `git diff`, never from the agent. No commits / empty diff → automatic
  rejection and retry, regardless of self-reported scores.
- **Tests are run by the harness** — the agent may write tests, but every
  auto case's commands are executed by Deem itself; pass/fail comes from
  exit codes. Failing tests send the task back to implementation.
- **The reviewer reads the actual diff** — the review prompt embeds the git
  diff as ground truth and requires cited evidence (`file: what was
  observed`) for every claim; the Evidence card shows the citations.
- **Prompts forbid invention** — every phase prompt instructs the agent to
  write `unknown` rather than fabricate, and warns that claims are
  cross-checked.
- **Acceptance is layered** — a task proceeds only if harness verification,
  the rubric threshold, the independent review verdict, and harness-run
  tests all pass; retries stop at the attempt or token budget.

## Beyond the pipeline

- **Command Center & Telegram** — drive everything from chat: `status`,
  `projects`, `tasks <project>`, `new task in <project>: <name> | <desc> |
  <req1; req2>`, `run/stop/report <task>`. The in-app Command Center works out
  of the box; paste a @BotFather token in **Settings** and the same commands
  work from Telegram.
- **Skills & Knowledge (RAG)** — per project (Update settings → Skills /
  Knowledge): skills are standing instructions injected into every phase
  prompt; knowledge entries are chunked and the top-scoring chunks for each
  task are retrieved into the agent's context.
- **Token budgets** — every run's usage is metered (tokens + cost) per task;
  auto-retry stops when the attempt budget *or* token budget is exhausted.
  Default budget is configurable in Settings.
- **Multi-user auth** — scrypt-hashed passwords, cookie sessions, per-user
  accounts sharing the workspace.
- **Desktop app** — `npm run app` boots the API inside Electron and opens
  Deem as a native window.

## Agents

| Agent | Requirement | Notes |
|---|---|---|
| **Mock runner** | none | Deterministic simulation of the full pipeline; commits real artifacts to the target repo. Default. |
| **Claude Code** | `claude` CLI installed & authenticated | Runs headless (`claude -p --output-format stream-json`); tool calls stream into the debug view. |
| **Codex** | `codex` CLI installed & authenticated | Runs `codex exec --json`. |

Per-phase behaviour, retries and auto-run toggles are identical across
agents — the pipeline is the product; the agent is a plug-in
([server/agents](server/agents/)).

## Architecture

```
web/      Vite + React UI (dashboard, project, task tabs, debug view)
server/   Express API + SSE
  workflow.js   phase state machine, evaluation, acceptance, retries
  agents/       mock | claude-code | codex adapters
  monitor.js    ps-based process stats + tool activity aggregation
  exporters.js  Markdown renderers per phase
  store.js      JSON persistence (data/deem.json)
```

`npm test` runs the agent-determinism test suite. `npm run build` +
`npm start` serves the built UI from the API server as a single process.

## Future ideas

Distributable installers (electron-builder), vector-embedding retrieval for
the knowledge base, per-user permissions/roles, more chat platforms (Slack,
Discord) on the shared command engine.
