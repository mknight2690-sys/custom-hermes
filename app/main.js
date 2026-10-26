const {app,BrowserWindow,Tray,Menu,nativeImage,ipcMain}=require('electron');
const net=require('net');const {exec}=require('child_process');const fs=require('fs');const path=require('path');
const TEST=!!process.env.CUSTOM_HERMES_TEST;if(TEST)app.setPath('userData',path.join(require('os').tmpdir(),'custom-hermes-test'));
if(process.env.CUSTOM_HERMES_DEBUG||TEST)app.commandLine.appendSwitch('remote-debugging-port',TEST?'9230':'9229');

// one-time migration of userData from the old "Grok Replica" app
try{if(!TEST){const nu=app.getPath('userData'),old=path.join(app.getPath('appData'),'Grok Replica');const flag=path.join(nu,'.migrated');
 if(fs.existsSync(old)&&!fs.existsSync(flag)){fs.cpSync(old,nu,{recursive:true,force:false,errorOnExist:false,filter:s=>!/(Cache|GPUCache|Code Cache|DawnCache|Crashpad|SingletonLock|lockfile)$/i.test(s)});fs.writeFileSync(flag,new Date().toISOString());}}}catch(e){}
if(!app.requestSingleInstanceLock()){app.quit();}
let win,tray,quitting=false;
const up=p=>new Promise(r=>{const s=net.connect(p,'127.0.0.1');s.on('connect',()=>{s.end();r(true)});s.on('error',()=>r(false));setTimeout(()=>{s.destroy();r(false)},1500)});
let lastKick=0;const logf=path.join(app.getPath('userData'),'app.log');const L=t=>{try{fs.appendFileSync(logf,new Date().toISOString()+' '+t+'\n')}catch(e){}};
async function ensure(){const a=await up(9120),b=await up(8788);if(a&&b)return {ok:true};
 if(Date.now()-lastKick>60000){lastKick=Date.now();L('services down 9120='+a+' 8788='+b+'; running task');exec('schtasks /Run /TN CustomHermes',{windowsHide:true});}
 for(let i=0;i<30;i++){if(await up(9120))return {ok:true};await new Promise(r=>setTimeout(r,1000));}
 L('timeout waiting for 9120');return {ok:false,why:'Dashboard on port 9120 did not respond within 30s'+(await up(8788)?'':' (autoselector 8788 is also down)')+'.'};}
const ic=f=>{const a=path.join(process.resourcesPath,'icons',f),b=path.join(__dirname,'build',f);return fs.existsSync(a)?a:b};
const icon=nativeImage.createFromPath(ic('icon.ico'));const trayIcon=nativeImage.createFromPath(ic('tray.ico')).isEmpty()?nativeImage.createFromPath(ic('tray32.png')):nativeImage.createFromPath(ic('tray.ico'));
function create(){win=new BrowserWindow({width:1400,height:900,minWidth:900,minHeight:600,frame:false,show:!TEST,backgroundColor:'#0b0d12',icon,
 webPreferences:{webviewTag:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
 win.loadFile(path.join(__dirname,'shell.html'));
 win.webContents.setBackgroundThrottling(false);win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});}
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
ipcMain.handle('ensure',ensure);let spk=null;ipcMain.handle('tr:speak',(e,t)=>{t=String(t).replace(/[^A-Za-z0-9 .,-]/g,'').slice(0,120);L('voice: '+t+(win&&!win.isVisible()?' (hidden)':''));if(TEST)return true;
 return new Promise(r=>{try{spk=require('child_process').spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Rate=1;$s.Speak('"+t+"')"],{windowsHide:true});const k=setTimeout(()=>{try{spk.kill()}catch(e){}},15000);spk.on('exit',()=>{clearTimeout(k);spk=null;r(true)});spk.on('error',()=>{clearTimeout(k);r(false)})}catch(e){r(false)}})});
ipcMain.on('tr:speakstop',()=>{try{spk&&spk.kill()}catch(e){}});
ipcMain.on('log',(e,t)=>L('renderer: '+t));
ipcMain.handle('css',()=>fs.readFileSync(path.join(__dirname,'theme.css'),'utf8'));
ipcMain.on('win',(e,a)=>{if(a==='min')win.minimize();else if(a==='max')win.isMaximized()?win.unmaximize():win.maximize();else win.hide();});
ipcMain.handle('login',(e,v)=>{if(v!==undefined)app.setLoginItemSettings({openAtLogin:v});return app.getLoginItemSettings().openAtLogin;});
app.whenReady().then(()=>{L('start v'+app.getVersion()+(TEST?' TEST':''));require('./tradingMain').register();create();if(TEST)return;tray=new Tray(trayIcon);if(process.env.CUSTOM_HERMES_DEBUG)fs.writeFileSync(path.join(app.getPath('temp'),'hermes-tray.txt'),'tray empty='+trayIcon.isEmpty()+' size='+JSON.stringify(trayIcon.getSize()));tray.setToolTip('Custom Hermes');
 tray.setContextMenu(Menu.buildFromTemplate([{label:'Open',click:()=>win.show()},{label:'Restart services',click:()=>exec('schtasks /Run /TN CustomHermes',{windowsHide:true})},{type:'separator'},{label:'Quit',click:()=>{quitting=true;app.quit();}}]));
 tray.on('click',()=>win.show());});
app.on('window-all-closed',()=>{});
