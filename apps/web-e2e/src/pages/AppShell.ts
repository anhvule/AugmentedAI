import { Page } from '@playwright/test';
export class AppShell {
  constructor(private page: Page) {}
  openSettings(): Promise<void> {
    return this.page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
}
