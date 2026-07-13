# Deem E2E tests (Playwright + Electron)

End-to-end tests that launch the real Deem desktop app via Playwright's
`_electron` API, in full isolation from your real workspace.

## Install

```bash
npm install            # includes @playwright/test (devDependency)
```

No browser download is needed — the tests drive the Electron that's already a
project devDependency.

## Run

```bash
npm run test:e2e                                   # all flows
npm run test:e2e -- specs/02-project-and-task.spec.ts   # one flow
npm run test:e2e -- --headed                       # watch the window
```

The suite builds the web bundle once (`npm run build`) in global setup, then
runs serially (`workers: 1`) because the app binds one port and one JSON store.

## Isolation

Each test launches Electron with:
- `DEEM_DATA_DIR` → a fresh temp dir (no profile ⇒ starts at registration),
- `DEEM_PORT=4599`,
and creates projects against a throwaway `git init` repo. Nothing touches your
real `data/deem.json`. Temp dirs and the app are torn down after every test.

## Layout

- `fixtures/electron.ts` — launch/teardown + isolation fixtures.
- `fixtures/temp-repo.ts` — throwaway git repo helper.
- `pages/` — Page Object Model (role/text/label selectors; no `data-testid`).
- `specs/` — one file per user flow.
