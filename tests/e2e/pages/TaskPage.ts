import { Page, Locator } from '@playwright/test';

// The task-detail screen (/tasks/:id).
export class TaskPage {
  constructor(private page: Page) {}

  heading(name: string): Locator {
    return this.page.getByRole('heading', { name });
  }

  backToProjectLink(): Locator {
    return this.page.getByRole('link', { name: 'Back to Project' });
  }

  exportTaskButton(): Locator {
    return this.page.getByRole('button', { name: 'Export Task.md' });
  }
}
