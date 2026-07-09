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
```

Open http://localhost:4500, enter a name/email, then:

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

## Not yet implemented (future)

Chat-app remote control, Electron packaging, RAG/skills management UI,
token-level budget metering, multi-user auth.
