import { test, expect } from '../fixtures/electron';
import { LoginPage } from '../pages/LoginPage';
import { HomePage } from '../pages/HomePage';

test.describe('Flow 1: launch & initial state', () => {
  test('opens a single window titled "Deem"', async ({ app, window }) => {
    expect(await window.title()).toBe('Deem');
    expect(app.windows().length).toBe(1);
  });

  test('shows the dashboard after registering', async ({ window }) => {
    const login = new LoginPage(window);
    const home = new HomePage(window);
    await login.register('Aiko Sato', 'aiko@example.com', 'secret123');
    await expect(home.dashboardHeading()).toBeVisible();
    await expect(window.getByText('Running now')).toBeVisible();
  });
});
