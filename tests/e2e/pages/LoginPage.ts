import { Page } from '@playwright/test';

// No data-testid attributes exist; fields are wrapped <label> elements, so
// getByLabel resolves them by their visible text.
export class LoginPage {
  constructor(private page: Page) {}

  async register(name: string, email: string, password: string): Promise<void> {
    // The form defaults to "Sign in"; switch to the create-account tab first.
    // exact:true so it doesn't also match the "Create account & enter" submit.
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click();
    await this.page.getByLabel('Name').fill(name);
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Create account & enter' }).click();
  }
}
