# Deem engine rebuild — Fable 5 native orchestrator

**Status:** Approved design · **Date:** 2026-07-12 · **Supersedes:** the phase machine in
`server/workflow.js` and the CLI agent adapters in `server/agents/{claude,codex}.js`.

**Source blueprint:** [`docs/AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md`](../AI-CODING-AGENT-ARCHITECTURAL-BLUEPRINT.md)
— this spec is the integration plan for that document into the existing Deem product. It
does not restate the blueprint's reference implementations (orchestrator state machine,
tool broker, verifier engine, Fable 5 SDK wiring); read that document for the code this spec
wires into the product.

**Related, not adopted:** [`docs/LANGGRAPH-BLUEPRINT.md`](../LANGGRAPH-BLUEPRINT.md) sketched
an alternative LangGraph-based engine earlier in this project's history. This spec supersedes
it as the direction Deem is actually building.

---

## 1. Decisions locked in brainstorming

| Question | Decision |
|---|---|
| Rebuild scope | **Swap the engine, keep the product.** UI, auth, projects store, SSE, Telegram, Electron, and RAG are unchanged. Only orchestration (`workflow.js`) and the agent backends it drives are replaced. |
| Agent backend | **Fable 5 native only.** The blueprint's direct-Anthropic-API `FableDispatcher` (task budgets, memory tool, effort levels, server-side fallback) replaces the Claude Code CLI and Codex CLI adapters. The "works with all LLMs" pluggability claim in the current README is retired. |
| Persistence | **Journal is source of truth; Node projects it.** The Python engine's write-ahead JSONL journal is the durable, crash-safe, replayable record. The Node shell subscribes to its event stream and upserts into the existing `data/deem.json` shape so the current UI needs no changes. |
| Platform | **macOS/Linux only for now.** The blueprint's POSIX sandbox confinement (`resource.setrlimit`, `os.killpg`) ships as specified. Windows is an explicit, documented gap — not built now. |
| Rollout | **Shadow run, then cutover.** A new "Fable 5 (native)" agent option runs the new engine next to Mock/Claude/Codex on real tasks. Old adapters and `workflow.js` are deleted only after the new engine is proven out. |
| Transport | **FastAPI service + SSE relay** (Option A from the three proposed). Node spawns and supervises `deemsvc` as a managed child process; talks to it over local HTTP; relays its SSE stream onto the existing `/api/events` firehose. |

---

## 2. Process topology

```
┌─────────────────────────────────────────────────────────────┐
│ Node/Express shell (unchanged)                               │
│  web/ React SPA · auth.js · store.js · events.js · exporters │
│  telegram.js · Electron host · monitor.js (extended)         │
└───────────────┬───────────────────────────────▲──────────────┘
                │ HTTP: POST /runs, /resume       │ SSE relay onto
                │ GET /health                      │ /api/events
                ▼                                   │
┌─────────────────────────────────────────────────────────────┐
│ deemsvc — Python FastAPI + asyncio orchestrator (new)         │
│  Orchestrator/TokenBudget/Step (blueprint §3)                 │
│  FableDispatcher — Explorer/Generator/Verifier (blueprint §8) │
│  ToolBroker sandbox boundary (blueprint §5)                   │
│  VerifierEngine — twin-worktree differential (blueprint §6.1) │
│  JSONL journal per run — data/runs/<run_id>/journal.jsonl     │
└─────────────────────────────────────────────────────────────┘
```

Node spawns `deemsvc` as a long-lived child process on API server boot, the same
supervision model `server/monitor.js` already applies to agent processes (health-checked,
restarted on crash, killed on Deem shutdown). Only one `deemsvc` process runs per Deem
instance; it multiplexes runs across projects internally via the blueprint's `Orchestrator`
concurrency semaphore.

### Service surface

```
POST /runs                  {task_spec, config}          → {run_id}
GET  /runs/{id}/events       SSE: step transitions, heartbeats, verdicts, journal writes
POST /runs/{id}/resume       {step_id, decision}          → resumes an ESCALATED step
GET  /runs/{id}/state        latest projected state (for reload / reconnect)
GET  /health
```

---

## 3. Component mapping

| Deem today | Blueprint equivalent | Disposition |
|---|---|---|
| Task pipeline (`plan → execution → review → test plan → test results → summary`) | `Intent` + step DAG (`explore → generate → verify → integrate`) | Re-expressed as the DAG's step classes. Plan/review/test-plan/test become steps within that shape rather than a separate 6-state machine. |
| Rubric scoring + up-to-4-attempt retry | `VerifierEngine._adjudicate` (`pass\|retry\|escalate`) + failure-signature novelty gate | Replaced. Strictly stronger: catches signature-repeat looping that rubric-only retries didn't. |
| `server/agents/mock.js` | Stub `dispatch` callable | **Kept**, reimplemented as a deterministic test double for `Orchestrator.run`, used in `deemsvc`'s test suite and as a zero-cost demo path. Not exposed as a separate product-facing "agent" after cutover. |
| `server/agents/claude.js`, `server/agents/codex.js` | `FableDispatcher` (blueprint §8.5) | **Retired** at cutover (kept alive during shadow period alongside the new option). |
| `server/workflow.js` | `Orchestrator` + `StepStatus` transition table (blueprint §3.2) | Replaced at cutover. |
| `server/workspace.js` (single-worktree isolation) | Generator's dedicated worktree + Verifier's twin worktrees (blueprint §5, §6.1) | Extended, not replaced — worktree lifecycle now manages up to 3 worktrees per verified attempt (generator + baseline + candidate) instead of 1 per task. |
| `server/monitor.js` (ps-based stats) | `task.heartbeat` messages (blueprint §4.1) | Debug view's live stats are sourced from heartbeats relayed through the journal instead of polling `ps` for the new engine's runs. `monitor.js` keeps its ps-based path for supervising the `deemsvc` process itself. |
| `server/audit.js` | Evidence bundle keyed by candidate commit SHA (blueprint §6 Stage 4) | `audit.js` becomes a thin writer that stores the bundle blueprint already produces (JUnit before/after, verdict JSON, verifier usage) instead of building its own audit record. |
| `data/deem.json` task/phase/artifact records | JSONL journal, event-sourced (blueprint §3.1) | Journal is ground truth (§4 below); `data/deem.json` becomes a projection. |
| RAG (`server/rag.js`) | Not covered by blueprint | Unchanged; context manifests (blueprint §4.1) are additive — retrieved knowledge chunks are folded into the `task.assign` objective text, RAG scoring logic itself is untouched. |

---

## 4. Persistence bridge

Each run gets its own append-only journal: `data/runs/<run_id>/journal.jsonl`, written by
`deemsvc` exactly per blueprint §3.1/§3.2 (write-ahead: a transition is journaled before it
takes effect). This file is the durable record used for crash recovery and time-travel/audit
queries.

Node does not read the journal file directly. `deemsvc`'s `GET /runs/{id}/events` SSE
endpoint is derived from the same journal (live tail and post-crash replay are the same code
path server-side). On each event, the Node shell:

1. Relays the raw event onto `/api/events` unchanged (existing `useEvents()` consumers keep
   working with zero client-side changes).
2. Upserts the relevant fields into `data/deem.json` via `store.js`, mapped through the
   component-mapping table in §3 — e.g. a `VERIFYING → PASSED` transition on a `generate`-class
   step updates that task's `execution` artifact and advances its displayed phase.

Crash recovery: on `deemsvc` restart, in-flight runs replay their journal
(`Orchestrator` re-enters steps at `READY` per blueprint §3.2); Node's projection catches up
by re-subscribing to `/runs/{id}/events` from the beginning of the current run, which is
strictly more granular than today's phase-level recovery.

---

## 5. Rollout

A new agent option, **"Fable 5 (native)"**, is added alongside Mock/Claude/Codex in project
settings. Selecting it for a project routes that project's task runs through `deemsvc`
instead of `workflow.js`; both engines can be active for different projects (or different
tasks) simultaneously during the shadow period — there is no global switch.

Cutover criteria (informal, to be made concrete in the implementation plan): the new engine
has run a representative set of real tasks with no journal-replay bugs, no sandbox escapes,
and verifier adjudication quality judged acceptable by spot-check. Once met, `workflow.js`
and the Claude/Codex adapters are deleted, and Mock is repointed to `deemsvc`'s stub
dispatcher as its only implementation.

---

## 6. Platform & security

The blueprint's POSIX sandbox (`resource.setrlimit` in `preexec_fn`, `start_new_session=True`
+ `os.killpg` for group-kill on timeout) ships as specified in blueprint §5.2. This does not
run on Windows (the `resource` module is POSIX-only). `docs/PRODUCTION.md` is updated to
state this as a known platform gap, not silently dropped.

The blueprint's capability grants (per-role `fs_write_scope`/`fs_deny`, `network: deny`,
argv-only tool invocation validated against `_SAFE_ARG`) are a strict superset of today's
"least-privilege agents" description in `docs/PRODUCTION.md` — that section is rewritten to
describe the broker-enforced model (blueprint §4.2, §5.1) rather than the current
adapter-level restrictions.

---

## 7. Testing

`deemsvc` gets its own pytest suite, covering the properties the blueprint calls out as
load-bearing:

- Transition-table legality: every edge not in `_LEGAL` raises `IllegalTransition` before
  any state mutates.
- `TokenBudget` reserve/commit invariants hold under concurrent in-flight steps
  (`committed + sum(reservations) <= ceiling`, always).
- Twin-worktree flake-bleaching: a test that fails deterministically is a confirmed
  regression; one that fails intermittently across `FLAKE_RERUNS` is quarantined, not charged.
- Failure-signature novelty gate: an identical signature on consecutive attempts escalates
  instead of retrying; a novel signature with budget headroom retries.
- Journal replay: a `deemsvc` process killed mid-run resumes at the correct step on restart,
  verified against a golden journal fixture.

The existing `server/tests/{mock,verify,workspace}.test.js` patterns (Node-side, JS/Vitest or
equivalent) are ported conceptually into this suite rather than reused directly, since they
currently test JS modules being retired.

A small golden-task set (5–10 tasks against a fixture repo, e.g. "add a CLI flag + test",
"fix a regression", "refactor within one file") is run end-to-end through `deemsvc` as an
integration check before shadow rollout, and again before cutover.

---

## 8. Explicit non-goals

- Multi-LLM-vendor pluggability (dropped per the agent-backend decision in §1).
- Windows support for the sandbox boundary (documented gap, §6).
- Changes to auth, multi-user accounts, Telegram, RAG scoring, or Electron packaging — none
  of these are touched by this rebuild.
- A new UI. Every existing task tab (Plan/Execution/Review/Test Plan/Test Results/Summary,
  debug view) renders from the same `data/deem.json` shape it does today.
