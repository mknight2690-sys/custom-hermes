// Custom Hermes Trading: signed calls for BloFin (B), Propr (P) and Coinbase (C) run here (main process).
// Secrets are never logged or sent back to the renderer. Each adapter normalizes to the BloFin data shape.
const {ipcMain,dialog,safeStorage,app,clipboard,nativeImage}=require('electron');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const MOCK=!!process.env.CUSTOM_HERMES_MOCK;const EXS=['b','p','c'];
const NAME={b:'BloFin',p:'Propr',c:'Coinbase'};const CUR={b:'USDT',p:'USDC',c:'USD'};
const FIELDS={b:['apiKey','secret','passphrase','mode'],p:['apiKey'],c:['apiKey','secret']};
const credFile=ex=>path.join(app.getPath('userData'),{b:'blofin.cred',p:'propr.cred',c:'coinbase.cred'}[ex]);
const prefFile=()=>path.join(app.getPath('userData'),'trading.json');
const creds={};const T=12000;
const ck=ex=>{if(!EXS.includes(ex))throw new Error('bad exchange');return ex};

// ---------- credential file parser ----------
function parseCredText(text,ex='b'){
  const out={};let t=String(text||'').replace(/^\uFEFF/,'');
  const pem=t.match(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/);
  const pk=t.match(/pk_live_[A-Za-z0-9_\-]{8,}/);
  if(ex==='p'){if(pk)out.apiKey=pk[0];return out;}
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

// ---------- Propr (Hyperliquid-backed prop accounts; X-API-Key pk_live_) ----------
const PB='https://api.propr.xyz/v1',HL='https://api.hyperliquid.xyz/info';
async function pReq(method,p,body){const c=creds.p;if(!c||!c.apiKey)throw new Error('No Propr key saved');
  return jget(PB+p,{method,headers:{'X-API-Key':c.apiKey,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});}
const hl=body=>jget(HL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const strip=a=>String(a||'').replace(/^xyz:/,'');
const ulid=()=>{const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=A[t%32]+s;t=Math.floor(t/32)}const r=crypto.randomBytes(16);for(let i=0;i<16;i++)s+=A[r[i]%32];return s};
let pAccts=[],pChal={},pAtt={};
const str=v=>v==null?'':typeof v==='object'?str(v.en??v.displayName??v.name??v.title??v.label??(Object.values(v).find(x=>typeof x==='string')||'')):String(v);
const money=n=>{n=+n;if(!n)return '';return n>=1000?(n%1000?(n/1000).toFixed(1):n/1000)+'K':String(n)};
function pLabel(r,ch,acc){const rc=(r.challenge&&typeof r.challenge==='object')?r.challenge:{};ch=Object.assign({},rc,ch||{});if(rc.name)ch.name=rc.name;const names=[r.name,r.displayName,r.challengeName,r.productName,ch.displayName,ch.name,ch.title,rc.name,r.product,acc&&acc.label].map(str).filter(Boolean);
  const st=String(r.status||'');const funded=/fund/i.test(st+str(ch.type)+str(r.type)+str(r.currentPhase?.name)+str(acc?.type));const kind=funded?'Funded Account':'Challenge';
  let n=names[0]||'';const size=pick([ch,r,r.currentPhase,acc],['initialBalance','accountSize','size','startingBalance']);
  if(n){if(funded)n=n.replace(/\s*challenge\s*$/i,'');if(!/challenge|funded|account/i.test(n)&&!(/free/i.test(n)&&!funded))n=n+' '+kind;else if(funded&&!/funded/i.test(n))n=n+' Funded Account';
    if(size&&!/\d+(\.\d+)?\s*k\b|\d{4,}/i.test(n)&&!/free/i.test(n))n=money(size)+' '+n;}
  else n=(size?money(size)+' ':'')+kind;
  return n.replace(/\s+/g,' ').trim();}
async function pAccounts(){const j=await pReq('GET','/challenge-attempts?limit=50');const rows=j.data||j.items||(Array.isArray(j)?j:[]);const seen=new Set();
  try{const c=await pReq('GET','/challenges?limit=100');for(const x of (c.data||c.items||[]))pChal[x.challengeId||x.id]=x;}catch(e){}
  const rank=st=>/active|fund/i.test(st)?0:/pass/i.test(st)?1:2;
  pAccts=rows.map(r=>{const id=r.accountId||r.account?.accountId||r.account?.id;if(!id||seen.has(id))return null;seen.add(id);pAtt[id]=r;const ch=pChal[r.challengeId]||r.challenge||{};
    const st=str(r.status);
    return {id,status:st,label:pLabel(r,ch,null)+(st&&!/active/i.test(st)?' · '+st:'')}}).filter(Boolean).sort((a,b)=>rank(a.status)-rank(b.status));
  return pAccts;}
// read a rule from any of several API objects; returns {v,src}
function pick(objs,keys){for(const o of objs){if(!o)continue;for(const k of keys){const v=k.split('.').reduce((a,x)=>a==null?a:a[x],o);if(v!=null&&v!==''&&!isNaN(+v))return +v;}}return null;}
const pct=v=>v==null?null:(Math.abs(v)>1?v/100:v);
function pInfo(id,acc,trades,upnl){const r=pAtt[id]||{},ch=pChal[r.challengeId]||r.challenge||{},ph=r.currentPhase||(r.phases||[]).find(p=>p.phaseId===r.currentPhaseId)||{};
  const phRules=(ch.phases||[]).find(p=>p.phaseId===r.currentPhaseId)||{};const O=[phRules,ph,ch,ch.rules,phRules.rules,acc];
  const name=pLabel(r,ch,acc),nm=name.toLowerCase();const st=str(r.status);const funded=/fund/i.test(st+String(ch.type||''));
  const size=pick(O,['initialBalance','accountSize','size','startingBalance'])??pick([acc],['initialBalance','startingBalance']);
  const eq=+(acc.marginBalance??acc.equity??acc.balance??0),bal=+(acc.balance??eq);
  let tgt=pick(O,['profitTarget','profitTargetPercent','targetProfit','profitTargetPct']),tsrc='api';
  const target=tgt==null||!size?null:(tgt<=100?size*(1+pct(tgt)):tgt);
  let dd=pick(O,['maxDrawdown','maxDrawdownPercent','maxLoss','maxTotalLoss','drawdownLimit']),ddsrc='api';const ddType=String(ch.drawdownType||phRules.drawdownType||'').toLowerCase();
  let trailing=/trail/.test(ddType);
  if(dd==null){ddsrc='derived';if(/turbo/.test(nm))dd=3;else if(/classic/.test(nm))dd=6;else if(/\bpro\b/.test(nm))dd=5;else if(/2.?step|two/.test(nm)){dd=8;trailing=true;}}
  const closes=(trades||[]).filter(t=>/close|liquid/i.test(t.type||'')||+t.realizedPnl);const pnls=closes.map(t=>+t.realizedPnl||0);
  let cum=0,peak=size||0;for(const t of [...closes].reverse()){cum+=+t.realizedPnl||0;peak=Math.max(peak,(size||0)+cum);}peak=Math.max(peak,eq);
  const ddAmt=dd==null||!size?null:(dd<=100?size*pct(dd):dd);const floor=ddAmt==null?null:(trailing?peak-ddAmt:size-ddAmt);
  if(trailing&&ddsrc==='api')ddsrc='api (peak derived)';
  let dl=pick(O,['dailyLossLimit','maxDailyLoss','dailyDrawdown','dailyLoss','maxDailyLossPercent']);const dlAmt=dl==null||!size?null:(dl<=100?size*pct(dl):dl);
  const d0=new Date();d0.setUTCHours(0,0,0,0);const today=closes.filter(t=>new Date(t.executedAt||t.createdAt)>=d0).reduce((a,t)=>a+(+t.realizedPnl||0),0);
  const usedToday=Math.max(0,-(today+Math.min(0,upnl)));
  const wins=pnls.filter(x=>x>0).length,losses=pnls.filter(x=>x<0).length;const split=pick(O,['profitSplit','payoutSplit','profitShare'])??80;
  const prof=size?Math.max(0,eq-size):null;
  return {name,type:funded?'Funded':'Challenge',size,tier:str(ch.tier||ch.level||phRules.name||ph.name)||null,phase:ph.order??null,status:st||'active',eq,bal,upnl,
    target,targetSrc:target==null?'not in API':tsrc,progress:target&&size?Math.max(0,(eq-size)/(target-size)*100):null,
    floor,floorSrc:floor==null?'not in API':ddsrc,trailing,ddPct:dd,distFloor:floor==null?null:eq-floor,ddBudget:ddAmt,
    dailyLimit:dlAmt,dailySrc:dlAmt==null?'not in API':'api',usedToday,dailyRemaining:dlAmt==null?null:dlAmt-usedToday,todayRealized:today,
    trades:closes.slice(0,30).map(t=>({inst:strip(t.base||t.asset),side:t.positionSide,pnl:+t.realizedPnl||0,at:t.executedAt||t.createdAt,liq:!!t.isLiquidation})),
    wins,losses,winRate:wins+losses?wins/(wins+losses)*100:null,split,payoutAvail:funded&&prof!=null?prof*pct(split):null,payoutEligible:funded?(prof>0?'profit available (eligibility rules not in API)':'no profit yet'):'n/a until funded',
    failureReason:str(r.failureReason)||null};}
const isTrig=t=>/stop|take_profit/.test(t);
function pNorm(acct,positions,orders){
  const ord=orders.map(o=>({orderId:o.orderId,instId:strip(o.base||o.asset)+'-USDC',asset:o.asset,base:o.base,side:o.side,positionSide:o.positionSide,orderType:o.type,price:o.price||o.triggerPrice,triggerPrice:o.triggerPrice,size:o.quantity}));
  const trig=ord.filter(o=>isTrig(o.orderType));const tp={};for(const o of trig){const k=o.instId;tp[k]??={tpslId:[],instId:k,tpTriggerPrice:'',slTriggerPrice:''};tp[k].tpslId.push(o.orderId);if(/take_profit/.test(o.orderType))tp[k].tpTriggerPrice=o.triggerPrice;else tp[k].slTriggerPrice=o.triggerPrice;}
  const tpsl=Object.values(tp).map(x=>({...x,tpslId:x.tpslId.join(',')}));
  const pos=positions.filter(p=>+p.quantity).map(p=>{const instId=strip(p.base||p.asset)+'-USDC';const t=tp[instId]||{};const q=Math.abs(+p.quantity);
    return {instId,asset:p.asset,base:p.base,quote:p.quote,positionSide:p.positionSide,positions:String(p.positionSide==='short'?-q:q),averagePrice:p.entryPrice,markPrice:p.markPrice,unrealizedPnl:p.unrealizedPnl,leverage:p.leverage,marginMode:p.marginMode,margin:p.marginUsed,tp:t.tpTriggerPrice||'',sl:t.slTriggerPrice||'',_acct:acct}});
  return {positions:pos,orders:ord.filter(o=>!isTrig(o.orderType)),tpsl};}
let pSel=null;
const P={
  test:async()=>{const u=await pReq('GET','/users/me');await pAccounts();return {user:!!u,accounts:pAccts.length}},
  async snapshot(sel){if(!pAccts.length)await pAccounts();if(sel)pSel=sel;if(!pAccts.find(a=>a.id===pSel))pSel=pAccts[0]?.id;if(!pSel)throw new Error('No active Propr challenge or funded account');
    const live=pAccts.filter(a=>a.id===pSel||!/fail|breach|expired|cancel/i.test(a.status));
    const all=await Promise.all(live.map(async a=>{const me=a.id===pSel;const [acc,pos,ord,tr]=await Promise.all([me?pReq('GET','/accounts/'+a.id):null,pReq('GET','/accounts/'+a.id+'/positions?status=open&limit=50'),me?pReq('GET','/accounts/'+a.id+'/orders?status=open&limit=100'):{data:[]},me?pReq('GET','/accounts/'+a.id+'/trades?limit=100').catch(()=>({data:[]})):null]);
      return {a,acc,tr,n:pNorm(a.id,pos.data||[],ord.data||[])}}));
    const me=all.find(x=>x.a.id===pSel);const acc=me.acc||{};const eq=+(acc.marginBalance??acc.equity??acc.balance??0);const used=me.n.positions.reduce((s,p)=>s+(+p.margin||0),0);const upnl=me.n.positions.reduce((s,p)=>s+(+p.unrealizedPnl||0),0);
    return {balance:{totalEquity:String(eq),details:[{currency:'USDC',equity:String(eq),available:String(acc.availableBalance??''),frozen:'0',isolatedEquity:String(used)}]},
      positions:me.n.positions,orders:me.n.orders,tpsl:me.n.tpsl,allPositions:all.flatMap(x=>x.n.positions),accounts:pAccts,selected:pSel,info:pInfo(pSel,acc,me.tr?.data||[],upnl)};},
  async instruments(){const m=await hl({type:'meta'});return (m.universe||[]).filter(u=>!u.isDelisted).map(u=>({instId:u.name+'-USDC',contractValue:'1',lotSize:String(10**-u.szDecimals),minSize:String(10**-u.szDecimals),maxLeverage:u.maxLeverage}));},
  async candles(instId,bar){const iv={'1H':'1h','4H':'4h','1D':'1d'}[bar]||bar;const ms={'1m':6e4,'5m':3e5,'15m':9e5,'1h':36e5,'4h':144e5,'1d':864e5}[iv]||9e5;const now=Date.now();
    const c=await hl({type:'candleSnapshot',req:{coin:instId.split('-')[0],interval:iv,startTime:now-ms*300,endTime:now}});return c.map(x=>[x.t,x.o,x.h,x.l,x.c]);},
  ord(base,o){const a=base;return {accountId:pSel,intentId:ulid(),exchange:'hyperliquid',productType:'perp',asset:a,base:a,quote:'USDC',...o}},
  async order(o){const base=o.instId.split('-')[0];
    try{const mc=await pReq('GET','/accounts/'+pSel+'/margin-config/'+base);if(mc&&mc.configId)await pReq('PUT','/accounts/'+pSel+'/margin-config/'+mc.configId,{exchange:'hyperliquid',asset:base,marginMode:'isolated',leverage:+o.leverage});}
    catch(e){throw new Error('Could not set 5x isolated on Propr ('+e.message+'); order not sent');}
    const long=o.side==='buy',ps=long?'long':'short',ex=long?'sell':'buy';
    const entry=this.ord(base,{type:o.orderType,side:o.side,positionSide:ps,quantity:String(o.size),timeInForce:o.orderType==='market'?'IOC':'GTC',reduceOnly:false,closePosition:false,...(o.orderType==='limit'?{price:String(o.price)}:{})});
    const sl=this.ord(base,{type:'stop_market',side:ex,positionSide:ps,quantity:String(o.size),triggerPrice:String(o.slTriggerPrice),timeInForce:'GTC',reduceOnly:true,closePosition:true});
    const tp=o.tpTriggerPrice?[this.ord(base,{type:'take_profit_market',side:ex,positionSide:ps,quantity:String(o.size),triggerPrice:String(o.tpTriggerPrice),timeInForce:'GTC',reduceOnly:true,closePosition:true})]:[];
    return pReq('POST','/accounts/'+pSel+'/orders',{orders:[entry,sl,...tp]});},
  async setTpsl(o){const s=await this.snapshot();const base=o.instId.split('-')[0];const p=s.positions.find(x=>x.instId===o.instId);if(!p)throw new Error('Position not found');
    for(const t of s.tpsl.filter(x=>x.instId===o.instId))for(const id of t.tpslId.split(','))await pReq('POST','/accounts/'+pSel+'/orders/'+id+'/cancel');
    const q=String(Math.abs(+p.positions)),ps=p.positionSide,side=ps==='long'?'sell':'buy';const L=[];
    if(o.sl)L.push(this.ord(base,{type:'stop_market',side,positionSide:ps,quantity:q,triggerPrice:String(o.sl),timeInForce:'GTC',reduceOnly:true,closePosition:true}));
    if(o.tp)L.push(this.ord(base,{type:'take_profit_market',side,positionSide:ps,quantity:q,triggerPrice:String(o.tp),timeInForce:'GTC',reduceOnly:true,closePosition:true}));
    return L.length?pReq('POST','/accounts/'+pSel+'/orders',{orders:L}):null;},
  async cancel(o){const ids=String(o.tpslId||o.orderId).split(',');for(const id of ids)await pReq('POST','/accounts/'+pSel+'/orders/'+id+'/cancel');return true;},
  close(o){const base=o.instId.split('-')[0];return pReq('POST','/accounts/'+pSel+'/orders',{orders:[this.ord(base,{type:'market',side:o.positionSide==='long'?'sell':'buy',positionSide:o.positionSide,quantity:String(Math.abs(+o.positions)),timeInForce:'IOC',reduceOnly:true,closePosition:true})]});}};

// ---------- Coinbase Advanced Trade (CDP JWT ES256/Ed25519, or legacy HMAC key/secret) ----------
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
const AD={b:B,p:P,c:C};

// ---------- mock data for hidden-window tests (no network for account data, no orders) ----------
const mockPos={b:[{instId:'BTC-USDT',positionSide:'net',positions:'0.5',averagePrice:'67000',markPrice:'67450',unrealizedPnl:'2.25',leverage:'5',marginMode:'isolated',margin:'6.7',tp:'68800',sl:'66400'}],
  p:[{instId:'ETH-USDC',positionSide:'long',positions:'0.01',averagePrice:'3100',markPrice:'3120',unrealizedPnl:'0.20',leverage:'5',marginMode:'isolated',margin:'6.2',tp:'3260',sl:'3036',_acct:'acctA'}],
  c:[{instId:'BIP-20DEC30-CDE',positionSide:'short',positions:'-1',averagePrice:'67100',markPrice:'67000',unrealizedPnl:'1.00',leverage:'5',marginMode:'isolated',tp:'66000',sl:'67540'}]};
const mockBal=(cur,eq,av,used)=>({totalEquity:String(eq),details:[{currency:cur,equity:String(eq),available:String(av),frozen:'0',isolatedEquity:String(used)}]});
const mockAccts=[{id:'acctA',label:'Challenge 10K ·acctA'},{id:'acctB',label:'Funded 25K ·acctB'}];let mockSel='acctA';
function mockSnap(ex,sel){const pos=mockPos[ex];
  if(ex==='b')return {balance:mockBal('USDT',48.62,36.52,12.10),positions:pos,orders:[{orderId:'9001',instId:'ETH-USDT',side:'buy',orderType:'limit',price:'3150',size:'0.3'}],tpsl:[{tpslId:'7001',instId:'BTC-USDT',tpTriggerPrice:'68800',slTriggerPrice:'66400'}]};
  if(ex==='p'){if(sel)mockSel=sel;const mine=pos.filter(p=>(p._acct||'acctA')===mockSel);
    const mi=mockSel==='acctA'?{name:'Turbo 5K',type:'Challenge',size:5000,tier:'Turbo',phase:1,status:'active',eq:4890,bal:4900,upnl:-10,target:5400,targetSrc:'api',progress:0,floor:4850,floorSrc:'derived',trailing:false,ddPct:3,distFloor:40,ddBudget:150,dailyLimit:null,dailySrc:'not in API',usedToday:55,dailyRemaining:null,todayRealized:-45,trades:[{inst:'BTC',side:'long',pnl:12.5,at:new Date().toISOString()},{inst:'ETH',side:'short',pnl:-8.2,at:new Date().toISOString()}],wins:1,losses:1,winRate:50,split:80,payoutAvail:null,payoutEligible:'n/a until funded'}
      :{name:'Classic 25K',type:'Funded',size:25000,tier:'Classic',phase:null,status:'funded',eq:25140,bal:25140,upnl:0,target:null,targetSrc:'not in API',progress:null,floor:23500,floorSrc:'derived',trailing:false,ddPct:6,distFloor:1640,ddBudget:1500,dailyLimit:1000,dailySrc:'api',usedToday:800,dailyRemaining:200,todayRealized:-800,trades:[],wins:0,losses:0,winRate:null,split:80,payoutAvail:112,payoutEligible:'profit available (eligibility rules not in API)'};
    return {info:mi,balance:mockSel==='acctA'?mockBal('USDC',10012.4,9800,6.2):mockBal('USDC',25140,25140,0),positions:mine,orders:[],tpsl:mine.filter(p=>p.tp||p.sl).map((p,i)=>({tpslId:'m'+i,instId:p.instId,tpTriggerPrice:p.tp,slTriggerPrice:p.sl})),allPositions:pos,accounts:mockAccts,selected:mockSel};}
  return {balance:mockBal('USD',212.5,180,32.5),cash:{USD:150.25,USDC:62.25},positions:pos,orders:[],tpsl:pos.map((p,i)=>({tpslId:'c'+i,instId:p.instId,tpTriggerPrice:p.tp,slTriggerPrice:p.sl}))};}

function shape(o,p='',out=[],d=0){if(d>5||out.length>400)return out;if(Array.isArray(o)){out.push(p+' : array['+o.length+']');if(o.length)shape(o[0],p+'[0]',out,d+1);return out}
  if(o&&typeof o==='object'){for(const[k,v]of Object.entries(o))shape(v,p+'.'+k,out,d+1);return out}
  const show=/name|title|type|tier|status|size|phase|product|label|balance|target|drawdown|loss|split|percent|pct|order|level|kind|plan|program|currency/i.test(p)&&!/id$|Id$|email|user|key|token|hash|address|wallet/i.test(p);
  out.push(p+' : '+typeof o+(show?' = '+JSON.stringify(o).slice(0,60):''));return out}
async function dumpShape(file){creds.p=loadCreds('p');const L=[];const g=async u=>{try{return await pReq('GET',u)}catch(e){L.push(u+' ERR '+e.message.slice(0,80));return null}};
  const a=await g('/challenge-attempts?limit=50');L.push('== /challenge-attempts',...shape(a));const c=await g('/challenges?limit=100');L.push('== /challenges',...shape(c));
  const id=(a&&(a.data||[])[0]||{}).accountId;if(id){const ac=await g('/accounts/'+id);L.push('== /accounts/{id}',...shape(ac));const tr=await g('/accounts/'+id+'/trades?limit=2');L.push('== trades',...shape(tr));}
  await pAccounts().catch(e=>L.push('pAccounts ERR '+e.message));for(const x of (a&&a.data||[]))L.push('ATT name='+str(x.challenge&&x.challenge.name)+' slug='+(x.challenge&&x.challenge.slug)+' bal='+(x.challenge&&x.challenge.initialBalance)+' status='+x.status+' acct='+(x.account&&x.account.type)+' phase='+str(x.currentPhase&&x.currentPhase.name)+' phases='+(x.phases||[]).length);for(const x of (c&&c.data||[]))L.push('CH name='+str(x.name)+' slug='+x.slug+' bal='+x.initialBalance+' prod='+str(x.product&&x.product.name)+' phases='+(x.phases||[]).length);L.push('== labels',...pAccts.map(x=>x.label));fs.writeFileSync(file,L.join('\n'));}
function register(){
  for(const ex of EXS)creds[ex]=loadCreds(ex);
  const wrap=f=>async(e,ex,...a)=>{try{ck(ex);return {ok:true,data:await f(ex,...a)}}catch(err){return {ok:false,error:String(err.message||err).replace(/pk_live_\w+/g,'pk_live_…')}}};
  ipcMain.handle('tr:parse-file',async(e,ex)=>{ck(ex);const w=require('electron').BrowserWindow.fromWebContents(e.sender);const tf=process.env['CUSTOM_HERMES_TESTFILE_'+ex.toUpperCase()]||process.env.CUSTOM_HERMES_TESTFILE;
    const {canceled,filePaths}=tf?{canceled:false,filePaths:[tf]}:await dialog.showOpenDialog(w,{title:'Select '+NAME[ex]+' API file',properties:['openFile'],filters:[{name:'Credential files',extensions:['txt','env','json','pem','key','yaml','yml','md']},{name:'All files',extensions:['*']}]});
    if(canceled||!filePaths[0])return {ok:false,cancelled:true};
    try{const st=fs.statSync(filePaths[0]);if(st.size>256*1024)return {ok:false,error:'File too large for a key file'};
      const p=parseCredText(fs.readFileSync(filePaths[0],'utf8'),ex);const found=FIELDS[ex].filter(k=>p[k]);
      return {ok:found.length>0,fields:p,found,file:path.basename(filePaths[0]),error:found.length?null:(ex==='p'?'No pk_live_ key found':'No API key or secret found')};}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:status',(e,ex)=>{ck(ex);const c=creds[ex];return {saved:!!c,mode:ex==='b'?(c?.mode||'demo'):'live',keyMask:mask(c?.apiKey),mock:MOCK,encryption:safeStorage.isEncryptionAvailable(),cur:CUR[ex],name:NAME[ex]}});
  ipcMain.handle('tr:save',(e,ex,c)=>{ck(ex);const o=creds[ex]||{};const v=k=>String(c[k]||'').trim()||o[k];let n;
    if(ex==='p'){n={apiKey:v('apiKey')};if(!/^pk_live_/.test(n.apiKey||''))return {ok:false,error:'Propr key must start with pk_live_'};}
    else if(ex==='c'){n={apiKey:v('apiKey'),secret:v('secret')};if(!n.apiKey||!n.secret)return {ok:false,error:'API key and secret are both required'};
      try{if(/BEGIN/.test(n.secret))n.secret=fixPem(n.secret);cbKey(n.secret)}catch(err){return {ok:false,error:'Private key could not be read (PEM/Ed25519)'}}}
    else{n={apiKey:v('apiKey'),secret:v('secret'),passphrase:v('passphrase'),mode:c.mode==='live'?'live':'demo'};if(!n.apiKey||!n.secret||!n.passphrase)return {ok:false,error:'API key, secret and passphrase are all required'};}
    try{saveCreds(ex,n);creds[ex]=n;if(ex==='p')pAccts=[];return {ok:true,keyMask:mask(n.apiKey)}}catch(err){return {ok:false,error:err.message}}});
  ipcMain.handle('tr:forget',(e,ex)=>{ck(ex);try{fs.unlinkSync(credFile(ex))}catch(x){}creds[ex]=null;if(ex==='p')pAccts=[];return {ok:true}});
  ipcMain.handle('tr:prefs',(e,p)=>{let cur={};try{cur=JSON.parse(fs.readFileSync(prefFile(),'utf8'))}catch(x){}if(p){cur={...cur,...p};fs.writeFileSync(prefFile(),JSON.stringify(cur))}return cur;});
  ipcMain.handle('tr:test',wrap(async ex=>MOCK?{mock:true}:AD[ex].test()));
  ipcMain.handle('tr:snapshot',wrap(async(ex,sel)=>MOCK?mockSnap(ex,sel):AD[ex].snapshot(sel)));
  ipcMain.handle('tr:mock-positions',(e,ex,list)=>{ck(ex);if(MOCK)mockPos[ex]=list;return MOCK;});
  ipcMain.handle('tr:instruments',wrap(async ex=>AD[ex].instruments()));
  ipcMain.handle('tr:candles',wrap(async(ex,i,b)=>AD[ex].candles(i,b)));
  const guard=()=>{if(MOCK)throw new Error('Mock mode: no orders are sent');};
  ipcMain.handle('tr:order',wrap(async(ex,o)=>{guard();if(!o.slTriggerPrice)throw new Error('Stop loss is mandatory');return AD[ex].order(o)}));
  ipcMain.handle('tr:set-tpsl',wrap(async(ex,o)=>{guard();return AD[ex].setTpsl(o)}));
  ipcMain.handle('tr:cancel',wrap(async(ex,o)=>{guard();return AD[ex].cancel(o)}));
  ipcMain.handle('tr:close',wrap(async(ex,o)=>{guard();return AD[ex].close(o)}));
  ipcMain.handle('tr:share',(e,dataUrl)=>{const img=nativeImage.createFromDataURL(String(dataUrl));if(img.isEmpty())return {ok:false};if(!process.env.CUSTOM_HERMES_TEST)clipboard.writeImage(img);return {ok:true,w:img.getSize().width};});
}
module.exports={dumpShape,register,parseCredText,_pInfo:pInfo,_cbJwt:cbJwt,_fixPem:fixPem};
