const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');

app.setName('CONTINUELESS');
app.setAppUserModelId('com.thilankalhara.continueless');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let apiServer;
  let mainWindow;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  async function createWindow(serverPort) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 620,
      backgroundColor: '#f2f4ef',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }

  app.whenReady().then(async () => {
    process.env.CONTINUELESS_DATA_DIR = app.getPath('userData');
    const { startServer } = await import('../dist-server/server/index.js');
    apiServer = await startServer({
      port: 0,
      webRoot: path.resolve(__dirname, '..', 'dist'),
    });

    const address = apiServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('The local CONTINUELESS server did not return a network address.');
    }
    await createWindow(address.port);
  }).catch(error => {
    dialog.showErrorBox('CONTINUELESS could not start', error instanceof Error ? error.message : String(error));
    app.quit();
  });

  app.on('activate', () => {
    if (mainWindow || !apiServer) return;
    const address = apiServer.address();
    if (address && typeof address !== 'string') {
      void createWindow(address.port).catch(error => {
        dialog.showErrorBox('CONTINUELESS could not open', error instanceof Error ? error.message : String(error));
      });
    }
  });

  app.on('before-quit', () => {
    apiServer?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
