import { Page, Locator } from '@playwright/test';
export class SettingsModal {
  constructor(private page: Page) {}
  heading(): Locator { return this.page.getByRole('heading', { name: 'Integrations & budgets' }); }
  budgetInput(): Locator { return this.page.getByLabel('Default token budget per task'); }
  async setBudget(value: number): Promise<void> {
    await this.budgetInput().fill(String(value));
    await this.page.getByRole('button', { name: 'Save settings' }).click();
  }
}
