import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';
import { TaskPage } from '../pages/TaskPage';
import { makeTempRepo, cleanupDir } from '../fixtures/temp-repo';

test('Flow 2: create a project and a task', async ({ page }) => {
  const repo = makeTempRepo();
  try {
    const login = new LoginPage(page);
    const home = new HomePage(page);
    const project = new ProjectPage(page);
    const taskPage = new TaskPage(page);
    await page.goto('/');
    // A unique email per spec — the webServer (and its DEEM_DATA_DIR) is shared
    // across the whole suite, so re-registering the Flow-1 email here would 400.
    await login.register('Aiko Sato', 'aiko.flow2@example.com', 'secret123');
    await expect(home.dashboardHeading()).toBeVisible();
    await home.createProject({ name: 'Q3 Marketing Launch', description: 'E2E', repoPath: repo });
    await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
    await project.createTask({ name: 'Wire up landing page', requirements: ['User can submit the form'] });
    await expect(taskPage.heading('Wire up landing page')).toBeVisible();
    await expect(taskPage.backToProjectLink()).toBeVisible();
    await taskPage.backToProjectLink().click();
    await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
    await expect(page.getByText('Wire up landing page')).toBeVisible();
  } finally {
    cleanupDir(repo);
  }
});
