import { Page } from '@playwright/test';

export class LoginPage {
  constructor(private page: Page) {}
  async register(name: string, email: string, password: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Create account', exact: true }).click();
    await this.page.getByLabel('Name').fill(name);
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Create account & enter' }).click();
  }
}
