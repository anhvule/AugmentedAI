import { Page, Locator } from '@playwright/test';

export class HomePage {
  constructor(private page: Page) {}

  dashboardHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Operational Dashboard' });
  }

  // Opens "Add New Project", fills it, submits. Navigates to /projects/:id.
  async createProject(opts: {
    name: string;
    description?: string;
    repoPath: string;
  }): Promise<void> {
    await this.page.getByRole('button', { name: 'Add New Project' }).click();
    await this.page.getByLabel('Project name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    await this.page.getByLabel('Local repository path').fill(opts.repoPath);
    await this.page.getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'Mock runner (no API cost)' });
    await this.page.getByRole('button', { name: 'Create project' }).click();
  }
}
