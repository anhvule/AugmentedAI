// Deem desktop shell: boots the API server (which also serves the built UI)
// inside Electron's main process, then opens the app window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const PORT = process.env.DEEM_PORT || 4517;

async function start() {
  const dist = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('dist/ not found — run `npm run build` first (or use `npm run app`).');
    app.quit();
    return;
  }

  process.env.DEEM_PORT = String(PORT);
  await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href);

  const win = new BrowserWindow({
    width: 1400,
    height: 920,
    title: 'Deem',
    backgroundColor: '#f4eee2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true },
  });

  // External links (exports open in new tabs) go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${PORT}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
