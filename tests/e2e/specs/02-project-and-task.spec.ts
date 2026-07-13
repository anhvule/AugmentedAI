import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';
import { ProjectPage } from '../pages/ProjectPage';

test('Flow 2: create a project and a task', async ({ window, tmpRepo }) => {
  const login = new LoginPage(window);
  const home = new HomePage(window);
  const project = new ProjectPage(window);

  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await expect(home.dashboardHeading()).toBeVisible();

  // Create a project pointed at the isolated throwaway git repo, driven
  // through the HomePage POM (HomePage.createProject uses
  // getByRole('combobox', { name: 'Agent' }) to avoid colliding with the
  // "Local repository path" field's hint text, which contains "agent").
  await home.createProject({ name: 'Q3 Marketing Launch', description: 'E2E-created project', repoPath: tmpRepo });
  // On success the app routes to the project page (renders the project name).
  await expect(project.heading('Q3 Marketing Launch')).toBeVisible();

  // Create a task; the app then routes to the task detail page.
  await project.createTask({
    name: 'Wire up landing page',
    description: 'Build the campaign landing page',
    requirements: ['User can submit the signup form', 'Form validates email'],
  });
  // Task detail renders the task name as a heading + a Back to Project link.
  await expect(window.getByRole('heading', { name: 'Wire up landing page' })).toBeVisible();
  await expect(window.getByRole('link', { name: 'Back to Project' })).toBeVisible();

  // Back on the project page, the new task shows in the task list.
  await window.getByRole('link', { name: 'Back to Project' }).click();
  await expect(project.heading('Q3 Marketing Launch')).toBeVisible();
  await expect(window.getByText('Wire up landing page')).toBeVisible();
});
