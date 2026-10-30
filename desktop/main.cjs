const { app, BrowserWindow, protocol, session, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { resolveAsset } = require('./asset-policy.cjs');
const gameRoot = path.join(__dirname,'game');
app.setName('KartBLitz');
protocol.registerSchemesAsPrivileged([{scheme:'kbapp',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const externalHosts = new Set(['github.com','leaferd6712.github.io']);
function openExternal(url) { try { const parsed=new URL(url); if(parsed.protocol==='https:' && externalHosts.has(parsed.hostname)) return shell.openExternal(parsed.href); } catch {} }
async function createWindow() {
  const manifest = JSON.parse(await fs.readFile(path.join(gameRoot,'core/game-manifest.json'),'utf8'));
  const assets = JSON.parse(await fs.readFile(path.join(gameRoot,'asset-manifest.json'),'utf8'));
  const allowed = new Set([...assets.files,'asset-manifest.json']);
  if(!protocol.isProtocolHandled || !(await protocol.isProtocolHandled('kbapp'))) protocol.handle('kbapp', async request => {
    try {
      if(!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
      const asset=resolveAsset(request.url,gameRoot,allowed);
      return new Response(request.method==='HEAD' ? null : await fs.readFile(asset.file), {headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff'}});
    } catch { return new Response('Not found',{status:404}); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  const win=new BrowserWindow({title:manifest.title,icon:path.join(gameRoot,'ui/app-icon.png'),backgroundColor:'#211c3b',...manifest.window,show:false,autoHideMenuBar:true,
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{const target=new URL(url);if(target.protocol!=='kbapp:'||target.hostname!=='game'){event.preventDefault();openExternal(url);}});
  win.once('ready-to-show',()=>{if(!process.argv.includes('--smoke-test'))win.show();});
  await win.loadURL('kbapp://game/' + manifest.entry);
}
Menu.setApplicationMenu(null);
app.whenReady().then(createWindow).catch(error=>{console.error(error);app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
