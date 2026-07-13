import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { TaskPage } from '../pages/TaskPage';
import { AppShell } from '../pages/AppShell';
import { SettingsModal } from '../pages/SettingsModal';
import { makeTempRepo, cleanupDir } from '../fixtures/temp-repo';

test('Flow 3a: settings budget persists across reopen', async ({ page }) => {
  const login = new LoginPage(page);
  const shell = new AppShell(page);
  const settings = new SettingsModal(page);
  await page.goto('/');
  // A unique email per spec/test — the webServer (and its DEEM_DATA_DIR) is
  // shared across the whole suite, so reusing an earlier flow's email would 400.
  await login.register('Aiko Sato', 'aiko.flow3a@example.com', 'secret123');
  await shell.openSettings();
  await expect(settings.heading()).toBeVisible();
  await settings.setBudget(250000);
  await expect(settings.heading()).toBeHidden();
  await shell.openSettings();
  await expect(settings.budgetInput()).toHaveValue('250000');
});

test('Flow 3b: export opens a new browser tab at the export URL', async ({ page, context }) => {
  const repo = makeTempRepo();
  try {
    const login = new LoginPage(page);
    const home = new HomePage(page);
    const project = new ProjectPage(page);
    const taskPage = new TaskPage(page);
    await page.goto('/');
    await login.register('Aiko Sato', 'aiko.flow3b@example.com', 'secret123');
    await home.createProject({ name: 'Export Proj', repoPath: repo });
    await expect(project.heading('Export Proj')).toBeVisible();
    await project.createTask({ name: 'Exportable task' });
    await expect(taskPage.heading('Exportable task')).toBeVisible();
    // window.open('/api/tasks/:id/export/task','_blank') opens a new tab. The
    // response carries `Content-Disposition: attachment`, so the popup is a
    // download that may never commit a navigable URL — popup.url() is
    // unreliable. Instead assert on two events that together prove the export
    // fired: a new tab was opened, and its network response is the export
    // endpoint with an attachment header. `context.waitForEvent('response', ...)`
    // observes responses across *all* pages in the context (including the
    // popup), so there's no race between the popup opening and the request
    // resolving.
    const [popup, response] = await Promise.all([
      context.waitForEvent('page'),
      context.waitForEvent('response', (res) => res.url().includes('/export/task')),
      taskPage.exportTaskButton().click(),
    ]);
    expect(response.url()).toContain('/api/tasks/');
    expect(response.url()).toContain('/export/task');
    expect(response.headers()['content-disposition'] || '').toContain('attachment');
    await popup.close().catch(() => {});
  } finally {
    cleanupDir(repo);
  }
});
