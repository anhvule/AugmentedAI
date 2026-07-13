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
  // which main.cjs's setWindowOpenHandler allows (localhost) → Electron opens
  // a new BrowserWindow for it. That response carries
  // `Content-Disposition: attachment`, so Chromium/Electron treats it as a
  // file download rather than a page navigation: the transient window never
  // commits a navigation (its `url()` stays blank) and is torn down again
  // almost immediately, which makes `app.waitForEvent('window')` + asserting
  // on `popup.url()` unreliable/flaky in practice. The one dependable,
  // ground-truth signal is the underlying HTTP response, visible on the
  // shared Electron BrowserContext regardless of which (possibly
  // short-lived) page issued the request — so we assert on that instead.
  const [response] = await Promise.all([
    app.context().waitForEvent('response', (r) => r.url().includes('/export/task')),
    window.getByRole('button', { name: 'Export Task.md' }).click(),
  ]);
  expect(response.url()).toContain('/api/tasks/');
  expect(response.url()).toContain('/export/task');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain('Task.md');
});
