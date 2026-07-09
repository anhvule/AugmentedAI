# Deem architecture — an educational tour of every decision

This document walks through each architectural decision in Deem the way a
senior engineer would explain it to someone learning system design: what the
problem was, which options existed, what we picked, **why**, and what the
trade-off costs us. It also records the mistakes made during the build,
because those teach more than the successes.

Format for each section:

> **Decision** → **Why** → **Alternatives considered** → **Trade-offs / when
> to revisit** → **Lesson**

---

## 1. The core product insight: process beats model

**Decision.** Deem's value is not "call an LLM." It is a fixed, gated
pipeline — `plan → execution → review → test plan → test results → summary` —
with explicit acceptance criteria at every gate.

**Why.** The requirement was blunt: *run it 10 times, get 10 results of
equivalent quality*. A raw LLM cannot promise that; its output quality is a
distribution, not a value. You cannot remove the randomness of the model, so
you contain it with process: every attempt must pass the same rubric,
the same review, the same tests. Variance in the model becomes retries in
the system instead of surprises for the user.

**Alternatives.** (a) One mega-prompt that asks the agent to "plan,
implement, review and test" in a single run — cheaper, but nothing gates
anything, and the agent grades its own homework in the same breath it does
the homework. (b) Free-form agent loops (AutoGPT style) — flexible, but
unbounded cost and unpredictable stopping behaviour.

**Trade-offs.** A pipeline is slower and more expensive per task (multiple
model calls) and can feel bureaucratic for trivial tasks. If tasks are tiny,
you'd want a "fast lane" that skips review/tests.

**Lesson.** When a stochastic component must produce deterministic-feeling
outcomes, wrap it in a deterministic control system. This is classic control
theory thinking applied to LLMs: feedback (evaluation), setpoint (threshold),
actuator (retry with feedback), safety cutoff (budgets).

---

## 2. System shape: local-first monolith + SPA

**Decision.** One Node/Express process (API, workflow engine, agent
supervisor, SSE) + a React SPA, running on the user's machine. No cloud, no
queue, no database server. Electron wraps the same server for the desktop
feel.

**Why.** The agents *must* run locally anyway — they need the user's
repositories, git identity, and CLI credentials (`claude`, `codex`). Once
execution is local, moving orchestration to a cloud service only adds a
network boundary, auth handoff, and deployment story without adding
capability. A monolith also keeps the demo one command: `npm run dev`.

**Alternatives.** (a) Cloud backend + local "runner daemon" (like CI systems:
GitHub Actions ↔ self-hosted runners) — right answer for teams, overkill for
a single-user desktop product. (b) Pure Electron app with everything in the
main process — couples the UI to the engine; a separate HTTP server keeps the
browser, Electron, and even curl as equal clients.

**Trade-offs.** No multi-machine story, no horizontal scaling, one process
failure kills everything. The seam to fix that later already exists: the
agent adapter interface is where a remote runner would plug in.

**Lesson.** Put the process boundary where the *capability* boundary is. The
capability (running agents on the user's repo) is local, so the system is
local. Don't add distribution before the problem is distributed.

---

## 3. Persistence: a JSON file, deliberately

**Decision.** All state lives in `data/deem.json`, loaded into memory,
written back with **atomic writes** (write to `*.tmp`, then `rename`) and a
50 ms debounce. See `server/store.js`.

**Why.** Single user, small data (projects, tasks, artifacts, logs), and the
entire dataset fits comfortably in memory. A JSON file is inspectable
(`cat data/deem.json`), diffable, trivially backed up, and requires zero
native dependencies — `better-sqlite3` would have added a node-gyp build step
to `npm install` for no functional gain at this scale.

**The two non-obvious details worth learning:**

- **Atomic write via rename.** POSIX `rename()` on the same filesystem is
  atomic. If the process dies mid-write, you have either the old complete
  file or the new complete file — never a half-written one. Writing directly
  to the target file would risk corruption on crash.
- **Debounce.** The workflow engine mutates state dozens of times per second
  during a run. Serializing the world on every mutation would be O(state) per
  event; batching writes to at most every 50 ms bounds the cost while keeping
  the on-disk copy at most 50 ms stale.

**Alternatives.** SQLite (right choice the moment you need queries over logs,
concurrent writers, or data > RAM); Postgres (multi-user server deployment);
an append-only event log (best audit trail, more machinery).

**Trade-offs / when to revisit.** Whole-file rewrites scale with total state
size — logs are already capped per task (800 lines) to control this. No
transactions across concurrent async paths; last-write-wins on a shared
in-memory object is fine single-process, wrong multi-process.

**Lesson.** Choose storage by access pattern, not by habit. "In-memory object
+ atomic snapshot" is a legitimate database for single-writer desktop apps —
and knowing *why* it stops being legitimate (size, concurrency, queries) is
the actual senior skill.

---

## 4. Real-time updates: Server-Sent Events, one firehose

**Decision.** A single SSE endpoint (`/api/events`) broadcasts typed events
(`task`, `phase`, `log`, `activity`, `chat`, `projects`) to every connected
client; payloads carry `taskId`/`projectId` and clients filter what they
care about. See `server/events.js`, `useEvents()` in `web/src/api.js`.

**Why SSE over WebSocket.** The data flow is strictly server → client
(commands go through normal REST POSTs). SSE is plain HTTP: no upgrade
handshake, no extra library, automatic reconnection built into
`EventSource`, works through the Vite dev proxy untouched. WebSockets buy
bidirectionality we don't need at the cost of infrastructure we'd have to
manage.

**Why one channel instead of per-task subscriptions.** Subscription
bookkeeping (subscribe/unsubscribe on route changes, server-side rooms) is
real complexity. With one user and event payloads of a few hundred bytes,
"send everything, filter client-side" is simpler and cannot desynchronize.

**Alternatives.** Polling (simplest, but latency × request volume), WebSocket
(needed if the browser ever streams *to* the server, e.g. interactive agent
input), per-entity SSE channels (needed at multi-tenant scale).

**Lesson.** Match the transport to the direction and volume of data. The
cheapest correct mechanism wins; "everyone uses WebSockets" is not a reason.

---

## 5. Agent adapters: ports & adapters (hexagonal) around a hostile dependency

**Decision.** Every agent implements one interface —
`run({phase, prompt, cwd, task, project, attempt, onEvent, registerChild}) →
{ok, json, text}` — and the rest of the system knows nothing else. Three
implementations: `mock`, `claude-code`, `codex` (`server/agents/`).

**Why.** The requirement said "works with all AI LLMs." The only way that
stays true over time is if the workflow engine never touches an
agent-specific concept. The adapter translates each CLI's dialect
(Claude's `stream-json` events, Codex's JSONL items) into the same small
vocabulary: `session`, `tool`, `log`, `usage`, plus a final result. Adding
Gemini or a raw-API agent is one new file.

**Why CLI subprocesses instead of SDK/API calls.** The agent CLIs already
solve the hard, constantly-shifting parts: repo-aware context, tool
execution, permissions, session transcripts. Spawning `claude -p
--output-format stream-json` inherits all of it, and the user's existing
authentication comes along free. An API integration would mean rebuilding a
tool-execution loop — a whole product — inside Deem.

**The mock agent is a design decision, not a stub.** It emits the same event
stream, *actually commits real files to a real git branch*, and produces
rubric scores from a **seeded PRNG** (seed = `taskId:phase:attempt`), so the
whole product is demonstrable and testable with zero API cost and total
determinism. The demo *is* the test fixture.

**Trade-offs.** Subprocess parsing is coupled to CLI output formats, which
can change (that's contained inside each adapter — exactly where such
breakage belongs). Mock realism can drift from real-agent behaviour; the
harness verification layer (§9) limits how much that matters.

**Lesson.** Isolate the dependency you trust least behind the narrowest
interface you can define. And make your fake *good*: a deterministic,
behavior-complete fake turns "manual demo" into "repeatable test."

---

## 6. The workflow engine: an explicit state machine, phases as data

**Decision.** Phases are rows (`{taskId, phase, status}` with
`blocked → ready → running → done/failed/stopped`), transitions live in one
file (`server/workflow.js`), and task-level status (`pending`, `planned`,
`implemented`, … `done`, `failed`) is **derived** from phase completion via a
lookup table (`STATUS_AFTER`).

**Why.** Gated pipelines *are* state machines. Writing the machine explicitly
— instead of scattering `if` statements across route handlers — gives you:
one place to audit transitions, a UI sidebar that just renders the phase
rows, resumability (state survives restarts because it's data, not stack
frames of some in-flight function), and gates (`autoRun` flags per phase)
that are configuration rather than code paths.

**Key detail: the retry loop is feedback, not repetition.** When evaluation
scores below threshold, review rejects, or (since the verification layer)
the harness finds no diff or failing tests, the engine re-runs *execution*
with the rejection reasons injected into the prompt
(`retryOrFail → startPhase(feedback)`), re-blocking downstream phases. A
retry that doesn't carry the failure back into the next attempt is just a
slot machine pull.

**Key detail: budgets are cutoffs, not suggestions.** Two independent
budgets stop the loop: attempts (`maxAttempts`, default 4) and tokens
(per-task `budget.tokens`). Feedback loops around stochastic systems can
oscillate forever; every such loop needs a hard stop.

**A concurrency subtlety worth studying.** A phase run is an `await` across
seconds-to-minutes; the user can hit *Stop* (or start a new run) meanwhile.
The engine guards with an identity check — `running.get(taskId) === entry`
— so a stale completion can't overwrite a newer run's state. This is the
async-race pattern: *check that you are still the current owner before
committing results computed in the past.*

**Alternatives.** A job-queue framework (BullMQ etc. — needs Redis, wrong
weight class), durable workflow engines (Temporal — the "right" industrial
answer, massive dependency), or implicit state in async control flow
(unresumable, unauditable).

**Lesson.** If your domain has states and gates, *model states and gates*.
Every place your code "knows" the state implicitly is a place it will
eventually disagree with reality.

---

## 7. Rubrics and thresholds: making "good enough" computable

**Decision.** Execution is scored on six named criteria × 10 points
(Requirements Met, Code Correctness, Plan Adherence, No Regression Risk,
Code Quality, Completeness); review uses a parallel rubric. Acceptance is a
threshold (42/60) checked by the engine, not vibes.

**Why.** "Retry until it's good" requires the system to *compute* "good."
Named criteria also make the retry feedback specific ("Plan Adherence 4/10"
tells the next attempt what to fix), and the demo video showed exactly this
UI (score chips, n/60 badges) — it's the product's visible promise of rigor.

**Trade-offs.** LLM-self-assigned numbers are noisy and flatterable — which
is precisely why the rubric is only *one* of four gates (see §9). Thresholds
invite Goodhart's law: optimize the score, not the work. Grounding scores in
required evidence citations mitigates but doesn't eliminate this.

**Lesson.** Quantify judgments to automate them — then never let a
self-reported number be the only gate.

---

## 8. Prompts as contracts: strict JSON artifacts

**Decision.** Every phase prompt (`server/prompts.js`) demands a JSON object
matching an explicit schema, parsed by a lenient extractor
(`parseJsonLoose`: try fenced block, then outermost braces). No JSON → the
phase **fails**; it does not limp forward on prose.

**Why.** Downstream phases consume upstream artifacts programmatically (the
review reads the plan's step titles; the test runner reads commands). Prose
would need NLP to consume; JSON needs `JSON.parse`. Schemas also *constrain
the model*: asking for `{"deviations": [...]}` forces it to think about
deviations at all.

**Why lenient parsing.** Models wrap JSON in fences or add a courtesy
sentence despite instructions. Strict parsing would fail runs over
formatting noise; lenient extraction + hard failure when there's genuinely
no object is the practical middle.

**Lesson.** Treat LLM I/O as an API with a schema, not a conversation. And
put a tolerant decoder in front of any generator you don't fully control —
Postel's law applied to models.

---

## 9. Ground truth over claims: the anti-hallucination layer

The most important architecture lesson in the project. Added in iteration 3
after asking: *where does this system take an agent's word for something it
could check?*

**The trust model.** An agent's report is a **hypothesis**. Only
harness-observable artifacts are **facts**: git diffs, command exit codes,
running processes. Every gate was rebuilt on facts (`server/verify.js`):

1. **Execution verified from git.** After every implementation run the
   harness resolves the task branch and computes the real diff vs the base
   branch. `filesChanged` is *overwritten* with git's answer; the agent's
   list is discarded. No branch or empty diff → automatic rejection + retry
   feedback ("reporting work without a diff is rejected automatically") —
   regardless of self-scores. Catches the worst failure: a confident agent
   that did nothing.
2. **Tests executed by the harness.** The agent may write test files, but
   Deem runs every auto case's commands itself (bash, 120 s timeout,
   captured output) and exit codes overwrite the claimed results. The
   original claim is kept (`agentClaimed`) — a claims-vs-reality diff is
   itself a useful hallucination signal.
3. **Review grounded in the diff.** The reviewer receives the actual
   `git diff` labeled "the ONLY changes that exist" and must return an
   `evidence` array citing `file: observation` for each claim. Reviewing an
   implementer's *summary* means reviewing the hallucination; reviewing the
   diff means reviewing the work.
4. **Anti-invention clause everywhere.** Every prompt: write `"unknown"`
   rather than fabricate; claims are cross-checked. Honest because it now is.

**Residual risk, stated honestly.** If ground truth is unobservable (project
isn't a git repo) verification reports `SKIPPED` and proceeds with a warning
— you cannot verify what you cannot observe, and pretending otherwise would
be its own hallucination. Reviewer and implementer are still the same model
family (correlated errors); the designed fix is cross-agent review (Codex
reviews Claude's branch) — the adapter seam makes it a small change.

**Lesson.** For any autonomous system, draw the line between *claims* and
*observations* early, and make every gate consume observations. This is the
LLM version of "don't trust client input" — the model is a client.

---

## 10. RAG and skills: grounding before generating

**Decision.** Two per-project context mechanisms (`server/rag.js`), both
injected into every phase prompt: **skills** (standing instructions, always
included when enabled) and **knowledge** (documents chunked at 1200 chars,
scored by keyword overlap `hits/√(chunkLength)`, top-3 injected).

**Why two mechanisms.** They answer different questions. Skills: *how should
work be done here* (conventions, guardrails) — unconditional. Knowledge:
*what is true about this project* (architecture notes, API contracts) —
selected per task, because context windows are finite and irrelevant context
actively degrades output.

**Why keyword scoring instead of embeddings.** Embeddings need a model
dependency, an index, and API calls; for tens of documents per project,
normalized keyword overlap is transparent (you can compute *why* a chunk was
chosen by hand), fast, and dependency-free. The interface —
`retrieveKnowledge(project, task, k)` — doesn't care how scoring works
inside, so upgrading to embeddings later touches one function.

**The `√length` detail.** Dividing hit count by chunk length would bury long
chunks; not normalizing at all favours them. `hits/√length` is the classic
compromise (cosine-similarity-flavoured) that lets a short precise chunk
beat a long rambling one.

**Lesson.** Retrieval quality matters less than retrieval *plumbing* at
small scale. Build the injection pipeline with a simple scorer; swap the
scorer when data volume proves you need to.

---

## 11. Chat control: one deterministic brain, many mouths

**Decision.** A single command engine (`server/chat.js`) parses messages
with regexes (`status`, `projects`, `new task in <project>: … | … | …`,
`run/stop/report <task>`); the web Command Center and the Telegram bridge
(`server/telegram.js`) are thin frontends over it.

**Why deterministic parsing instead of an LLM intent parser.** These are
*control* commands — they start agents, stop processes, spend money. A
misparsed intent has real side effects. Regex commands are instant, free,
and fail *loudly* (unknown input → help text) rather than creatively. The
irony is intentional: the product that orchestrates LLMs doesn't use one to
parse its own control channel.

**Why Telegram, and why long-polling.** Telegram bots need only a token —
no OAuth app review, no public webhook URL. Long-polling (`getUpdates`,
25 s timeout) works from behind NAT on a laptop, which webhooks don't. The
bridge is dormant without a token and survives network failures with
exponential backoff (2 s → 60 s cap). A `generation` counter invalidates the
old polling loop when the token changes — same stale-owner pattern as the
workflow engine's run guard.

**Lesson.** Reuse the brain, not the interface: any channel that can deliver
a string can control the system. And keep LLMs out of the control plane
until the cost of misunderstanding is lower than the cost of rigidity.

---

## 12. Auth: boring, standard, correct

**Decision.** Passwords hashed with **scrypt** (per-user random salt),
constant-time comparison (`timingSafeEqual`), opaque random session tokens
in an **HttpOnly, SameSite=Lax cookie**, 30-day TTL, sessions stored
server-side and destroyed on logout (`server/auth.js`).

**Why these specifics — each is a named attack class:**

- *scrypt, not SHA-256*: password hashes must be **slow and memory-hard** so
  offline brute-force after a database leak is expensive. Fast hashes are
  for integrity, not secrets.
- *per-user salt*: defeats rainbow tables and hides identical passwords.
- *timingSafeEqual*: string `===` leaks how many leading bytes matched via
  response timing.
- *HttpOnly cookie, not localStorage JWT*: JS cannot read the token, so XSS
  can't exfiltrate it; the browser handles expiry and attachment (including
  for `EventSource`, which cannot set headers — a practical reason cookies
  beat `Authorization` here).
- *server-side sessions, not JWT*: instant revocation on logout; JWT's
  statelessness solves a multi-service problem this system doesn't have.

**One mount-point bug worth remembering.** The middleware is mounted at
`app.use('/api', …)`, so inside it `req.path` is `/login`, *not*
`/api/login`. The first version whitelisted the full paths and locked
everyone out of registration. Express strips the mount prefix — a classic
framework gotcha.

**Lesson.** Auth is a solved problem; novelty is risk. Know the attack each
standard ingredient blocks, then use the standard ingredient.

---

## 13. Observability as a product feature

**Decision.** The debug view (process PID/CPU/RSS/uptime/idle via `ps`
polling; per-tool call counts, session id and transcript file parsed from
adapter event streams; live log over SSE) is a first-class page, built to
match the product owner's reference screenshot (`server/monitor.js`).

**Why.** The requirement separates personas: a casual user never opens it; a
power user debugging a stuck agent needs *which process, which tool, how
long idle* at a glance. Idle time is derived, not measured: `now −
lastEventTimestamp` — an agent that's alive but silent for 90 s is telling
you something no CPU metric shows.

**Why polling `ps` instead of instrumentation.** The child process is a
black box we didn't write; the OS already accounts for its CPU/RSS.
Polling every 2 s while a run is active costs nothing and needs no
cooperation from the agent.

**Lesson.** For systems that supervise other programs, observability is not
ops tooling — it *is* the product. Build the debug surface from what you can
observe without the subject's cooperation.

---

## 14. Token metering: normalize at the edge, enforce in the engine

**Decision.** Adapters emit `usage` events in whatever shape their CLI
provides — Claude reports per-run usage and cost in its result event; Codex
reports *cumulative* token counts (handled via an `absolute` flag that
replaces instead of adds; the mock synthesizes seeded counts). The engine
accumulates per task and the budget check lives with the retry logic.

**Why the `absolute` flag matters (a normalization lesson).** Two providers,
two semantics: deltas vs running totals. Summing a running total
double-counts. The adapter layer is exactly where dialect differences like
this must die — the engine sees one semantic.

**Why budget checks live in `retryOrFail`.** The demo's own copy — "retries
… until it is accepted or the budget is exhausted" — locates the decision:
budgets don't abort a run mid-flight (wasting the tokens already spent);
they stop the *next* attempt from starting.

**Lesson.** Meter at the boundary, normalize at the boundary, enforce at the
decision point.

---

## 15. Electron: the desktop is a shell, not a fork

**Decision.** `electron/main.cjs` boots the same Express server in-process
(dynamic `import()` of the ESM server from a CJS entry), waits for it, then
opens a `BrowserWindow` at `localhost`. The web build is the desktop UI —
zero forked code. External links route to the OS browser via
`setWindowOpenHandler`.

**Why.** "Desktop-first" is about feel (dock icon, window, no browser
chrome), not about different functionality. Any divergence between web and
desktop code paths would be a second product to maintain.

**A real bug this surfaced (learn from it).** The preview harness injects
`PORT=4500` into child processes; the server originally read
`process.env.PORT` and collided with Vite. Fix: a namespaced variable,
`DEEM_PORT`. Generic env var names are a shared global namespace — prefix
yours.

**Lesson.** Ship one artifact behind many shells. And treat `PORT`, `HOME`,
`NODE_ENV` as land someone else may already occupy.

---

## 16. Testing strategy: test the promises, not the plumbing

**Decision.** The suite (7 tests) covers exactly two things: the
**determinism promise** (same task + attempt → identical mock evaluation;
scores always ≥ threshold so demos never flake) and the **verification
layer** (missing branch → rejected; file lists come from git even when the
artifact lies; non-repo → skipped; exit codes decide test results — using
real temp git repos, not mocks of git).

**Why so narrow.** Route handlers and React components change shape
constantly and fail visibly in the UI; the quality gates fail *silently* —
a broken verification layer would quietly re-open the hallucination hole.
Test intensity should follow silent-failure risk, not line coverage.

**Why real git repos in tests.** Mocking git would test our assumptions
about git instead of git. `fs.mkdtempSync` + `git init` costs ~50 ms and
tests the truth.

**Lesson.** Coverage is a vanity metric; ask "which failure would I not
notice?" and test there first.

---

## 17. Mistakes made during this build (kept on purpose)

1. **`PORT` collision** (§15) — namespace your env vars.
2. **Auth mount-point paths** (§12) — `app.use(prefix, mw)` strips the
   prefix from `req.path`.
3. **Programmatic form fills vs React controlled inputs** — setting
   `input.value` doesn't fire React's `onChange`; state stayed empty while
   the DOM looked full. UI automation must dispatch real events (or drive
   the API directly).
4. **Off-by-one in attempt reporting** — the mock received `attempt =
   attempts + 1` and echoed it as *attempts used*. Fenceposts live at every
   interface where a counter changes meaning.
5. **Mock branch stacking** — the mock branches from current HEAD, so task
   branch N's diff vs main includes N−1's files. Harmless here, but a real
   reminder: *always branch from an explicit base, never from wherever HEAD
   happens to be.*

---

## 18. How the architecture wants to grow

Each seam was left where the next feature plugs in:

| Future need | Where it plugs in |
|---|---|
| New agent (Gemini, raw API) | new file in `server/agents/`, registry entry |
| Cross-agent review (break error correlation) | pick a different adapter for the `review` phase in `startPhase` |
| Embedding retrieval | replace the scorer inside `retrieveKnowledge()` |
| Slack/Discord control | new bridge over `handleChatMessage()` |
| Team/cloud deployment | swap `store.js` for SQLite/Postgres; split runner from API at the adapter seam |
| Installers | electron-builder config over the existing `electron/` shell |

The metric of a good architecture isn't that it predicted the future — it's
that the future only has to touch one file at a time.
