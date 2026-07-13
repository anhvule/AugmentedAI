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

  // Create a project pointed at the isolated throwaway git repo.
  //
  // NOTE: inlined instead of calling HomePage.createProject() (Task 1, not
  // modified here). Against the real app, that method's
  // `getByLabel('Agent').selectOption(...)` is a strict-mode violation: the
  // "Local repository path" field's trailing hint text ("The agent runs
  // inside this directory...") is nested inside the same <label>, so its
  // computed accessible name contains the substring "agent" and collides
  // with a plain getByLabel('Agent') lookup. Scoping to
  // getByRole('combobox', { name: 'Agent' }) selects only the real <select>
  // and sidesteps the collision without touching the Task 1 page object.
  await window.getByRole('button', { name: 'Add New Project' }).click();
  await window.getByLabel('Project name').fill('Q3 Marketing Launch');
  await window.getByLabel('Description').fill('E2E-created project');
  await window.getByLabel('Local repository path').fill(tmpRepo);
  await window.getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'Mock runner (no API cost)' });
  await window.getByRole('button', { name: 'Create project' }).click();
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
