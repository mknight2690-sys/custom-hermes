// Custom Hermes Trading tab (renderer). Secrets only flow renderer->main on Save; never read back.
(()=>{const ipc=require('electron').ipcRenderer;
// one shared speech queue for all three tabs so announcements never overlap
const VQ={muted:false,q:[],speaking:false,say(t){if(this.muted)return;if(this.q.length>=4)this.q.shift();this.q.push(t);this.pump()},
 pump(){if(this.speaking||!this.q.length)return;const t=this.q.shift();this.speaking=true;const done=()=>{this.speaking=false;setTimeout(()=>this.pump(),250)};ipc.invoke('tr:speak',t).then(done,done);},
 stop(){this.q=[];ipc.send('tr:speakstop');this.speaking=false}};
const DEF={b:'BTC-USDT',p:'BTC-USDC',c:'BIP-20DEC30-CDE'};const PFX={b:'',p:'Propr ',c:'Coinbase '};
function make(ex){const root=document.getElementById('trTpl').content.firstElementChild.cloneNode(true);root.id='trading_'+ex;document.getElementById('trHost').appendChild(root);
 {const q=s=>root.querySelector(s);if(ex!=='b')q('#modeSeg').style.display='none';
  if(ex==='p'){q('.fsec').style.display='none';q('.fpass').style.display='none';q('.lk').textContent='Propr API key (pk_live_…)';}
  if(ex==='c'){q('.fpass').style.display='none';q('.lk').textContent='API key name (CDP organizations/…/apiKeys/… or legacy key)';q('.ls').textContent='Private key (PEM / Ed25519) or legacy secret';}
  q('#pickFile').textContent='📄 Select '+({b:'BloFin',p:'Propr',c:'Coinbase'})[ex]+' API file';
 }
const $=id=>root.querySelector('#'+id);const Q=s=>root.querySelectorAll(s);
let cur='USDT',acctSel=null,mode='demo',otype='market',equity=0,avail=0,inst=DEF[ex],bar='15m',insts=[],instMeta={},lastPrice=0,connected=false,timer=null;
const fmt=(n,d=2)=>isFinite(+n)?(+n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:Math.min(d,2)}):'–';
const act=t=>{const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+t;$('actLog').prepend(d);while($('actLog').children.length>80)$('actLog').lastChild.remove();};
const setMsg=(id,t,c)=>{$(id).textContent=t||'';$(id).className='msg '+(c||'')};
// ---------- voice ----------
const voice={base:null,gone:{},
 say(t){VQ.say(PFX[ex]+t)},
 rebase(){this.base=null;this.gone={};this.pnl={};VQ.stop()},
 key:p=>{const sz=+p.positions;const side=p.positionSide&&p.positionSide!=='net'?p.positionSide:(sz>=0?'long':'short');return p.instId+'|'+side+'|'+(p._acct||'')},
 label:k=>{const[i,s]=k.split('|');return i.split('-')[0]+' '+s},
 pnl:{},res(k){const v=this.pnl[k];return v===undefined||isNaN(v)?'':v>0?', winner':v<0?', loser':', breakeven'},
 update(list){const live=(list||[]).filter(p=>+p.positions!==0);for(const p of live)this.pnl[this.key(p)]=parseFloat(p.unrealizedPnl);const now=new Set(live.map(this.key));
  if(this.base===null){this.base=now;return}
  for(const k of now){if(!this.base.has(k)){this.say(this.label(k)+' opened');act(this.label(k)+' opened')}delete this.gone[k]}
  for(const k of this.base){if(!now.has(k)){this.gone[k]=(this.gone[k]||0)+1;if(this.gone[k]>=2){const m=this.label(k)+' closed'+this.res(k);this.say(m);act(m);delete this.gone[k];delete this.pnl[k]}else now.add(k)}}
  this.base=now;}};
window['__voice_'+ex]=voice;if(ex==='b')window.__voice=voice;
// ---------- connection panel ----------
Q('.pw span').forEach(s=>s.onclick=()=>{const i=$(s.dataset.t);i.type=i.type==='password'?'text':'password';s.textContent=i.type==='password'?'show':'hide'});
const setMode=m=>{mode=m;Q('#modeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.m===m))};
Q('#modeSeg button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
$('pickFile').onclick=async()=>{const r=await ipc.invoke('tr:parse-file',ex);if(r.cancelled)return;
 if(r.fields){if(r.fields.apiKey)$('fKey').value=r.fields.apiKey;if(r.fields.secret)$('fSecret').value=r.fields.secret;if(r.fields.passphrase)$('fPass').value=r.fields.passphrase;if(r.fields.mode)setMode(r.fields.mode)}
 const names={apiKey:ex==='p'?'pk_live key':'API key',secret:ex==='c'?'Private key / secret':'Secret',passphrase:'Passphrase',mode:'Mode'};
 $('foundChips').innerHTML=({b:['apiKey','secret','passphrase','mode'],p:['apiKey'],c:['apiKey','secret']})[ex].map(k=>`<span class="chip ${r.found&&r.found.includes(k)?'':'miss'}">${r.found&&r.found.includes(k)?'✓':'✗'} ${names[k]}</span>`).join('');
 setMsg('connMsg',r.ok?`Filled from ${r.file}. Review, then Save.`:(r.error||'Could not read file'),r.ok?'ok':'err');};
$('saveCreds').onclick=async()=>{const r=await ipc.invoke('tr:save',ex,{apiKey:$('fKey').value,secret:$('fSecret').value,passphrase:$('fPass').value,mode});
 if(r.ok){['fKey','fSecret','fPass'].forEach(i=>{$(i).value='';$(i).placeholder='saved '+(i==='fKey'?r.keyMask:'••••')});setMsg('connMsg','Saved encrypted on this PC'+(ex==='b'?' ('+mode+')':'')+'.','ok');voice.rebase();connect();}else setMsg('connMsg',r.error,'err');};
$('testConn').onclick=async()=>{setMsg('connMsg','Testing…');const r=await ipc.invoke('tr:test',ex);setMsg('connMsg',r.ok?'Connected. Balance call succeeded.':r.error,r.ok?'ok':'err');};
$('forget').onclick=async()=>{await ipc.invoke('tr:forget',ex);connected=false;voice.rebase();$('connTag').textContent='not connected';setMsg('connMsg','Keys removed from this PC.');};
const setMute=m=>{VQ.muted=m;document.querySelectorAll('.trading #muteBtn').forEach(b=>b.textContent=m?'🔇 Voice muted':'🔊 Voice on');if(m)VQ.stop();};
$('muteBtn').onclick=()=>{setMute(!VQ.muted);ipc.invoke('tr:prefs',{muted:VQ.muted})};
// ---------- account polling ----------
async function connect(){const st=await ipc.invoke('tr:status',ex);setMode(st.mode);cur=st.cur;Q('.cur').forEach(e=>e.textContent=cur);
 if(st.saved){$('fKey').placeholder='saved '+st.keyMask;$('fSecret').placeholder=$('fPass').placeholder='saved ••••'}
 if(!st.saved&&!st.mock){$('connTag').textContent='not connected';return}
 connected=true;$('connTag').textContent=(st.mock?'mock':(ex==='b'?st.mode:'live'))+' · connected';clearInterval(timer);poll();timer=setInterval(poll,4000);}
let failStreak=0;
async function poll(){const r=await ipc.invoke('tr:snapshot',ex,acctSel);
 if(!r.ok){failStreak++;if(failStreak===1)act('Sync error: '+r.error);if(failStreak>=3)voice.rebase();$('connTag').textContent='sync error';return}
 if(failStreak)$('connTag').textContent=(ex==='b'?mode:'live')+' · connected';failStreak=0;const d=r.data;if(d.accounts)renderAccts(d.accounts,d.selected);if(d.info)renderInfo(d.info,d.positions||[]);
 const b=Array.isArray(d.balance)?d.balance[0]:d.balance;const det=(b.details||[]).find(x=>x.currency===cur)||(b.details||[])[0]||{};
 equity=+b.totalEquity||+det.equity||0;avail=+det.available||+det.availableEquity||0;
 const used=Math.max(0,(+det.frozen||0)+(+det.isolatedEquity||+b.isolatedEquity||0));const upnl=(d.positions||[]).reduce((s,p)=>s+(+p.unrealizedPnl||0),0);
 $('sEq').textContent=fmt(equity)+' '+cur;$('sEqSub').textContent=d.cash?'USD '+fmt(d.cash.USD)+' · USDC '+fmt(d.cash.USDC):'';$('sAv').textContent=fmt(avail);$('sMu').textContent=fmt(used);$('sPnl').textContent=(upnl>=0?'+':'')+fmt(upnl);$('sPnl').className=upnl>=0?'pos':'neg';
 renderPos(d.positions||[],d.tpsl||[]);renderOrders(d.orders||[],d.tpsl||[]);voice.update(d.allPositions||d.positions||[]);if(!$('oMargin').dataset.touched)applyRuleMargin();proj();}
function renderPos(list,tpsl){$('posBody').innerHTML=list.filter(p=>+p.positions!==0).map((p,i)=>{const sz=+p.positions,long=p.positionSide==='long'||(p.positionSide!=='short'&&sz>0);
  const t=tpsl.find(x=>x.instId===p.instId)||{};const pnl=+p.unrealizedPnl||0;
  return `<tr><td>${p.instId}</td><td class="${long?'pos':'neg'}">${long?'Long':'Short'} ${p.leverage||''}x</td><td>${Math.abs(sz)}</td><td>${fmt(p.averagePrice,6)}</td><td>${fmt(p.markPrice,6)}</td><td class="${pnl>=0?'pos':'neg'}">${pnl>=0?'+':''}${fmt(pnl)}</td>
  <td><input data-i="${i}" data-k="tp" value="${p.tp||t.tpTriggerPrice||''}"></td><td><input data-i="${i}" data-k="sl" value="${p.sl||t.slTriggerPrice||''}"></td>
  <td style="white-space:nowrap"><button class="b" data-set="${i}">Set</button> <button class="b" data-close="${i}">Close</button> <button class="b" data-share="${i}" title="Copy PnL badge">⇪</button></td></tr>`}).join('')||'<tr><td colspan="9" style="color:#6c7593">No open positions</td></tr>';
 const live=list.filter(p=>+p.positions!==0);
 Q('[data-set]').forEach(b=>b.onclick=async()=>{const p=live[b.dataset.set];const tp=root.querySelector(`input[data-i="${b.dataset.set}"][data-k=tp]`).value,sl=root.querySelector(`input[data-i="${b.dataset.set}"][data-k=sl]`).value;
   const long=p.positionSide==='long'||(p.positionSide!=='short'&&+p.positions>0);const r=await ipc.invoke('tr:set-tpsl',ex,{instId:p.instId,side:long?'sell':'buy',tp,sl});act(r.ok?'TP/SL set on '+p.instId:'TP/SL failed: '+r.error)});
 Q('[data-close]').forEach(b=>b.onclick=async()=>{const p=live[b.dataset.close];if(!confirm('Close '+p.instId+' at market?'))return;const r=await ipc.invoke('tr:close',ex,p);act(r.ok?'Close sent for '+p.instId:'Close failed: '+r.error)});
 Q('[data-share]').forEach(b=>b.onclick=async()=>{const r=await share(live[b.dataset.share]);act(r.ok?'PnL badge copied to clipboard':'Badge failed')});}
function badge(p){const c=document.createElement('canvas');c.width=640;c.height=340;const g=c.getContext('2d');const pnl=+p.unrealizedPnl||0,up=pnl>=0;
 const sz=Math.abs(+p.positions),long=p.positionSide==='long'||(p.positionSide!=='short'&&+p.positions>0);const m=+p.margin||(sz*(+p.averagePrice||0)*((instMeta[p.instId]||{}).contractValue||1)/(+p.leverage||5));const roe=m?pnl/m*100:0;
 const bg=g.createLinearGradient(0,0,640,340);bg.addColorStop(0,'#0b1024');bg.addColorStop(1,up?'#0c2a2a':'#2a0c1e');g.fillStyle=bg;g.fillRect(0,0,640,340);
 g.fillStyle='rgba(139,92,246,.35)';g.fillRect(0,0,640,6);g.font='600 18px Segoe UI';g.fillStyle='#a5b4fc';g.fillText('Custom Hermes · '+({b:'B Trading · BloFin',p:'P Trading · Propr',c:'C Trading · Coinbase'})[ex],32,44);
 g.font='700 34px Segoe UI';g.fillStyle='#fff';g.fillText(p.instId,32,98);g.font='600 20px Segoe UI';g.fillStyle=long?'#34d399':'#fb7185';g.fillText((long?'LONG ':'SHORT ')+(p.leverage||'')+'x',32,130);
 g.font='800 72px Segoe UI';g.fillStyle=up?'#34d399':'#fb7185';g.fillText((up?'+':'')+roe.toFixed(2)+'%',32,215);g.font='600 26px Segoe UI';g.fillText((up?'+':'')+fmt(pnl)+' '+cur,32,255);
 g.font='16px Segoe UI';g.fillStyle='#9aa4c4';g.fillText('Entry '+fmt(p.averagePrice,6)+'    Mark '+fmt(p.markPrice,6),32,300);g.fillText(new Date().toLocaleString(),400,300);return c.toDataURL('image/png');}
async function share(p){return ipc.invoke('tr:share',badge(p));}
function renderInfo(i,pos){const el=$('pInfo');el.style.display='block';const m=(v,d=2)=>v==null?'–':fmt(v,d);const src=s=>s&&s!=='api'?` <i class="src">(${s})</i>`:'';
 const near=(dist,budget)=>dist!=null&&budget?dist<=budget*0.25:false;const ddW=near(i.distFloor,i.ddBudget),dlW=near(i.dailyRemaining,i.dailyLimit);
 const now=new Date(),rs=new Date(now);rs.setUTCHours(24,0,0,0);const hrs=((rs-now)/36e5).toFixed(1);
 const risk=pos.map(p=>{const q=Math.abs(+p.positions),sl=+p.sl,e=+p.averagePrice;return `${p.instId.split('-')[0]} ${p.positionSide}: ${sl?'risk to SL '+fmt(q*Math.abs(e-sl))+' USDC':'<b class="neg">NO STOP</b>'}`}).join(' · ')||'none';
 el.innerHTML=`<h3>${(i.name||'').replace(/[<>&]/g,'')} <span class="tag">${i.type} · ${String(i.status).replace(/[<>&]/g,'')}${i.tier?' · '+String(i.tier).replace(/[<>&]/g,''):''}${i.phase!=null?' · phase '+i.phase:''}</span></h3>
 <div class="kv"><span>Account size</span><b>${m(i.size)}</b><span>Equity / balance</span><b>${m(i.eq)} / ${m(i.bal)}</b><span>Unrealized PnL</span><b class="${i.upnl>=0?'pos':'neg'}">${i.upnl>=0?'+':''}${m(i.upnl)}</b>
 <span>Profit target</span><b>${m(i.target)}${src(i.targetSrc)}${i.progress!=null?' · '+i.progress.toFixed(1)+'%':''}</b>
 <span>Max drawdown floor</span><b class="${ddW?'warn':''}">${m(i.floor)}${i.trailing?' trailing':' fixed'}${i.ddPct!=null?' ('+i.ddPct+(i.ddPct<=100?'%':'')+')':''}${src(i.floorSrc)} · ${m(i.distFloor)} away</b>
 <span>Daily loss limit</span><b class="${dlW?'warn':''}">${m(i.dailyLimit)}${src(i.dailySrc)} · used today ${m(i.usedToday)}${i.dailyRemaining!=null?' · left '+m(i.dailyRemaining):''} <i class="src">(today derived; resets 00:00 UTC = 8 PM ET, in ${hrs}h)</i></b>
 <span>Open risk</span><b>${risk}</b>
 <span>Trades</span><b>${i.wins}W / ${i.losses}L${i.winRate!=null?' · win rate '+i.winRate.toFixed(0)+'%':''} · today ${i.todayRealized>=0?'+':''}${m(i.todayRealized)}</b>
 <span>Payout (${i.split}% split)</span><b>${i.payoutAvail!=null?m(i.payoutAvail)+' available · ':''}${i.payoutEligible} <i class="src">(derived)</i></b>${i.failureReason?`<span>Failure</span><b class="neg">${String(i.failureReason).replace(/[<>&]/g,'')}</b>`:''}</div>
 ${ddW||dlW?'<div class="warnbar">⚠ Within 25% of '+(ddW?'max drawdown floor':'')+(ddW&&dlW?' and ':'')+(dlW?'daily loss limit':'')+'</div>':''}
 <table style="margin-top:10px"><thead><tr><th>Closed</th><th>Side</th><th>PnL</th><th>When</th></tr></thead><tbody>${(i.trades||[]).map(x=>`<tr><td>${String(x.inst).replace(/[<>&]/g,'')}${x.liq?' (liq)':''}</td><td>${x.side||''}</td><td class="${x.pnl>0?'pos':x.pnl<0?'neg':''}">${x.pnl>0?'Winner +':x.pnl<0?'Loser ':'Breakeven '}${fmt(x.pnl)}</td><td>${x.at?new Date(x.at).toLocaleString():''}</td></tr>`).join('')||'<tr><td colspan="4" style="color:#6c7593">No closed trades</td></tr>'}</tbody></table>`;}
function renderAccts(list,sel){acctSel=sel;const el=$('acctSeg');const h=list.map(a=>`<button data-a="${a.id}" class="${a.id===sel?'on':''}">${a.label.replace(/[<>&]/g,'')}</button>`).join('');if(el.dataset.h!==h){el.innerHTML=h;el.dataset.h=h;
 el.querySelectorAll('button').forEach(b=>b.onclick=()=>{acctSel=b.dataset.a;el.dataset.h='';poll()});}el.style.display=list.length?'flex':'none';}
function renderOrders(o,t){$('ordBody').innerHTML=o.map((x,i)=>`<tr><td>${x.instId}</td><td class="${x.side==='buy'?'pos':'neg'}">${x.side}</td><td>${x.orderType}</td><td>${fmt(x.price,6)}</td><td>${x.size}</td><td><button class="b" data-co="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="6" style="color:#6c7593">None</td></tr>';
 $('tpslBody').innerHTML=t.map((x,i)=>`<tr><td>${x.instId}</td><td class="pos">${x.tpTriggerPrice||'–'}</td><td class="neg">${x.slTriggerPrice||'–'}</td><td><button class="b" data-ct="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="4" style="color:#6c7593">None</td></tr>';
 Q('[data-co]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',ex,o[b.dataset.co]);act(r.ok?'Order cancelled':'Cancel failed: '+r.error)});
 Q('[data-ct]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',ex,t[b.dataset.ct]);act(r.ok?'TP/SL cancelled':'Cancel failed: '+r.error)});}
// ---------- order form ----------
const ruleMargin=()=>Math.max(1.5,equity*0.10);
function applyRuleMargin(){$('oMargin').value=ruleMargin().toFixed(2);if(avail>0)$('oPct').value=Math.min(100,Math.max(1,Math.round(ruleMargin()/avail*100)));$('pctLbl').textContent=$('oPct').value+'%';}
Q('#typeSeg button').forEach(b=>b.onclick=()=>{otype=b.dataset.t;Q('#typeSeg button').forEach(x=>x.classList.toggle('on',x===b));$('limitRow').style.display=otype==='limit'?'block':'none';proj()});
$('oPct').oninput=()=>{$('pctLbl').textContent=$('oPct').value+'%';$('oMargin').value=((avail||equity)*$('oPct').value/100).toFixed(2);$('oMargin').dataset.touched=1;proj()};
['oMargin','oLev','oTP','oSL','oPrice'].forEach(i=>$(i).addEventListener('input',()=>{if(i==='oMargin')$('oMargin').dataset.touched=1;proj()}));
function calc(dir){const entry=otype==='limit'?+$('oPrice').value:lastPrice;const m=+$('oMargin').value,lev=+$('oLev').value,tp=+$('oTP').value,sl=+$('oSL').value;
 const qty=entry?m*lev/entry:0;const tpP=tp?qty*(tp-entry)*dir:0,slP=sl?qty*(sl-entry)*dir:0;const rr=slP<0&&tpP>0?tpP/-slP:0;return {entry,m,lev,tp,sl,qty,tpP,slP,rr}}
function proj(){const L=calc(1),S=calc(-1);const c=$('oTP').value&&$('oSL').value?(+$('oTP').value>+$('oSL').value?L:S):L;
 $('proj').innerHTML=`<span>Entry</span><b>${fmt(c.entry,6)}</b><span>Notional</span><b>${fmt(c.m*c.lev)} ${cur}</b><span>At TP</span><b class="pos">${c.tpP?'+'+fmt(c.tpP):'–'}</b><span>At SL</span><b class="neg">${c.slP?fmt(c.slP):'–'}</b><span>R:R</span><b class="${c.rr>=2.5?'pos':'neg'}">${c.rr?c.rr.toFixed(2):'–'}</b><span>Rule margin</span><b>${fmt(ruleMargin())}</b>`;}
function validate(dir){const c=calc(dir);const e=[];if(!c.entry)e.push('No price yet');if(!c.sl)e.push('Stop loss is required');
 if(c.sl&&((dir>0&&c.sl>=c.entry)||(dir<0&&c.sl<=c.entry)))e.push('Stop loss is on the wrong side of entry');
 if(c.tp&&((dir>0&&c.tp<=c.entry)||(dir<0&&c.tp>=c.entry)))e.push('Take profit is on the wrong side of entry');
 if(!c.tp||c.rr<2.5)e.push('R:R must be at least 2.5 (now '+(c.rr?c.rr.toFixed(2):'–')+')');
 if(c.m<1.5)e.push('Margin must be at least 1.50 '+cur+'');if(c.lev!==5)e.push('Leverage rule is 5x');
 const meta=instMeta[inst];let size=0;if(meta){const cv=+meta.contractValue||1,lot=+meta.lotSize||1;size=Math.floor(c.qty/cv/lot)*lot;size=+size.toFixed(8);if(size<(+meta.minSize||lot))e.push('Size below instrument minimum; raise margin')}else e.push('Instrument data not loaded');
 return {e,c,size}}
async function send(dir){const v=validate(dir);if(v.e.length){setMsg('orderMsg',v.e.join(' · '),'err');return}
 if(!confirm(`${dir>0?'LONG':'SHORT'} ${inst} ${otype} · ${v.size} contracts · margin ${fmt(v.c.m)} ${cur} · ${v.c.lev}x isolated\nTP ${v.c.tp}  SL ${v.c.sl}  (${({b:'BloFin '+mode.toUpperCase(),p:'Propr '+(acctSel||''),c:'Coinbase LIVE'})[ex]})\nSend this order?`))return;
 const r=await ipc.invoke('tr:order',ex,{instId:inst,side:dir>0?'buy':'sell',orderType:otype,price:v.c.entry,size:v.size,leverage:v.c.lev,tpTriggerPrice:v.c.tp,slTriggerPrice:v.c.sl});
 setMsg('orderMsg',r.ok?'Order sent.':r.error,r.ok?'ok':'err');act(r.ok?`Order sent ${inst} ${dir>0?'long':'short'}`:'Order failed: '+r.error);}
$('goLong').onclick=()=>send(1);$('goShort').onclick=()=>send(-1);
// ---------- chart & instruments ----------
let chart,series;function initChart(){if(chart)return;chart=LightweightCharts.createChart($('chart'),{layout:{background:{color:'transparent'},textColor:'#9aa4c4',fontFamily:'Inter,Segoe UI,sans-serif'},grid:{vertLines:{color:'rgba(140,160,255,.06)'},horzLines:{color:'rgba(140,160,255,.06)'}},rightPriceScale:{borderColor:'rgba(140,160,255,.14)'},timeScale:{borderColor:'rgba(140,160,255,.14)',timeVisible:true},crosshair:{mode:0},autoSize:true});
 series=chart.addCandlestickSeries({upColor:'#22d3ee',downColor:'#8b5cf6',borderVisible:false,wickUpColor:'#22d3ee',wickDownColor:'#8b5cf6'});}
async function loadCandles(fit){initChart();const r=await ipc.invoke('tr:candles',ex,inst,bar);if(!r.ok){act('Chart: '+r.error);return}
 const data=r.data.map(c=>({time:Math.floor(+c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4]})).sort((a,b)=>a.time-b.time);series.setData(data);
 if(data.length){lastPrice=data[data.length-1].close;$('lastPx').textContent=fmt(lastPrice,6)}if(fit)chart.timeScale().fitContent();proj();}
$('resetChart').onclick=()=>{chart.timeScale().resetTimeScale();chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().fitContent()};
$('barSel').onchange=()=>{bar=$('barSel').value;loadCandles(true)};
$('instSearch').oninput=()=>{const q=$('instSearch').value.toUpperCase();const m=insts.filter(i=>i.includes(q)).slice(0,60);$('instList').innerHTML=m.map(i=>`<div>${i}</div>`).join('');$('instList').style.display=m.length?'block':'none';
 $('instList').querySelectorAll('div').forEach(d=>d.onclick=()=>{inst=d.textContent;$('instSearch').value=inst;$('instList').style.display='none';loadCandles(true)})};
$('instSearch').onblur=()=>setTimeout(()=>$('instList').style.display='none',200);
let started=false;
async function start(){if(started)return;started=true;
 const r=await ipc.invoke('tr:instruments',ex);if(r.ok){r.data.forEach(i=>instMeta[i.instId]=i);insts=r.data.map(i=>i.instId).sort();if(!instMeta[inst]&&insts.length){inst=insts.find(i=>/^BTC|^BIP/.test(i))||insts[0];$('instSearch').value=inst}}
 await loadCandles(true);setInterval(()=>{if(root.style.display==='block')loadCandles(false)},15000);};
$('instSearch').value=inst;
return {start,connect,voice};}
const T={};for(const ex of ['b','p','c'])T[ex]=make(ex);
window.__trading=T;window.__startTrading=ex=>T[ex||'b'].start();
// auto-connect every tab with saved keys at app load so voice works without opening the tab (first poll is a silent baseline)
ipc.invoke('tr:prefs').then(pr=>{VQ.muted=!!pr.muted;document.querySelectorAll('.trading #muteBtn').forEach(b=>b.textContent=VQ.muted?'🔇 Voice muted':'🔊 Voice on');for(const ex in T)T[ex].connect();});
})();
