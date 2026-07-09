# Running Deem against production codebases

Deem is designed so you can point it at a repository that ships to millions
of users and let agents work without endangering that repo or your team's
workflow. This document is the operator's guide: what protects you, what to
configure, and what still requires judgment.

## The safety model

**1. Your checkout is never touched.**
Every task runs in its own **git worktree** under `~/.deem/worktrees/<taskId>`,
created from the project's configured base branch (never from "wherever HEAD
happens to be"). Agents edit, commit and run tests only inside that worktree.
Your working directory, staged changes, and current branch are untouched —
verified byte-for-byte in the test suite. Task branches (`task/<slug>`) are
visible from the main repo for review and merge; archiving a task removes its
worktree, the branch survives.

**2. Deem never merges, never pushes.**
The pipeline ends with an approved, tested branch and a report. Merging into
a protected branch stays a human decision (or your CI's). Treat Deem's output
like a colleague's PR: the harness verified a real diff exists, tests passed
by exit code, and a reviewer cited evidence — but the merge button is yours.

**3. Agents run with least privilege by default.**
Per-project **permission mode**:
- `restricted` (default): file edits plus the dev toolchain
  (`git`, `npm`, `npx`, `node`, `yarn`, `pnpm`) — no arbitrary shell, no
  network tools, no package publishing. Maps to Claude Code `--allowedTools`
  and Codex's workspace-write sandbox.
- `full`: everything (`--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox`). Use only on throwaway repos.

**4. Every claim is verified against ground truth** (see ARCHITECTURE §9):
git diffs override agent-reported file lists; empty diff → automatic reject;
tests are executed by the harness and judged by exit codes; reviews must cite
evidence from the real diff.

## Operational controls

| Control | Default | Where |
|---|---|---|
| Max concurrent runs | 2 (queue beyond that) | Settings |
| Phase watchdog timeout | 30 min, then SIGKILL + phase failed | Settings |
| Attempt budget per task | 4 | task metadata |
| Token budget per task | 500k tokens | Settings / per task |
| Login lockout | 5 failures → 15 min | built-in |
| Audit trail | `data/audit.log` (JSONL, append-only) | `GET /api/audit` |
| Health probe | `GET /api/health` (public, no secrets) | monitoring |

**Crash recovery.** On boot, phases left `running`/`queued` by a crash are
marked `stopped — interrupted by server restart`; rerun them from the task
page. On SIGINT/SIGTERM, agent child processes are killed and state is
flushed synchronously before exit.

**State files.** `data/deem.json` (mode 0600 — contains session and bot
tokens) and `data/audit.log`. Back up the `data/` directory; it is the whole
system state. Worktrees are disposable caches.

## Deployment shapes

- **Engineer's workstation (default).** `npm run dev` or `npm run app`.
  Agents use the engineer's own CLI credentials; the blast radius is one
  laptop and branches on repos they already have write access to.
- **Shared team box.** Run `npm run build && npm start` behind a reverse
  proxy that terminates TLS. Give the box a dedicated bot git identity with
  write access only to non-protected branches. Point projects at bare-ish
  clones owned by the service user.
- **What Deem deliberately is NOT (yet).** A multi-tenant SaaS serving
  millions of *Deem* users. That is a different system: Postgres for state,
  a job queue (or Temporal) for runs, isolated runner VMs/containers per
  tenant, org-level RBAC. The seams for that split are documented in
  ARCHITECTURE §18 — the workflow engine and adapters port unchanged; the
  store and the run scheduler are what get replaced.

## Pre-flight checklist for a production repo

1. Project → repo path points at a **clone you can afford to grow branches
   in** (Deem creates `task/*` branches; it never deletes or force-pushes).
2. Permission mode is `restricted` (default).
3. Base branch is set to your integration branch (`main`/`develop`).
4. Protected-branch rules live in your git host — Deem doesn't push, but
   humans merging Deem branches still go through your normal PR gates.
5. Add project **skills** for your house rules (lint config, no new deps
   without approval, i18n requirements) — they are injected into every
   phase prompt.
6. Put your real test/build commands into the test plans (or let the agent
   propose them) — the harness runs them and blocks on failures.
7. Watch `GET /api/health` and the audit log from your normal monitoring.
