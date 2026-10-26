// Custom Hermes Trading tab (renderer). Secrets only flow renderer->main on Save; never read back.
(()=>{const ipc=require('electron').ipcRenderer;
// one shared speech queue for all three tabs so announcements never overlap
const VQ={muted:false,q:[],speaking:false,say(t){if(this.muted||window.__CH_SILENT)return;if(this.q.length>=4)this.q.shift();this.q.push(t);this.pump()},
 pump(){if(this.speaking||!this.q.length)return;const t=this.q.shift();this.speaking=true;const done=()=>{this.speaking=false;setTimeout(()=>this.pump(),250)};ipc.invoke('tr:speak',t).then(done,done);},
 stop(){this.q=[];ipc.send('tr:speakstop');this.speaking=false}};
const DEF={b:'BTC-USDT',c:'BIP-20DEC30-CDE'};const PFX={b:'',c:'Coinbase '};
function make(ex){const root=document.getElementById('trTpl').content.firstElementChild.cloneNode(true);root.id='trading_'+ex;document.getElementById('trHost').appendChild(root);
 {const q=s=>root.querySelector(s);if(ex!=='b')q('#modeSeg').style.display='none';
  if(ex==='c'){q('.fpass').style.display='none';q('.lk').textContent='API key name (CDP organizations/…/apiKeys/… or legacy key)';q('.ls').textContent='Private key (PEM / Ed25519) or legacy secret';}
  q('#pickFile').textContent='📄 Select '+({b:'BloFin',c:'Coinbase'})[ex]+' API file';
 }
const $=id=>root.querySelector('#'+id);const Q=s=>root.querySelectorAll(s);
let cur='USDT',mode='demo',otype='market',equity=0,avail=0,inst=DEF[ex],bar='1H',insts=[],instMeta={},lastPrice=0,connected=false,timer=null;
const fmt=(n,d=2)=>isFinite(+n)?(+n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:Math.min(d,2)}):'–';
const act=t=>{const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+t;$('actLog').prepend(d);while($('actLog').children.length>80)$('actLog').lastChild.remove();};
const setMsg=(id,t,c)=>{$(id).textContent=t||'';$(id).className='msg '+(c||'')};
// ---------- voice ----------
const voice={base:null,gone:{},
 say(t){VQ.say(PFX[ex]+t)},
 rebase(){this.base=null;this.gone={};this.pnl={};VQ.stop()},
 key:p=>{const sz=+p.positions;const side=p.positionSide&&p.positionSide!=='net'?p.positionSide:(sz>=0?'long':'short');return p.instId+'|'+side},
 label:k=>{const[i,s]=k.split('|');return i.split('-')[0]+' '+s},
 pnl:{},last:{},opened:{},
 async closed(k){const[i,s]=k.split('|');const p=this.last[k]||{};const h=await ipc.invoke('tr:history',ex);
  let t=h.ok&&h.data.list.find(x=>x.inst===i&&x.dir===s&&Date.now()-x.close<10*60e3&&x.src!=='local log');
  if(!t)t=await ipc.invoke('tr:log-close',ex,{inst:i,dir:s,entry:p.averagePrice,exit:p.markPrice,size:Math.abs(+p.positions||0),pnl:this.pnl[k],open:this.opened[k]});
  const m=this.label(k)+' closed'+(t.pnl>0?', winner':t.pnl<0?', loser':', breakeven');this.say(m);act(m);delete this.pnl[k];delete this.last[k];loadHist();},
 update(list){const live=(list||[]).filter(p=>+p.positions!==0);for(const p of live){const k=this.key(p);this.pnl[k]=parseFloat(p.unrealizedPnl);this.last[k]=p;this.opened[k]??=Date.now();}const now=new Set(live.map(this.key));
  if(this.base===null){this.base=now;return}
  for(const k of now){if(!this.base.has(k)){this.say(this.label(k)+' opened');act(this.label(k)+' opened')}delete this.gone[k]}
  for(const k of this.base){if(!now.has(k)){this.gone[k]=(this.gone[k]||0)+1;if(this.gone[k]>=2){delete this.gone[k];this.closed(k)}else now.add(k)}}
  this.base=now;}};
window['__voice_'+ex]=voice;if(ex==='b')window.__voice=voice;
// ---------- connection panel ----------
Q('.pw span').forEach(s=>s.onclick=()=>{const i=$(s.dataset.t);i.type=i.type==='password'?'text':'password';s.textContent=i.type==='password'?'show':'hide'});
const setMode=m=>{mode=m;Q('#modeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.m===m))};
Q('#modeSeg button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
$('pickFile').onclick=async()=>{const r=await ipc.invoke('tr:parse-file',ex);if(r.cancelled)return;
 if(r.fields){if(r.fields.apiKey)$('fKey').value=r.fields.apiKey;if(r.fields.secret)$('fSecret').value=r.fields.secret;if(r.fields.passphrase)$('fPass').value=r.fields.passphrase;if(r.fields.mode)setMode(r.fields.mode)}
 const names={apiKey:ex==='c'?'API key name':'API key',secret:ex==='c'?'Private key / secret':'Secret',passphrase:'Passphrase',mode:'Mode'};
 $('foundChips').innerHTML=({b:['apiKey','secret','passphrase','mode'],c:['apiKey','secret']})[ex].map(k=>`<span class="chip ${r.found&&r.found.includes(k)?'':'miss'}">${r.found&&r.found.includes(k)?'✓':'✗'} ${names[k]}</span>`).join('');
 setMsg('connMsg',r.ok?`Filled from ${r.file}. Review, then Save.`:(r.error||'Could not read file'),r.ok?'ok':'err');
  pickedFile=r.ok;if(r.cron)showCron(r.cron);};
ipc.on('tr:cron',(e,x,c)=>{if(x===ex)showCron(c)});
function showCron(c){if(c.pending)return setMsg('cronMsg','updating Hermes cron prompts…');setMsg('cronMsg',c.skipped?'cron prompts not changed ('+c.skipped+')':c.error?'cron prompt update failed: '+c.error:`cron prompts updated for ${c.updated} jobs`+(c.total!==c.updated?` (${c.total} ${({b:'BloFin',c:'Coinbase'})[ex]} jobs checked)`:'')+((c.errors||[]).length?' · '+c.errors.join('; '):''),c.error||(c.errors||[]).length?'err':'ok');}
let pickedFile=false;
$('saveCreds').onclick=async()=>{const r=await ipc.invoke('tr:save',ex,{apiKey:$('fKey').value,secret:$('fSecret').value,passphrase:$('fPass').value,mode});
 if(r.ok){['fKey','fSecret','fPass'].forEach(i=>{$(i).value='';$(i).placeholder='saved '+(i==='fKey'?r.keyMask:'••••')});setMsg('connMsg','Saved encrypted on this PC'+(ex==='b'?' ('+mode+')':'')+'.','ok');voice.rebase();connect();if(!pickedFile)setMsg('cronMsg','Typed keys are stored only in this app; Hermes cron prompts unchanged (select a key file so crons can point to it).');}else setMsg('connMsg',r.error,'err');};
$('testConn').onclick=async()=>{setMsg('connMsg','Testing…');const r=await ipc.invoke('tr:test',ex);setMsg('connMsg',r.ok?'Connected. Balance call succeeded.':r.error,r.ok?'ok':'err');};
$('forget').onclick=async()=>{await ipc.invoke('tr:forget',ex);connected=false;voice.rebase();$('connTag').textContent='not connected';setMsg('connMsg','Keys removed from this PC.');};
const setMute=m=>{VQ.muted=m;document.querySelectorAll('.trading #muteBtn').forEach(b=>b.textContent=m?'🔇 Voice muted':'🔊 Voice on');if(m)VQ.stop();};
$('muteBtn').onclick=()=>{setMute(!VQ.muted);ipc.invoke('tr:prefs',{muted:VQ.muted})};
// ---------- account polling ----------
async function connect(){const st=await ipc.invoke('tr:status',ex);setMode(st.mode);cur=st.cur;Q('.cur').forEach(e=>e.textContent=cur);
 if(st.saved){$('fKey').placeholder='saved '+st.keyMask;$('fSecret').placeholder=$('fPass').placeholder='saved ••••'}
 if(!st.saved&&!st.mock){$('connTag').textContent='not connected';return}
 connected=true;loadHist();$('connTag').textContent=(st.mock?'mock':(ex==='b'?st.mode:'live'))+' · connected';clearInterval(timer);poll();timer=setInterval(poll,4000);}
let failStreak=0;
async function poll(){const r=await ipc.invoke('tr:snapshot',ex);
 if(!r.ok){failStreak++;if(failStreak===1)act('Sync error: '+r.error);if(failStreak>=3)voice.rebase();$('connTag').textContent='sync error';return}
 if(failStreak)$('connTag').textContent=(ex==='b'?mode:'live')+' · connected';failStreak=0;const d=r.data;if(Date.now()-histAt>30000)loadHist();
 const b=Array.isArray(d.balance)?d.balance[0]:d.balance;const det=(b.details||[]).find(x=>x.currency===cur)||(b.details||[])[0]||{};
 equity=+b.totalEquity||+det.equity||0;avail=+det.available||+det.availableEquity||0;
 const pm=p=>+p.margin||+p.initialMargin||+p.imr||0;const posM=(d.positions||[]).reduce((s,p)=>s+pm(p),0);const used=Math.max(0,posM||(+d.marginUsed||0)||((+det.isolatedEquity||+b.isolatedEquity||0)+(+det.frozen||0)));const upnl=(d.positions||[]).reduce((s,p)=>s+(+p.unrealizedPnl||0),0);
 $('sEq').textContent=fmt(equity)+' '+cur;$('sEqSub').textContent=d.cash?'USD '+fmt(d.cash.USD)+' · USDC '+fmt(d.cash.USDC):'';$('sAv').textContent=fmt(avail);$('sMu').textContent=fmt(used);$('sPos').textContent=String((d.positions||[]).filter(p=>+p.positions!==0).length);$('sPnl').textContent=(upnl>=0?'+':'')+fmt(upnl);$('sPnl').className=upnl>=0?'pos':'neg';
 renderPos(d.positions||[],d.tpsl||[]);renderOrders(d.orders||[],d.tpsl||[]);voice.update(d.positions||[]);lab();if(!$('oMargin').dataset.touched)applyRuleMargin();proj();}
let LP=[],LT=[],PL=[];function renderPos(list,tpsl){LP=list||[];LT=tpsl||[];try{drawLines()}catch(e){}$('posBody').innerHTML=list.filter(p=>+p.positions!==0).map((p,i)=>{const sz=+p.positions,long=p.positionSide==='long'||(p.positionSide!=='short'&&sz>0);
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
 const sz=Math.abs(+p.positions),long=p.positionSide==='long'||(p.positionSide!=='short'&&+p.positions>0);const m=+p.margin||+p.initialMargin||(sz*(+p.averagePrice||0)*((instMeta[p.instId]||{}).contractValue||1)/(+p.leverage||5));const roe=m?pnl/m*100:0;
 const bg=g.createLinearGradient(0,0,640,340);bg.addColorStop(0,'#0b1024');bg.addColorStop(1,up?'#0c2a2a':'#2a0c1e');g.fillStyle=bg;g.fillRect(0,0,640,340);
 g.fillStyle='rgba(139,92,246,.35)';g.fillRect(0,0,640,6);g.font='600 18px Segoe UI';g.fillStyle='#a5b4fc';g.fillText('Custom Hermes · '+({b:'B Trading · BloFin',c:'C Trading · Coinbase'})[ex],32,44);
 g.font='700 34px Segoe UI';g.fillStyle='#fff';g.fillText(p.instId,32,98);g.font='600 20px Segoe UI';g.fillStyle=long?'#34d399':'#fb7185';g.fillText((long?'LONG ':'SHORT ')+(p.leverage||'')+'x',32,130);
 g.font='800 72px Segoe UI';g.fillStyle=up?'#34d399':'#fb7185';g.fillText((up?'+':'')+roe.toFixed(2)+'%',32,215);g.font='600 26px Segoe UI';g.fillText((up?'+':'')+fmt(pnl)+' '+cur,32,255);
 g.font='16px Segoe UI';g.fillStyle='#9aa4c4';g.fillText('Entry '+fmt(p.averagePrice,6)+'    Mark '+fmt(p.markPrice,6),32,300);g.fillText(new Date().toLocaleString(),400,300);return c.toDataURL('image/png');}
async function share(p){return ipc.invoke('tr:share',badge(p));}
function renderOrders(o,t){$('ordBody').innerHTML=o.map((x,i)=>`<tr><td>${x.instId}</td><td class="${x.side==='buy'?'pos':'neg'}">${x.side}</td><td>${x.orderType}</td><td>${fmt(x.price,6)}</td><td>${x.size}</td><td><button class="b" data-co="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="6" style="color:#6c7593">None</td></tr>';
 $('tpslBody').innerHTML=t.map((x,i)=>`<tr><td>${x.instId}</td><td class="pos">${x.tpTriggerPrice||'–'}</td><td class="neg">${x.slTriggerPrice||'–'}</td><td><button class="b" data-ct="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="4" style="color:#6c7593">None</td></tr>';
 Q('[data-co]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',ex,o[b.dataset.co]);act(r.ok?'Order cancelled':'Cancel failed: '+r.error)});
 Q('[data-ct]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',ex,t[b.dataset.ct]);act(r.ok?'TP/SL cancelled':'Cancel failed: '+r.error)});}
// ---------- closed trade history ----------
let histAt=0;const esc=v=>String(v??'').replace(/[<>&"]/g,'');
const dur=ms=>{if(!(ms>0))return '–';const m=Math.round(ms/60000);return m<60?m+'m':m<1440?Math.floor(m/60)+'h '+(m%60)+'m':Math.floor(m/1440)+'d '+Math.floor(m%1440/60)+'h'};
const dt=t=>t?new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'–';
async function loadHist(){histAt=Date.now();const r=await ipc.invoke('tr:history',ex);if(!r.ok){$('histSrc').textContent='history unavailable: '+r.error;return}
 const {list,totals:t,source}=r.data;window['__hist_'+ex]=r.data;
 $('histBody').innerHTML=list.map(x=>`<tr><td>${esc(x.inst)}</td><td class="${x.dir==='long'?'pos':'neg'}">${x.dir==='long'?'Long':'Short'}</td><td>${fmt(x.entry,6)}</td><td>${fmt(x.exit,6)}</td><td>${fmt(x.size,6)}</td><td class="${x.pnl>0?'pos':x.pnl<0?'neg':''}">${x.pnl>0?'+':''}${fmt(x.pnl)}</td><td class="${x.pnl>0?'pos':x.pnl<0?'neg':''}">${x.pct==null?'–':(x.pct>0?'+':'')+fmt(x.pct)+'%'}</td><td>${dt(x.open)}</td><td>${dt(x.close)}</td><td>${dur(x.close-x.open)}</td><td><span class="wl ${x.result==='WINNER'?'win':x.result==='LOSER'?'lose':''}">${x.result}</span></td></tr>`).join('')||'<tr><td colspan="11" style="color:#6c7593">No closed trades yet</td></tr>';
 $('histTot').innerHTML=`<span>Wins <b class="pos">${t.wins}</b></span><span>Losses <b class="neg">${t.losses}</b></span><span>Win rate <b>${t.winRate==null?'–':fmt(t.winRate,1)+'%'}</b></span><span>Total PnL <b class="${t.pnl>=0?'pos':'neg'}">${t.pnl>=0?'+':''}${fmt(t.pnl)} ${cur}</b></span>`;
 $('histSrc').textContent='source: '+source+' · net of fees';lab();}
function lab(){root.querySelectorAll('table').forEach(tb=>{const h=[...tb.querySelectorAll('thead th')].map(th=>th.textContent);tb.querySelectorAll('tbody tr').forEach(tr=>[...tr.children].forEach((td,i)=>{if(h[i]&&!td.dataset.l)td.dataset.l=h[i]}))});}
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
 if(!confirm(`${dir>0?'LONG':'SHORT'} ${inst} ${otype} · ${v.size} contracts · margin ${fmt(v.c.m)} ${cur} · ${v.c.lev}x isolated\nTP ${v.c.tp}  SL ${v.c.sl}  (${({b:'BloFin '+mode.toUpperCase(),c:'Coinbase LIVE'})[ex]})\nSend this order?`))return;
 const r=await ipc.invoke('tr:order',ex,{instId:inst,side:dir>0?'buy':'sell',orderType:otype,price:v.c.entry,size:v.size,leverage:v.c.lev,tpTriggerPrice:v.c.tp,slTriggerPrice:v.c.sl});
 setMsg('orderMsg',r.ok?'Order sent.':r.error,r.ok?'ok':'err');act(r.ok?`Order sent ${inst} ${dir>0?'long':'short'}`:'Order failed: '+r.error);}
$('goLong').onclick=()=>send(1);$('goShort').onclick=()=>send(-1);
// ---------- chart & instruments ----------
let chart,series;function initChart(){if(chart)return;chart=LightweightCharts.createChart($('chart'),{layout:{background:{color:'transparent'},textColor:'#9aa4c4',fontFamily:'Inter,Segoe UI,sans-serif'},grid:{vertLines:{color:'rgba(140,160,255,.06)'},horzLines:{color:'rgba(140,160,255,.06)'}},rightPriceScale:{borderColor:'rgba(140,160,255,.14)'},timeScale:{borderColor:'rgba(140,160,255,.14)',timeVisible:true},crosshair:{mode:0},autoSize:true});
 {let lw=0,tm;new ResizeObserver(en=>{const w=Math.round(en[0].contentRect.width);if(w>0&&Math.abs(w-lw)>4){lw=w;clearTimeout(tm);tm=setTimeout(()=>chart.timeScale().fitContent(),120)}}).observe($('chartWrap'));}
 series=chart.addCandlestickSeries({upColor:'#22d3ee',downColor:'#8b5cf6',borderVisible:false,wickUpColor:'#22d3ee',wickDownColor:'#8b5cf6'});}
async function loadCandles(fit){initChart();const r=await ipc.invoke('tr:candles',ex,inst,bar);if(!r.ok){act('Chart: '+r.error);return}
 const data=r.data.map(c=>({time:Math.floor(+c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4]})).sort((a,b)=>a.time-b.time);series.setData(data);try{drawLines()}catch(e){}
 if(data.length){lastPrice=data[data.length-1].close;$('lastPx').textContent=fmt(lastPrice,6)}if(fit)chart.timeScale().fitContent();proj();}
$('resetChart').onclick=()=>{chart.timeScale().resetTimeScale();chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().fitContent()};
{const BB=()=>Q('#barBtns [data-bar]').forEach(b=>b.classList.toggle('on',b.dataset.bar===bar));try{const s=localStorage.getItem('ch_bar_'+ex);if(s&&['5m','15m','1H','4H','1D'].includes(s))bar=s}catch(e){}BB();Q('#barBtns [data-bar]').forEach(b=>b.onclick=()=>{bar=b.dataset.bar;try{localStorage.setItem('ch_bar_'+ex,bar)}catch(e){}BB();loadCandles(true)});}
$('instSearch').oninput=()=>{const q=$('instSearch').value.toUpperCase();const m=insts.filter(i=>i.includes(q)).slice(0,60);$('instList').innerHTML=m.map(i=>`<div>${i}</div>`).join('');$('instList').style.display=m.length?'block':'none';
 $('instList').querySelectorAll('div').forEach(d=>d.onclick=()=>{inst=d.textContent;$('instSearch').value=inst;$('instList').style.display='none';loadCandles(true)})};
$('instSearch').onblur=()=>setTimeout(()=>$('instList').style.display='none',200);
function drawLines(){if(!series)return;PL.forEach(l=>{try{series.removePriceLine(l)}catch(e){}});PL=[];
 LP.filter(p=>+p.positions!==0&&p.instId===inst).forEach(p=>{const t=LT.find(x=>x.instId===p.instId)||{};const add=(v,c,n)=>{v=+v;if(v>0)PL.push(series.createPriceLine({price:v,color:c,lineWidth:1,lineStyle:2,axisLabelVisible:true,title:n}))};
  add(p.averagePrice,'#9aa4c4','Entry');add(p.tp||t.tpTriggerPrice,'#22c55e','TP');add(p.sl||t.slTriggerPrice,'#ef4444','SL');});}
function goInst(s){s=(s||'').trim().split(/\s/)[0];if(!s||s===inst)return;if(insts.length&&!insts.includes(s)){const m=insts.find(i=>i.replace(/[-_]/g,'')===s.replace(/[-_]/g,''));if(!m)return;s=m}inst=s;$('instSearch').value=s;loadCandles(true).then(()=>{try{drawLines()}catch(e){}});try{$('chartWrap').scrollIntoView({block:'nearest',behavior:'smooth'})}catch(e){}}
root.addEventListener('click',e=>{if(e.target.closest('input,button,select,a'))return;const tr=e.target.closest('#posBody tr,#ordBody tr,#histBody tr,[data-inst]');if(!tr)return;const v=tr.dataset.inst||(tr.cells&&tr.cells.length>1?tr.cells[0].textContent:'');if(v)goInst(v)});
let started=false;
async function start(){if(started)return;started=true;
 const r=await ipc.invoke('tr:instruments',ex);if(r.ok){r.data.forEach(i=>instMeta[i.instId]=i);insts=r.data.map(i=>i.instId).sort();if(!instMeta[inst]&&insts.length){inst=insts.find(i=>/^BTC|^BIP/.test(i))||insts[0];$('instSearch').value=inst}}
 await loadCandles(true);setInterval(()=>{if(root.style.display==='block')loadCandles(false)},15000);};
$('instSearch').value=inst;
return {start,connect,voice};}
const T={};for(const ex of ['b','c'])T[ex]=make(ex);
window.__trading=T;window.__startTrading=ex=>T[ex||'b'].start();
// auto-connect every tab with saved keys at app load so voice works without opening the tab (first poll is a silent baseline)
ipc.invoke('tr:prefs').then(pr=>{VQ.muted=!!pr.muted;document.querySelectorAll('.trading #muteBtn').forEach(b=>b.textContent=VQ.muted?'🔇 Voice muted':'🔊 Voice on');for(const ex in T)T[ex].connect();});
})();
