import { Page } from '@playwright/test';

// The persistent top bar shown on every authenticated screen.
export class AppShell {
  constructor(private page: Page) {}

  openSettings(): Promise<void> {
    // exact:true so it never matches "Update settings" / "Save settings".
    return this.page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
}
