import { Page, Locator } from '@playwright/test';
export class ProjectPage {
  constructor(private page: Page) {}
  heading(name: string): Locator { return this.page.getByRole('heading', { name }); }
  async createTask(opts: { name: string; description?: string; requirements?: string[] }): Promise<void> {
    await this.page.getByRole('button', { name: '+ New Task' }).click();
    await this.page.getByLabel('Task name').fill(opts.name);
    if (opts.description) await this.page.getByLabel('Description').fill(opts.description);
    if (opts.requirements?.length) await this.page.getByLabel('Requirements').fill(opts.requirements.join('\n'));
    await this.page.getByRole('button', { name: 'Create task' }).click();
  }
}
