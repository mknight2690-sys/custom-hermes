const {app,BrowserWindow,Tray,Menu,nativeImage,ipcMain}=require('electron');
const net=require('net');const {exec}=require('child_process');const fs=require('fs');const path=require('path');
if(process.env.GROK_REPLICA_DEBUG)app.commandLine.appendSwitch('remote-debugging-port','9229');
if(!app.requestSingleInstanceLock()){app.quit();}
let win,tray,quitting=false;
const up=p=>new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.on('connect',()=>{s.end();r(true)});s.on('error',()=>r(false));setTimeout(()=>{s.destroy();r(false)},1500)});
async function ensure(){if(!(await up(9120))||!(await up(8788)))exec('schtasks /Run /TN GrokReplica',{windowsHide:true});
 for(let i=0;i<90;i++){if(await up(9120))return true;await new Promise(r=>setTimeout(r,1000));}return false;}
const ic=f=>{const a=path.join(process.resourcesPath,'icons',f),b=path.join(__dirname,'build',f);return fs.existsSync(a)?a:b};
const icon=nativeImage.createFromPath(ic('icon.ico'));const trayIcon=nativeImage.createFromPath(ic('tray.ico')).isEmpty()?nativeImage.createFromPath(ic('tray32.png')):nativeImage.createFromPath(ic('tray.ico'));
function create(){win=new BrowserWindow({width:1400,height:900,minWidth:900,minHeight:600,frame:false,backgroundColor:'#0b0d12',icon,
 webPreferences:{webviewTag:true,nodeIntegration:true,contextIsolation:false}});
 win.loadFile(path.join(__dirname,'shell.html'));
 win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});}
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
ipcMain.handle('ensure',ensure);
ipcMain.handle('css',()=>fs.readFileSync(path.join(__dirname,'theme.css'),'utf8'));
ipcMain.on('win',(e,a)=>{if(a==='min')win.minimize();else if(a==='max')win.isMaximized()?win.unmaximize():win.maximize();else win.hide();});
ipcMain.handle('login',(e,v)=>{if(v!==undefined)app.setLoginItemSettings({openAtLogin:v});return app.getLoginItemSettings().openAtLogin;});
app.whenReady().then(()=>{create();tray=new Tray(trayIcon);if(process.env.GROK_REPLICA_DEBUG)fs.writeFileSync(path.join(app.getPath('temp'),'grok-tray.txt'),'tray empty='+trayIcon.isEmpty()+' size='+JSON.stringify(trayIcon.getSize()));tray.setToolTip('Grok Replica');
 tray.setContextMenu(Menu.buildFromTemplate([{label:'Open',click:()=>win.show()},{label:'Restart services',click:()=>exec('schtasks /Run /TN GrokReplica',{windowsHide:true})},{type:'separator'},{label:'Quit',click:()=>{quitting=true;app.quit();}}]));
 tray.on('click',()=>win.show());});
app.on('window-all-closed',()=>{});
