import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { AppShell } from '../pages/AppShell';
import { SettingsModal } from '../pages/SettingsModal';

test('Flow 3a: settings budget persists across reopen', async ({ window }) => {
  const login = new LoginPage(window);
  const shell = new AppShell(window);
  const settings = new SettingsModal(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');

  await shell.openSettings();
  await expect(settings.heading()).toBeVisible();
  await settings.setBudget(250000);

  // Save closes the overlay after a short confirmation.
  await expect(settings.heading()).toBeHidden();

  // Reopen — the overlay refetches /api/settings, proving the value persisted.
  await shell.openSettings();
  await expect(settings.budgetInput()).toHaveValue('250000');
});

test('Flow 3b: export opens a new Electron window at the export URL', async ({
  app,
  window,
  tmpRepo,
}) => {
  const login = new LoginPage(window);
  const home = new HomePage(window);
  const project = new ProjectPage(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await home.createProject({ name: 'Export Proj', repoPath: tmpRepo });
  await expect(project.heading('Export Proj')).toBeVisible();
  await project.createTask({ name: 'Exportable task' });
  await expect(window.getByRole('heading', { name: 'Exportable task' })).toBeVisible();

  // "Export Task.md" calls window.open('/api/tasks/:id/export/task', '_blank'),
  // which main.cjs's setWindowOpenHandler allows (localhost) → Electron
  // creates a new BrowserWindow for it. We assert on two independent
  // signals: Electron's own main-process 'browser-window-created' event
  // (observed via app.evaluate, since it runs inside the main process)
  // proves the allow-handler actually created a new BrowserWindow — as
  // opposed to a same-window navigation — while the `response` event gives
  // a robust, ground-truth check of the export URL and status.
  //
  // We do NOT use app.waitForEvent('window') / assert on a popup Page here:
  // the export response carries `Content-Disposition: attachment`, so
  // Chromium/Electron aborts the navigation and treats it as a file download
  // before any frame commits. Verified empirically (via app.evaluate probes
  // and a main-process debug listener) that no CDP page target is ever
  // created for this window in that case, so Playwright never surfaces it
  // as a trackable Page — `app.waitForEvent('window')` (and the underlying
  // `context().on('page')`) times out deterministically, even though the
  // BrowserWindow really was created. The 'browser-window-created' app
  // event fires regardless, since it's raised by Electron itself the
  // moment the allow-handler's window is constructed, not by Playwright's
  // page-tracking layer.
  const [, response] = await Promise.all([
    app.evaluate(
      ({ app: electronApp }) =>
        new Promise<void>((resolve) => {
          electronApp.once('browser-window-created', () => resolve());
        })
    ),
    app.context().waitForEvent('response', (r) => r.url().includes('/export/task')),
    window.getByRole('button', { name: 'Export Task.md' }).click(),
  ]);
  expect(response.url()).toContain('/api/tasks/');
  expect(response.url()).toContain('/export/task');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain('Task.md');
});
