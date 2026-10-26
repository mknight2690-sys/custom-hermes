// Custom Hermes Trading: all signed BloFin calls run here (main process). Secrets never logged.
const {ipcMain,dialog,safeStorage,app}=require('electron');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const BASE={demo:'https://demo-trading-openapi.blofin.com',live:'https://openapi.blofin.com'};
const MOCK=!!process.env.CUSTOM_HERMES_MOCK;
const credFile=()=>path.join(app.getPath('userData'),'blofin.cred');
const prefFile=()=>path.join(app.getPath('userData'),'trading.json');
let creds=null; // {apiKey,secret,passphrase,mode}

function parseCredText(text){ // tolerant: JSON, key=value, "Label: value", .env, or 3 bare lines
  const out={};const t=String(text||'').replace(/^\uFEFF/,'');
  const assign=(k,v)=>{v=String(v||'').trim().replace(/^["'`]|["'`],?$/g,'').trim();if(!v)return;k=String(k).toLowerCase().replace(/[^a-z]/g,'');
    if(/pass(phrase|word)?/.test(k)){out.passphrase??=v}
    else if(/secret|private|apisecret|secretkey/.test(k)){out.secret??=v}
    else if(/(api)?key|access|apikey|keyname/.test(k)){out.apiKey??=v}
    else if(/mode|env|demo|live/.test(k)){if(/demo|test|paper|sandbox/i.test(v))out.mode='demo';else if(/live|real|prod|main/i.test(v))out.mode='live'}};
  try{const j=JSON.parse(t);const walk=o=>{for(const[k,v]of Object.entries(o||{})){if(v&&typeof v==='object')walk(v);else assign(k,v)}};walk(j);}catch(e){
    const bare=[];for(let line of t.split(/\r?\n/)){line=line.trim().replace(/^export\s+/,'');if(!line||/^#|^\/\//.test(line))continue;
      const m=line.match(/^([A-Za-z _\-.]{2,40}?)\s*[:=]\s*(.+)$/);if(m)assign(m[1],m[2]);else if(!/\s/.test(line))bare.push(line);}
    if(!out.apiKey&&bare[0])out.apiKey=bare[0];if(!out.secret&&bare[1])out.secret=bare[1];if(!out.passphrase&&bare[2])out.passphrase=bare[2];}
  return out;}

function loadCreds(){try{if(!fs.existsSync(credFile()))return null;const buf=fs.readFileSync(credFile());return JSON.parse(safeStorage.decryptString(buf))}catch(e){return null}}
function saveCreds(c){if(!safeStorage.isEncryptionAvailable())throw new Error('OS encryption (DPAPI) unavailable; not saving');fs.writeFileSync(credFile(),safeStorage.encryptString(JSON.stringify(c)));}
const mask=s=>s?('•'.repeat(Math.max(0,Math.min(8,s.length-4)))+s.slice(-4)):'';

async function signed(method,p,query,body){
  if(!creds||!creds.apiKey||!creds.secret||!creds.passphrase)throw new Error('No credentials saved');
  const qs=query?'?'+new URLSearchParams(query).toString():'';const b=body?JSON.stringify(body):'';
  const ts=String(Date.now()),nonce=crypto.randomUUID();
  const pre=p+qs+method+ts+nonce+b;
  const sign=Buffer.from(crypto.createHmac('sha256',creds.secret).update(pre).digest('hex')).toString('base64');
  const r=await fetch(BASE[creds.mode||'demo']+p+qs,{method,headers:{'ACCESS-KEY':creds.apiKey,'ACCESS-SIGN':sign,'ACCESS-TIMESTAMP':ts,'ACCESS-NONCE':nonce,'ACCESS-PASSPHRASE':creds.passphrase,'Content-Type':'application/json'},body:b||undefined,signal:AbortSignal.timeout(12000)});
  const j=await r.json().catch(()=>({code:String(r.status),msg:'HTTP '+r.status}));
  if(String(j.code)!=='0')throw new Error('BloFin '+j.code+': '+(j.msg||'error'));return j.data;}
async function pub(p,query){const base=BASE[(creds&&creds.mode)||'live'];const r=await fetch(base+p+'?'+new URLSearchParams(query||{}),{signal:AbortSignal.timeout(12000)});const j=await r.json();if(String(j.code)!=='0')throw new Error(j.msg||'public error');return j.data;}

// ---- mock data for hidden-window tests ----
let mockPos=[{instId:'BTC-USDT',positionSide:'net',positions:'0.5',averagePrice:'67000',markPrice:'67450',unrealizedPnl:'2.25',leverage:'5',marginMode:'isolated',margin:'6.7',tp:'68800',sl:'66400'}];
const mock={balance:{totalEquity:'48.62',isolatedEquity:'12.10',details:[{currency:'USDT',equity:'48.62',available:'36.52',frozen:'0',isolatedEquity:'12.10',isolatedUnrealizedPnl:'2.25'}]},
 orders:[{orderId:'9001',instId:'ETH-USDT',side:'buy',orderType:'limit',price:'3150',size:'0.3',leverage:'5'}],
 tpsl:[{tpslId:'7001',instId:'BTC-USDT',side:'sell',tpTriggerPrice:'68800',slTriggerPrice:'66400',size:'-1'}]};

function register(){
  creds=loadCreds();
  ipcMain.handle('tr:parse-file',async(e)=>{const w=require('electron').BrowserWindow.fromWebContents(e.sender);
    const {canceled,filePaths}=process.env.CUSTOM_HERMES_TESTFILE?{canceled:false,filePaths:[process.env.CUSTOM_HERMES_TESTFILE]}:await dialog.showOpenDialog(w,{title:'Select BloFin API file',properties:['openFile'],filters:[{name:'Credential files',extensions:['txt','env','json','yaml','yml','md']},{name:'All files',extensions:['*']}]});
    if(canceled||!filePaths[0])return {ok:false,cancelled:true};
    try{const st=fs.statSync(filePaths[0]);if(st.size>256*1024)return {ok:false,error:'File too large for a key file'};
      const p=parseCredText(fs.readFileSync(filePaths[0],'utf8'));const found=['apiKey','secret','passphrase','mode'].filter(k=>p[k]);
      return {ok:found.length>0,fields:p,found,file:path.basename(filePaths[0]),error:found.length?null:'No API key, secret or passphrase found'};}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:status',()=>({saved:!!creds,mode:creds?.mode||'demo',keyMask:mask(creds?.apiKey),mock:MOCK,encryption:safeStorage.isEncryptionAvailable()}));
  ipcMain.handle('tr:save',(e,c)=>{const n={apiKey:String(c.apiKey||'').trim()||creds?.apiKey,secret:String(c.secret||'').trim()||creds?.secret,passphrase:String(c.passphrase||'').trim()||creds?.passphrase,mode:c.mode==='live'?'live':'demo'};
    if(!n.apiKey||!n.secret||!n.passphrase)return {ok:false,error:'API key, secret and passphrase are all required'};
    try{saveCreds(n);creds=n;return {ok:true,keyMask:mask(n.apiKey)}}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:forget',()=>{try{fs.unlinkSync(credFile())}catch(e){}creds=null;return {ok:true}});
  ipcMain.handle('tr:prefs',(e,p)=>{let cur={};try{cur=JSON.parse(fs.readFileSync(prefFile(),'utf8'))}catch(x){}if(p){cur={...cur,...p};fs.writeFileSync(prefFile(),JSON.stringify(cur))}return cur;});
  const wrap=f=>async(e,...a)=>{try{return {ok:true,data:await f(...a)}}catch(err){return {ok:false,error:err.message}}};
  ipcMain.handle('tr:test',wrap(async()=>{if(MOCK)return mock.balance;return await signed('GET','/api/v1/account/balance')}));
  ipcMain.handle('tr:snapshot',wrap(async()=>{if(MOCK)return {balance:mock.balance,positions:mockPos,orders:mock.orders,tpsl:mock.tpsl};
    const [balance,positions,orders,tpsl]=await Promise.all([signed('GET','/api/v1/account/balance'),signed('GET','/api/v1/account/positions'),signed('GET','/api/v1/trade/orders-pending'),signed('GET','/api/v1/trade/orders-tpsl-pending')]);
    return {balance,positions,orders,tpsl};}));
  ipcMain.handle('tr:mock-positions',(e,list)=>{if(MOCK)mockPos=list;return MOCK;});
  ipcMain.handle('tr:instruments',wrap(async()=>pub('/api/v1/market/instruments',{})));
  ipcMain.handle('tr:tickers',wrap(async()=>pub('/api/v1/market/tickers',{})));
  ipcMain.handle('tr:candles',wrap(async(instId,bar)=>pub('/api/v1/market/candles',{instId,bar,limit:'300'})));
  const guard=()=>{if(MOCK)throw new Error('Mock mode: no orders are sent');};
  ipcMain.handle('tr:order',wrap(async(o)=>{guard();
    if(!o.slTriggerPrice)throw new Error('Stop loss is mandatory');
    await signed('POST','/api/v1/account/set-leverage',null,{instId:o.instId,leverage:String(o.leverage),marginMode:'isolated'});
    const body={instId:o.instId,marginMode:'isolated',positionSide:'net',side:o.side,orderType:o.orderType,size:String(o.size),slTriggerPrice:String(o.slTriggerPrice),slOrderPrice:'-1'};
    if(o.orderType==='limit')body.price=String(o.price);if(o.tpTriggerPrice){body.tpTriggerPrice=String(o.tpTriggerPrice);body.tpOrderPrice='-1';}
    return await signed('POST','/api/v1/trade/order',null,body);}));
  ipcMain.handle('tr:set-tpsl',wrap(async(o)=>{guard();const body={instId:o.instId,marginMode:'isolated',positionSide:'net',side:o.side,size:'-1'};
    if(o.tp){body.tpTriggerPrice=String(o.tp);body.tpOrderPrice='-1'}if(o.sl){body.slTriggerPrice=String(o.sl);body.slOrderPrice='-1'}return await signed('POST','/api/v1/trade/order-tpsl',null,body);}));
  ipcMain.handle('tr:cancel',wrap(async(o)=>{guard();return o.tpslId?await signed('POST','/api/v1/trade/cancel-tpsl',null,[{instId:o.instId,tpslId:o.tpslId}]):await signed('POST','/api/v1/trade/cancel-order',null,{orderId:o.orderId});}));
  ipcMain.handle('tr:close',wrap(async(o)=>{guard();return await signed('POST','/api/v1/trade/close-position',null,{instId:o.instId,marginMode:o.marginMode||'isolated',positionSide:o.positionSide||'net'});}));
}
module.exports={register,parseCredText};
