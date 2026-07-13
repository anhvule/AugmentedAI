import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';

test('Flow 1: title and dashboard after registering', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Deem');
  const login = new LoginPage(page);
  const home = new HomePage(page);
  await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
  await expect(home.dashboardHeading()).toBeVisible();
  await expect(page.getByText('Running now')).toBeVisible();
});
