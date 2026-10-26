// Custom Hermes Trading: signed calls for BloFin (B), and Coinbase (C) run here (main process).
// Secrets are never logged or sent back to the renderer. Each adapter normalizes to the BloFin data shape.
const {ipcMain,dialog,safeStorage,app,clipboard,nativeImage}=require('electron');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const MOCK=!!process.env.CUSTOM_HERMES_MOCK;const TESTRUN=!!process.env.CUSTOM_HERMES_TEST;const EXS=['b','c'];
const NAME={b:'BloFin',c:'Coinbase'};const CUR={b:'USDT',c:'USD'};
const FIELDS={b:['apiKey','secret','passphrase','mode'],c:['apiKey','secret']};
const credFile=ex=>path.join(app.getPath('userData'),{b:'blofin.cred',c:'coinbase.cred'}[ex]);
const prefFile=()=>path.join(app.getPath('userData'),'trading.json');
const creds={};const T=12000;
const ck=ex=>{if(!EXS.includes(ex))throw new Error('bad exchange');return ex};

// ---------- credential file parser ----------
function parseCredText(text,ex='b'){
  const out={};let t=String(text||'').replace(/^\uFEFF/,'');
  const pem=t.match(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/);
  const assign=(k,v)=>{v=String(v||'').trim().replace(/^["'`]|["'`],?$/g,'').trim();if(!v)return;k=String(k).toLowerCase().replace(/[^a-z]/g,'');
    if(/pass(phrase|word)?/.test(k)){out.passphrase??=v}
    else if(/secret|private/.test(k)){out.secret??=v}
    else if(/key|access|^name$|keyname|^id$|keyid/.test(k)){out.apiKey??=v}
    else if(/mode|env|demo|live/.test(k)){if(/demo|test|paper|sandbox/i.test(v))out.mode='demo';else if(/live|real|prod|main/i.test(v))out.mode='live'}};
  try{const j=JSON.parse(t);const walk=o=>{for(const[k,v]of Object.entries(o||{})){if(v&&typeof v==='object')walk(v);else assign(k,v)}};walk(j);}catch(e){
    if(pem){out.secret=pem[0];t=t.replace(pem[0],'');}
    const bare=[];for(let line of t.split(/\r?\n/)){line=line.trim().replace(/^export\s+/,'');if(!line||/^#|^\/\//.test(line))continue;
      const m=line.match(/^([A-Za-z _\-.]{2,40}?)\s*[:=]\s*(.+)$/);if(m)assign(m[1],m[2]);else if(!/\s/.test(line))bare.push(line);}
    if(!out.apiKey&&bare[0])out.apiKey=bare[0];if(!out.secret&&bare[1])out.secret=bare[1];if(ex==='b'&&!out.passphrase&&bare[2])out.passphrase=bare[2];}
  if(out.secret)out.secret=out.secret.replace(/\\n/g,'\n');
  if(ex==='c'){delete out.passphrase;delete out.mode;}
  return out;}

function loadCreds(ex){try{if(!fs.existsSync(credFile(ex)))return null;return JSON.parse(safeStorage.decryptString(fs.readFileSync(credFile(ex))))}catch(e){return null}}
function saveCreds(ex,c){if(!safeStorage.isEncryptionAvailable())throw new Error('OS encryption (DPAPI) unavailable; not saving');fs.writeFileSync(credFile(ex),safeStorage.encryptString(JSON.stringify(c)));}
const mask=s=>s?('•'.repeat(Math.max(0,Math.min(8,s.length-4)))+s.slice(-4)):'';
async function jget(url,opt={}){const r=await fetch(url,{...opt,signal:AbortSignal.timeout(T)});const tx=await r.text();let j;try{j=JSON.parse(tx)}catch(e){j={raw:tx.slice(0,120)}}
  if(!r.ok)throw new Error('HTTP '+r.status+': '+String(j.message||j.error||j.msg||j.error_response?.message||j.raw||'').slice(0,160));return j;}

// ---------- BloFin ----------
const BB={demo:'https://demo-trading-openapi.blofin.com',live:'https://openapi.blofin.com'};
async function bSigned(method,p,query,body){const c=creds.b;if(!c||!c.apiKey||!c.secret||!c.passphrase)throw new Error('No credentials saved');
  const qs=query?'?'+new URLSearchParams(query).toString():'';const b=body?JSON.stringify(body):'';const ts=String(Date.now()),nonce=crypto.randomUUID();
  const sign=Buffer.from(crypto.createHmac('sha256',c.secret).update(p+qs+method+ts+nonce+b).digest('hex')).toString('base64');
  const r=await fetch(BB[c.mode||'demo']+p+qs,{method,headers:{'ACCESS-KEY':c.apiKey,'ACCESS-SIGN':sign,'ACCESS-TIMESTAMP':ts,'ACCESS-NONCE':nonce,'ACCESS-PASSPHRASE':c.passphrase,'Content-Type':'application/json'},body:b||undefined,signal:AbortSignal.timeout(T)});
  const j=await r.json().catch(()=>({code:String(r.status),msg:'HTTP '+r.status}));if(String(j.code)!=='0')throw new Error('BloFin '+j.code+': '+(j.msg||'error'));return j.data;}
async function bPub(p,q){const j=await jget(BB[(creds.b&&creds.b.mode)||'live']+p+'?'+new URLSearchParams(q||{}));if(String(j.code)!=='0')throw new Error(j.msg||'public error');return j.data;}
const B={
  test:()=>bSigned('GET','/api/v1/account/balance'),
  async snapshot(){const [balance,positions,orders,tpsl]=await Promise.all([bSigned('GET','/api/v1/account/balance'),bSigned('GET','/api/v1/account/positions'),bSigned('GET','/api/v1/trade/orders-pending'),bSigned('GET','/api/v1/trade/orders-tpsl-pending')]);return {balance,positions,orders,tpsl};},
  instruments:()=>bPub('/api/v1/market/instruments',{}),
  candles:(instId,bar)=>bPub('/api/v1/market/candles',{instId,bar,limit:'300'}),
  async order(o){await bSigned('POST','/api/v1/account/set-leverage',null,{instId:o.instId,leverage:String(o.leverage),marginMode:'isolated'});
    const body={instId:o.instId,marginMode:'isolated',positionSide:'net',side:o.side,orderType:o.orderType,size:String(o.size),slTriggerPrice:String(o.slTriggerPrice),slOrderPrice:'-1'};
    if(o.orderType==='limit')body.price=String(o.price);if(o.tpTriggerPrice){body.tpTriggerPrice=String(o.tpTriggerPrice);body.tpOrderPrice='-1';}
    return bSigned('POST','/api/v1/trade/order',null,body);},
  setTpsl(o){const body={instId:o.instId,marginMode:'isolated',positionSide:'net',side:o.side,size:'-1'};if(o.tp){body.tpTriggerPrice=String(o.tp);body.tpOrderPrice='-1'}if(o.sl){body.slTriggerPrice=String(o.sl);body.slOrderPrice='-1'}return bSigned('POST','/api/v1/trade/order-tpsl',null,body);},
  cancel:o=>o.tpslId?bSigned('POST','/api/v1/trade/cancel-tpsl',null,[{instId:o.instId,tpslId:o.tpslId}]):bSigned('POST','/api/v1/trade/cancel-order',null,{orderId:o.orderId}),
  close:o=>bSigned('POST','/api/v1/trade/close-position',null,{instId:o.instId,marginMode:o.marginMode||'isolated',positionSide:o.positionSide||'net'})};

const CB='https://api.coinbase.com';
function fixPem(s){s=String(s).replace(/\\n/g,'\n').trim();if(/BEGIN/.test(s)&&!/\n/.test(s)){const m=s.match(/^(-----BEGIN [A-Z ]+-----)\s*(.+?)\s*(-----END [A-Z ]+-----)$/);if(m)s=m[1]+'\n'+m[2].replace(/\s+/g,'').match(/.{1,64}/g).join('\n')+'\n'+m[3];}return s;}
function cbKey(secret){let s=String(secret||'').trim();try{const j=JSON.parse(s);s=j.privateKey||j.private_key||j.secret||s}catch(e){}
  if(/BEGIN/.test(s))return {alg:'ES256',key:crypto.createPrivateKey(fixPem(s))};
  const raw=Buffer.from(s,'base64');if(raw.length===64){const b64u=x=>x.toString('base64url');return {alg:'EdDSA',key:crypto.createPrivateKey({key:{kty:'OKP',crv:'Ed25519',d:b64u(raw.subarray(0,32)),x:b64u(raw.subarray(32))},format:'jwk'})};}
  return null;}
function cbJwt(apiKey,secret,method,p){const k=cbKey(secret);if(!k)return null;const now=Math.floor(Date.now()/1000);const e=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const h=e({alg:k.alg,typ:'JWT',kid:apiKey,nonce:crypto.randomBytes(16).toString('hex')}),pl=e({sub:apiKey,iss:'cdp',nbf:now,exp:now+120,uri:method+' api.coinbase.com'+p.split('?')[0]});
  const data=Buffer.from(h+'.'+pl);const sig=k.alg==='ES256'?crypto.sign('sha256',data,{key:k.key,dsaEncoding:'ieee-p1363'}):crypto.sign(null,data,k.key);return h+'.'+pl+'.'+sig.toString('base64url');}
async function cReq(method,p,body){const c=creds.c;if(!c||!c.apiKey||!c.secret)throw new Error('No Coinbase key saved');const b=body?JSON.stringify(body):'';
  const jwt=cbJwt(c.apiKey,c.secret,method,p);let h;if(jwt)h={Authorization:'Bearer '+jwt};else{const ts=String(Math.floor(Date.now()/1000));h={'CB-ACCESS-KEY':c.apiKey,'CB-ACCESS-TIMESTAMP':ts,'CB-ACCESS-SIGN':crypto.createHmac('sha256',c.secret).update(ts+method+p.split('?')[0]+b).digest('hex')};}
  return jget(CB+p,{method,headers:{...h,'Content-Type':'application/json'},body:b||undefined});}
const cOk=r=>{if(r&&r.success===false)throw new Error(r.error_response?.message||r.error_response?.error||r.failure_reason||'Coinbase rejected');return r};
const cInst={};const cid=()=>crypto.randomUUID();
const C={
  test:()=>cReq('GET','/api/v3/brokerage/accounts?limit=250').then(j=>({accounts:(j.accounts||[]).length})),
  async snapshot(){const [acc,bs,pos,ord]=await Promise.all([cReq('GET','/api/v3/brokerage/accounts?limit=250'),cReq('GET','/api/v3/brokerage/cfm/balance_summary').catch(()=>null),cReq('GET','/api/v3/brokerage/cfm/positions').catch(()=>({positions:[]})),cReq('GET','/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100')]);
    const cash={USD:0,USDC:0};for(const a of acc.accounts||[])if(a.currency in cash)cash[a.currency]+=(+a.available_balance?.value||0)+(+a.hold?.value||0);
    const s=bs&&bs.balance_summary;const eq=s?+s.total_usd_balance?.value:cash.USD+cash.USDC;
    const orders=[],tp={};for(const o of ord.orders||[]){const cfg=o.order_configuration||{};const br=cfg.trigger_bracket_gtc||cfg.trigger_bracket_gtd;
      if(br){tp[o.product_id]??={tpslId:[],instId:o.product_id,tpTriggerPrice:'',slTriggerPrice:''};tp[o.product_id].tpslId.push(o.order_id);tp[o.product_id].tpTriggerPrice=br.limit_price;tp[o.product_id].slTriggerPrice=br.stop_trigger_price;continue;}
      const l=cfg.limit_limit_gtc||cfg.limit_limit_gtd||cfg.stop_limit_stop_limit_gtc||{};orders.push({orderId:o.order_id,instId:o.product_id,side:String(o.side).toLowerCase(),orderType:String(o.order_type||'').toLowerCase(),price:l.limit_price||o.average_filled_price,size:l.base_size||o.filled_size});}
    const tpsl=Object.values(tp).map(x=>({...x,tpslId:x.tpslId.join(',')}));
    const positions=(pos.positions||[]).filter(p=>+p.number_of_contracts).map(p=>{const sh=/SHORT/i.test(p.side);const q=Math.abs(+p.number_of_contracts);const t=tp[p.product_id]||{};
      return {instId:p.product_id,positionSide:sh?'short':'long',positions:String(sh?-q:q),averagePrice:p.avg_entry_price,markPrice:p.current_price,unrealizedPnl:p.unrealized_pnl,leverage:p.leverage||'',marginMode:p.margin_type||'',tp:t.tpTriggerPrice||'',sl:t.slTriggerPrice||''}});
    return {balance:{totalEquity:String(eq),details:[{currency:'USD',equity:String(eq),available:String(s?+s.futures_buying_power?.value:cash.USD+cash.USDC),frozen:'0',isolatedEquity:String(s?+s.initial_margin?.value||0:0)}]},cash,positions,orders,tpsl};},
  async instruments(){const j=await jget(CB+'/api/v3/brokerage/market/products?product_type=FUTURE&limit=500');
    return (j.products||[]).filter(p=>!p.trading_disabled).map(p=>{const m={instId:p.product_id,contractValue:p.future_product_details?.contract_size||'1',lotSize:p.base_increment||'1',minSize:p.base_min_size||'1',name:p.display_name};cInst[p.product_id]=m;return m});},
  async candles(instId,bar){const g={'1m':['ONE_MINUTE',60],'5m':['FIVE_MINUTE',300],'15m':['FIFTEEN_MINUTE',900],'1H':['ONE_HOUR',3600],'4H':['SIX_HOUR',21600],'1D':['ONE_DAY',86400]}[bar]||['FIFTEEN_MINUTE',900];
    const end=Math.floor(Date.now()/1000);const j=await jget(CB+`/api/v3/brokerage/market/products/${encodeURIComponent(instId)}/candles?start=${end-g[1]*300}&end=${end}&granularity=${g[0]}`);
    return (j.candles||[]).map(c=>[+c.start*1000,c.open,c.high,c.low,c.close]);},
  async order(o){const body={client_order_id:cid(),product_id:o.instId,side:o.side.toUpperCase(),leverage:String(o.leverage),margin_type:'ISOLATED',
      order_configuration:o.orderType==='limit'?{limit_limit_gtc:{base_size:String(o.size),limit_price:String(o.price)}}:{market_market_ioc:{base_size:String(o.size)}},
      attached_order_configuration:{trigger_bracket_gtc:{limit_price:String(o.tpTriggerPrice),stop_trigger_price:String(o.slTriggerPrice)}}};
    return cOk(await cReq('POST','/api/v3/brokerage/orders',body));},
  async setTpsl(o){const s=await this.snapshot();const p=s.positions.find(x=>x.instId===o.instId);if(!p)throw new Error('Position not found');if(!o.tp||!o.sl)throw new Error('Coinbase brackets need both TP and SL');
    const ids=s.tpsl.filter(x=>x.instId===o.instId).flatMap(x=>x.tpslId.split(','));if(ids.length)cOk(await cReq('POST','/api/v3/brokerage/orders/batch_cancel',{order_ids:ids}));
    return cOk(await cReq('POST','/api/v3/brokerage/orders',{client_order_id:cid(),product_id:o.instId,side:p.positionSide==='long'?'SELL':'BUY',order_configuration:{trigger_bracket_gtc:{base_size:String(Math.abs(+p.positions)),limit_price:String(o.tp),stop_trigger_price:String(o.sl)}}}));},
  async cancel(o){const r=await cReq('POST','/api/v3/brokerage/orders/batch_cancel',{order_ids:String(o.tpslId||o.orderId).split(',')});const f=(r.results||[]).find(x=>!x.success);if(f)throw new Error(f.failure_reason||'cancel failed');return r;},
  close:async o=>cOk(await cReq('POST','/api/v3/brokerage/orders/close_position',{client_order_id:cid(),product_id:o.instId}))};
const AD={b:B,c:C};

// ---------- mock data for hidden-window tests (no network for account data, no orders) ----------
const mockPos={b:[{instId:'BTC-USDT',positionSide:'net',positions:'0.5',averagePrice:'67000',markPrice:'67450',unrealizedPnl:'2.25',leverage:'5',marginMode:'isolated',margin:'6.7',tp:'68800',sl:'66400'}],
  c:[{instId:'BIP-20DEC30-CDE',positionSide:'short',positions:'-1',averagePrice:'67100',markPrice:'67000',unrealizedPnl:'1.00',leverage:'5',marginMode:'isolated',tp:'66000',sl:'67540'}]};
const mockBal=(cur,eq,av,used)=>({totalEquity:String(eq),details:[{currency:cur,equity:String(eq),available:String(av),frozen:'0',isolatedEquity:String(used)}]});
function mockSnap(ex,sel){const pos=mockPos[ex];
  if(ex==='b')return {balance:mockBal('USDT',48.62,36.52,12.10),positions:pos,orders:[{orderId:'9001',instId:'ETH-USDT',side:'buy',orderType:'limit',price:'3150',size:'0.3'}],tpsl:[{tpslId:'7001',instId:'BTC-USDT',tpTriggerPrice:'68800',slTriggerPrice:'66400'}]};
  return {balance:mockBal('USD',212.5,180,32.5),cash:{USD:150.25,USDC:62.25},positions:pos,orders:[],tpsl:pos.map((p,i)=>({tpslId:'c'+i,instId:p.instId,tpTriggerPrice:p.tp,slTriggerPrice:p.sl}))};}

// ---------- closed trade history (exchange API first, local log fallback) ----------
const logFile=ex=>path.join(app.getPath('userData'),'trades-'+ex+'.json');
const readLog=ex=>{try{return JSON.parse(fs.readFileSync(logFile(ex),'utf8'))}catch(e){return []}};
function addLog(ex,t){const l=readLog(ex);l.unshift(t);fs.writeFileSync(logFile(ex),JSON.stringify(l.slice(0,500)));}
const tr=(o)=>{const net=+o.pnl;return {...o,pnl:net,result:net>0?'WINNER':net<0?'LOSER':'BREAKEVEN'}};
async function bHistory(){const d=await bSigned('GET','/api/v1/account/positions-history',{limit:'100'});
  return (d||[]).map(x=>{const en=+x.openAveragePrice,exi=+x.closeAveragePrice,pnl=+(x.realizedPnl||0)+(x.fee&&x.realizedPnl===undefined?+x.fee:0);
    let dir=String(x.positionSide||'').toLowerCase();if(dir!=='long'&&dir!=='short')dir=(exi-en)*pnl>=0?'long':'short';
    const sz=Math.abs(+(x.closePositions||x.positions||0));const r=x.realizedPnlRatio!=null?+x.realizedPnlRatio*100:null;
    return tr({inst:x.instId,dir,entry:en,exit:exi,size:sz,pnl,pct:r,open:+x.createTime,close:+x.updateTime,src:'BloFin positions-history'})});}
async function cHistory(){if(!Object.keys(cInst).length)await C.instruments().catch(()=>{});
  const j=await cReq('GET','/api/v3/brokerage/orders/historical/fills?limit=250');const fills=(j.fills||[]).slice().sort((a,b)=>new Date(a.trade_time)-new Date(b.trade_time));
  const st={},out=[];for(const f of fills){const k=f.product_id,cv=+(cInst[k]?.contractValue||1),q=+f.size*(f.side==='BUY'?1:-1),px=+f.price,fee=+(f.commission||0),t=new Date(f.trade_time).getTime();
    let s=st[k]||(st[k]={pos:0,avg:0,fee:0,open:t,xq:0,xn:0});let rem=q;
    if(s.pos&&Math.sign(rem)!==Math.sign(s.pos)){const c=Math.min(Math.abs(rem),Math.abs(s.pos));const ffee=fee*c/Math.abs(q);s.xq+=c;s.xn+=c*px;s.fee+=ffee;
      s.pos+=Math.sign(rem)*c;rem-=Math.sign(rem)*c;
      if(Math.abs(s.pos)<1e-12){const dir=q<0?'long':'short',exi=s.xn/s.xq,g=(exi-s.avg)*s.xq*cv*(dir==='long'?1:-1),net=g-s.fee;
        out.push(tr({inst:k,dir,entry:s.avg,exit:exi,size:s.xq,pnl:net,pct:s.avg?net/(s.avg*s.xq*cv)*100:null,open:s.open,close:t,src:'Coinbase fills'}));s=st[k]={pos:0,avg:0,fee:0,open:t,xq:0,xn:0};}}
    if(rem){const n=s.pos+rem;s.avg=s.pos?(s.avg*Math.abs(s.pos)+px*Math.abs(rem))/Math.abs(n):px;if(!s.pos)s.open=t;s.pos=n;s.fee+=fee*Math.abs(rem)/Math.abs(q);}}
  return out.reverse();}
const now=Date.now(),H=3600e3;
const mockHist={b:[tr({inst:'SOL-USDT',dir:'long',entry:142.1,exit:145.3,size:1,pnl:3.02,pct:11.2,open:now-30*H,close:now-28*H,src:'mock'}),tr({inst:'BTC-USDT',dir:'short',entry:67900,exit:68150,size:0.01,pnl:-2.61,pct:-9.4,open:now-26*H,close:now-25.5*H,src:'mock'})],
  c:[tr({inst:'ETP-20DEC30-CDE',dir:'short',entry:3410,exit:3380,size:1,pnl:2.7,pct:3.9,open:now-50*H,close:now-49*H,src:'mock'})]};
async function history(ex){let api=[],err=null;try{api=MOCK?mockHist[ex]:(ex==='b'?await bHistory():await cHistory())}catch(e){err=e.message}
  const local=readLog(ex);const seen=new Set(api.map(t=>t.inst+'|'+t.dir+'|'+Math.round(t.close/60000)));
  const extra=(err||!api.length||MOCK)?local.filter(t=>!api.some(a=>a.inst===t.inst&&a.dir===t.dir&&Math.abs(a.close-t.close)<5*60000)).map(t=>tr({...t,src:'local log'})):[];
  const list=api.concat(extra).sort((a,b)=>b.close-a.close);const w=list.filter(t=>t.pnl>0).length,l=list.filter(t=>t.pnl<0).length;
  return {list,totals:{wins:w,losses:l,winRate:w+l?w/(w+l)*100:null,pnl:list.reduce((a,t)=>a+t.pnl,0)},source:err?('local log (API: '+err.slice(0,80)+')'):(api.length?(api[0].src+(extra.length?' + local log':'')):'local log')};}
function fmtOf(text,file){const t=String(text).replace(/^\uFEFF/,'');try{const j=JSON.parse(t);const ks=[];const w=o=>{for(const[k,v]of Object.entries(o||{}))v&&typeof v==='object'?w(v):ks.push(k)};w(j);return 'JSON with keys '+ks.slice(0,8).join(', ')}catch(e){}
  const pem=/-----BEGIN [A-Z ]+-----/.test(t)?' (private key as PEM block)':'';const labels=[],bare=[];
  for(let l of t.replace(/-----BEGIN[\s\S]+?-----END [A-Z ]+-----/g,'').split(/\r?\n/)){l=l.trim().replace(/^export\s+/,'');if(!l||/^#|^\/\//.test(l))continue;const m=l.match(/^([A-Za-z _\-.]{2,40}?)\s*[:=]\s*\S/);if(m)labels.push(m[1].trim());else if(!/\s/.test(l))bare.push(1);}
  if(labels.length)return (/\.env$/i.test(file)?'.env variables ':'labelled lines ')+labels.map(x=>'"'+x+'"').join(', ')+pem;
  return bare.length+' bare lines in order key, secret'+(bare.length>2?', passphrase':'')+pem;}

function register(){
  for(const ex of EXS)creds[ex]=loadCreds(ex);
  const wrap=f=>async(e,ex,...a)=>{try{ck(ex);return {ok:true,data:await f(ex,...a)}}catch(err){return {ok:false,error:String(err.message||err)}}};
  ipcMain.handle('tr:parse-file',async(e,ex)=>{ck(ex);const w=require('electron').BrowserWindow.fromWebContents(e.sender);const tf=process.env['CUSTOM_HERMES_TESTFILE_'+ex.toUpperCase()]||process.env.CUSTOM_HERMES_TESTFILE;
    const {canceled,filePaths}=tf?{canceled:false,filePaths:[tf]}:await dialog.showOpenDialog(w,{title:'Select '+NAME[ex]+' API file',properties:['openFile'],filters:[{name:'Credential files',extensions:['txt','env','json','pem','key','yaml','yml','md']},{name:'All files',extensions:['*']}]});
    if(canceled||!filePaths[0])return {ok:false,cancelled:true};
    try{const st=fs.statSync(filePaths[0]);if(st.size>256*1024)return {ok:false,error:'File too large for a key file'};
      const p=parseCredText(fs.readFileSync(filePaths[0],'utf8'),ex);const found=FIELDS[ex].filter(k=>p[k]);
      const ok=found.length>0;let cron=null;
      if(ok){const fmt=fmtOf(fs.readFileSync(filePaths[0],'utf8'),filePaths[0]);
        if(TESTRUN&&!process.env.CUSTOM_HERMES_HOME)cron={skipped:'test mode without a test cron store'};
        else{cron={pending:true};const snd=e.sender;require('./cronSync').sync(ex,path.resolve(filePaths[0]),fmt).catch(err=>({error:String(err.message).slice(0,160)})).then(c=>{try{snd.send('tr:cron',ex,c)}catch(x){}});}}
      return {ok,fields:p,found,file:path.basename(filePaths[0]),cron,error:ok?null:'No API key or secret found'};}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:status',(e,ex)=>{ck(ex);const c=creds[ex];return {saved:!!c,mode:ex==='b'?(c?.mode||'demo'):'live',keyMask:mask(c?.apiKey),mock:MOCK,encryption:safeStorage.isEncryptionAvailable(),cur:CUR[ex],name:NAME[ex]}});
  ipcMain.handle('tr:save',(e,ex,c)=>{ck(ex);const o=creds[ex]||{};const v=k=>String(c[k]||'').trim()||o[k];let n;
    if(ex==='c'){n={apiKey:v('apiKey'),secret:v('secret')};if(!n.apiKey||!n.secret)return {ok:false,error:'API key and secret are both required'};
      try{if(/BEGIN/.test(n.secret))n.secret=fixPem(n.secret);cbKey(n.secret)}catch(err){return {ok:false,error:'Private key could not be read (PEM/Ed25519)'}}}
    else{n={apiKey:v('apiKey'),secret:v('secret'),passphrase:v('passphrase'),mode:c.mode==='live'?'live':'demo'};if(!n.apiKey||!n.secret||!n.passphrase)return {ok:false,error:'API key, secret and passphrase are all required'};}
    try{saveCreds(ex,n);creds[ex]=n;return {ok:true,keyMask:mask(n.apiKey)}}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:forget',(e,ex)=>{ck(ex);try{fs.unlinkSync(credFile(ex))}catch(x){}creds[ex]=null;return {ok:true}});
  ipcMain.handle('tr:prefs',(e,p)=>{let cur={};try{cur=JSON.parse(fs.readFileSync(prefFile(),'utf8'))}catch(x){}if(p){cur={...cur,...p};fs.writeFileSync(prefFile(),JSON.stringify(cur))}return cur;});
  ipcMain.handle('tr:test',wrap(async ex=>MOCK?{mock:true}:AD[ex].test()));
  ipcMain.handle('tr:snapshot',wrap(async(ex,sel)=>MOCK?mockSnap(ex,sel):AD[ex].snapshot(sel)));
  ipcMain.handle('tr:mock-positions',(e,ex,list)=>{ck(ex);if(MOCK)mockPos[ex]=list;return MOCK;});
  ipcMain.handle('tr:instruments',wrap(async ex=>AD[ex].instruments()));
  ipcMain.handle('tr:candles',wrap(async(ex,i,b)=>AD[ex].candles(i,b)));
  ipcMain.handle('tr:history',wrap(async ex=>history(ex)));
  ipcMain.handle('tr:log-close',(e,ex,t)=>{ck(ex);const x=tr({inst:String(t.inst),dir:t.dir==='short'?'short':'long',entry:+t.entry||0,exit:+t.exit||0,size:+t.size||0,pnl:+t.pnl||0,pct:t.pct==null?null:+t.pct,open:+t.open||Date.now(),close:Date.now(),src:'local log'});addLog(ex,x);return x;});
  const guard=()=>{if(MOCK)throw new Error('Mock mode: no orders are sent');};
  ipcMain.handle('tr:order',wrap(async(ex,o)=>{guard();if(!o.slTriggerPrice)throw new Error('Stop loss is mandatory');return AD[ex].order(o)}));
  ipcMain.handle('tr:set-tpsl',wrap(async(ex,o)=>{guard();return AD[ex].setTpsl(o)}));
  ipcMain.handle('tr:cancel',wrap(async(ex,o)=>{guard();return AD[ex].cancel(o)}));
  ipcMain.handle('tr:close',wrap(async(ex,o)=>{guard();return AD[ex].close(o)}));
  ipcMain.handle('tr:share',(e,dataUrl)=>{const img=nativeImage.createFromDataURL(String(dataUrl));if(img.isEmpty())return {ok:false};if(!process.env.CUSTOM_HERMES_TEST)clipboard.writeImage(img);return {ok:true,w:img.getSize().width};});
}
module.exports={register,parseCredText,_cbJwt:cbJwt,_fixPem:fixPem};
