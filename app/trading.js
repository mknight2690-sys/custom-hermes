// Custom Hermes Trading tab (renderer). Secrets only flow renderer->main on Save; never read back.
(()=>{const ipc=require('electron').ipcRenderer;const $=id=>document.getElementById(id);
let mode='demo',otype='market',equity=0,avail=0,inst='BTC-USDT',bar='15m',insts=[],instMeta={},lastPrice=0,connected=false,timer=null;
const fmt=(n,d=2)=>isFinite(+n)?(+n).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:Math.min(d,2)}):'–';
const act=t=>{const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+'  '+t;$('actLog').prepend(d);while($('actLog').children.length>80)$('actLog').lastChild.remove();};
const setMsg=(id,t,c)=>{$(id).textContent=t||'';$(id).className='msg '+(c||'')};
// ---------- voice ----------
const voice={muted:false,q:[],speaking:false,base:null,gone:{},
 say(t){if(this.muted)return;if(this.q.length>=4)this.q.shift();this.q.push(t);this.pump()},
 pump(){if(this.speaking||!this.q.length)return;const t=this.q.shift();this.speaking=true;
   const done=()=>{this.speaking=false;setTimeout(()=>this.pump(),250)};ipc.invoke('tr:speak',t).then(done,done);},
 rebase(){this.base=null;this.gone={};this.pnl={};this.q=[];ipc.send('tr:speakstop');this.speaking=false},
 key:p=>{const sz=+p.positions;const side=p.positionSide&&p.positionSide!=='net'?p.positionSide:(sz>=0?'long':'short');return p.instId+'|'+side},
 label:k=>{const[i,s]=k.split('|');return i.split('-')[0]+' '+s},
 pnl:{},res(k){const v=this.pnl[k];return v===undefined||isNaN(v)?'':v>0?', winner':v<0?', loser':', breakeven'},
 update(list){const live=(list||[]).filter(p=>+p.positions!==0);for(const p of live)this.pnl[this.key(p)]=parseFloat(p.unrealizedPnl);const now=new Set(live.map(this.key));
  if(this.base===null){this.base=now;return}
  for(const k of now){if(!this.base.has(k)){this.say(this.label(k)+' opened');act(this.label(k)+' opened')}delete this.gone[k]}
  for(const k of this.base){if(!now.has(k)){this.gone[k]=(this.gone[k]||0)+1;if(this.gone[k]>=2){const m=this.label(k)+' closed'+this.res(k);this.say(m);act(m);delete this.gone[k];delete this.pnl[k]}else now.add(k)}}
  this.base=now;}};
window.__voice=voice;
// ---------- connection panel ----------
document.querySelectorAll('#trading .pw span').forEach(s=>s.onclick=()=>{const i=$(s.dataset.t);i.type=i.type==='password'?'text':'password';s.textContent=i.type==='password'?'show':'hide'});
const setMode=m=>{mode=m;document.querySelectorAll('#modeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.m===m))};
document.querySelectorAll('#modeSeg button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
$('pickFile').onclick=async()=>{const r=await ipc.invoke('tr:parse-file');if(r.cancelled)return;
 if(r.fields){if(r.fields.apiKey)$('fKey').value=r.fields.apiKey;if(r.fields.secret)$('fSecret').value=r.fields.secret;if(r.fields.passphrase)$('fPass').value=r.fields.passphrase;if(r.fields.mode)setMode(r.fields.mode)}
 const names={apiKey:'API key',secret:'Secret',passphrase:'Passphrase',mode:'Mode'};
 $('foundChips').innerHTML=['apiKey','secret','passphrase','mode'].map(k=>`<span class="chip ${r.found&&r.found.includes(k)?'':'miss'}">${r.found&&r.found.includes(k)?'✓':'✗'} ${names[k]}</span>`).join('');
 setMsg('connMsg',r.ok?`Filled from ${r.file}. Review, then Save.`:(r.error||'Could not read file'),r.ok?'ok':'err');};
$('saveCreds').onclick=async()=>{const r=await ipc.invoke('tr:save',{apiKey:$('fKey').value,secret:$('fSecret').value,passphrase:$('fPass').value,mode});
 if(r.ok){['fKey','fSecret','fPass'].forEach(i=>{$(i).value='';$(i).placeholder='saved '+(i==='fKey'?r.keyMask:'••••')});setMsg('connMsg','Saved encrypted on this PC ('+mode+').','ok');voice.rebase();connect();}else setMsg('connMsg',r.error,'err');};
$('testConn').onclick=async()=>{setMsg('connMsg','Testing…');const r=await ipc.invoke('tr:test');setMsg('connMsg',r.ok?'Connected. Balance call succeeded.':r.error,r.ok?'ok':'err');};
$('forget').onclick=async()=>{await ipc.invoke('tr:forget');connected=false;voice.rebase();$('connTag').textContent='not connected';setMsg('connMsg','Keys removed from this PC.');};
const setMute=m=>{voice.muted=m;$('muteBtn').textContent=m?'🔇 Voice muted':'🔊 Voice on';if(m)ipc.send('tr:speakstop');};
$('muteBtn').onclick=()=>{setMute(!voice.muted);ipc.invoke('tr:prefs',{muted:voice.muted})};
// ---------- account polling ----------
async function connect(){const st=await ipc.invoke('tr:status');setMode(st.mode);
 if(st.saved){$('fKey').placeholder='saved '+st.keyMask;$('fSecret').placeholder=$('fPass').placeholder='saved ••••'}
 if(!st.saved&&!st.mock){$('connTag').textContent='not connected';return}
 connected=true;$('connTag').textContent=(st.mock?'mock':st.mode)+' · connected';clearInterval(timer);poll();timer=setInterval(poll,4000);}
let failStreak=0;
async function poll(){const r=await ipc.invoke('tr:snapshot');
 if(!r.ok){failStreak++;if(failStreak===1)act('Sync error: '+r.error);if(failStreak>=3)voice.rebase();$('connTag').textContent='sync error';return}
 if(failStreak)$('connTag').textContent=mode+' · connected';failStreak=0;const d=r.data;
 const b=Array.isArray(d.balance)?d.balance[0]:d.balance;const det=(b.details||[]).find(x=>x.currency==='USDT')||{};
 equity=+b.totalEquity||+det.equity||0;avail=+det.available||+det.availableEquity||0;
 const used=Math.max(0,(+det.frozen||0)+(+det.isolatedEquity||+b.isolatedEquity||0));const upnl=(d.positions||[]).reduce((s,p)=>s+(+p.unrealizedPnl||0),0);
 $('sEq').textContent=fmt(equity)+' USDT';$('sAv').textContent=fmt(avail);$('sMu').textContent=fmt(used);$('sPnl').textContent=(upnl>=0?'+':'')+fmt(upnl);$('sPnl').className=upnl>=0?'pos':'neg';
 renderPos(d.positions||[],d.tpsl||[]);renderOrders(d.orders||[],d.tpsl||[]);voice.update(d.positions||[]);if(!$('oMargin').dataset.touched)applyRuleMargin();proj();}
function renderPos(list,tpsl){$('posBody').innerHTML=list.filter(p=>+p.positions!==0).map((p,i)=>{const sz=+p.positions,long=p.positionSide==='long'||(p.positionSide!=='short'&&sz>0);
  const t=tpsl.find(x=>x.instId===p.instId)||{};const pnl=+p.unrealizedPnl||0;
  return `<tr><td>${p.instId}</td><td class="${long?'pos':'neg'}">${long?'Long':'Short'} ${p.leverage||''}x</td><td>${Math.abs(sz)}</td><td>${fmt(p.averagePrice,6)}</td><td>${fmt(p.markPrice,6)}</td><td class="${pnl>=0?'pos':'neg'}">${pnl>=0?'+':''}${fmt(pnl)}</td>
  <td><input data-i="${i}" data-k="tp" value="${p.tp||t.tpTriggerPrice||''}"></td><td><input data-i="${i}" data-k="sl" value="${p.sl||t.slTriggerPrice||''}"></td>
  <td><button class="b" data-set="${i}">Set</button> <button class="b" data-close="${i}">Close</button></td></tr>`}).join('')||'<tr><td colspan="9" style="color:#6c7593">No open positions</td></tr>';
 const live=list.filter(p=>+p.positions!==0);
 document.querySelectorAll('[data-set]').forEach(b=>b.onclick=async()=>{const p=live[b.dataset.set];const tp=document.querySelector(`input[data-i="${b.dataset.set}"][data-k=tp]`).value,sl=document.querySelector(`input[data-i="${b.dataset.set}"][data-k=sl]`).value;
   const long=p.positionSide==='long'||(p.positionSide!=='short'&&+p.positions>0);const r=await ipc.invoke('tr:set-tpsl',{instId:p.instId,side:long?'sell':'buy',tp,sl});act(r.ok?'TP/SL set on '+p.instId:'TP/SL failed: '+r.error)});
 document.querySelectorAll('[data-close]').forEach(b=>b.onclick=async()=>{const p=live[b.dataset.close];if(!confirm('Close '+p.instId+' at market?'))return;const r=await ipc.invoke('tr:close',p);act(r.ok?'Close sent for '+p.instId:'Close failed: '+r.error)});}
function renderOrders(o,t){$('ordBody').innerHTML=o.map((x,i)=>`<tr><td>${x.instId}</td><td class="${x.side==='buy'?'pos':'neg'}">${x.side}</td><td>${x.orderType}</td><td>${fmt(x.price,6)}</td><td>${x.size}</td><td><button class="b" data-co="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="6" style="color:#6c7593">None</td></tr>';
 $('tpslBody').innerHTML=t.map((x,i)=>`<tr><td>${x.instId}</td><td class="pos">${x.tpTriggerPrice||'–'}</td><td class="neg">${x.slTriggerPrice||'–'}</td><td><button class="b" data-ct="${i}">✕</button></td></tr>`).join('')||'<tr><td colspan="4" style="color:#6c7593">None</td></tr>';
 document.querySelectorAll('[data-co]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',o[b.dataset.co]);act(r.ok?'Order cancelled':'Cancel failed: '+r.error)});
 document.querySelectorAll('[data-ct]').forEach(b=>b.onclick=async()=>{const r=await ipc.invoke('tr:cancel',t[b.dataset.ct]);act(r.ok?'TP/SL cancelled':'Cancel failed: '+r.error)});}
// ---------- order form ----------
const ruleMargin=()=>Math.max(1.5,equity*0.10);
function applyRuleMargin(){$('oMargin').value=ruleMargin().toFixed(2);if(avail>0)$('oPct').value=Math.min(100,Math.max(1,Math.round(ruleMargin()/avail*100)));$('pctLbl').textContent=$('oPct').value+'%';}
document.querySelectorAll('#typeSeg button').forEach(b=>b.onclick=()=>{otype=b.dataset.t;document.querySelectorAll('#typeSeg button').forEach(x=>x.classList.toggle('on',x===b));$('limitRow').style.display=otype==='limit'?'block':'none';proj()});
$('oPct').oninput=()=>{$('pctLbl').textContent=$('oPct').value+'%';$('oMargin').value=((avail||equity)*$('oPct').value/100).toFixed(2);$('oMargin').dataset.touched=1;proj()};
['oMargin','oLev','oTP','oSL','oPrice'].forEach(i=>$(i).addEventListener('input',()=>{if(i==='oMargin')$('oMargin').dataset.touched=1;proj()}));
function calc(dir){const entry=otype==='limit'?+$('oPrice').value:lastPrice;const m=+$('oMargin').value,lev=+$('oLev').value,tp=+$('oTP').value,sl=+$('oSL').value;
 const qty=entry?m*lev/entry:0;const tpP=tp?qty*(tp-entry)*dir:0,slP=sl?qty*(sl-entry)*dir:0;const rr=slP<0&&tpP>0?tpP/-slP:0;return {entry,m,lev,tp,sl,qty,tpP,slP,rr}}
function proj(){const L=calc(1),S=calc(-1);const c=$('oTP').value&&$('oSL').value?(+$('oTP').value>+$('oSL').value?L:S):L;
 $('proj').innerHTML=`<span>Entry</span><b>${fmt(c.entry,6)}</b><span>Notional</span><b>${fmt(c.m*c.lev)} USDT</b><span>At TP</span><b class="pos">${c.tpP?'+'+fmt(c.tpP):'–'}</b><span>At SL</span><b class="neg">${c.slP?fmt(c.slP):'–'}</b><span>R:R</span><b class="${c.rr>=2.5?'pos':'neg'}">${c.rr?c.rr.toFixed(2):'–'}</b><span>Rule margin</span><b>${fmt(ruleMargin())}</b>`;}
function validate(dir){const c=calc(dir);const e=[];if(!c.entry)e.push('No price yet');if(!c.sl)e.push('Stop loss is required');
 if(c.sl&&((dir>0&&c.sl>=c.entry)||(dir<0&&c.sl<=c.entry)))e.push('Stop loss is on the wrong side of entry');
 if(c.tp&&((dir>0&&c.tp<=c.entry)||(dir<0&&c.tp>=c.entry)))e.push('Take profit is on the wrong side of entry');
 if(!c.tp||c.rr<2.5)e.push('R:R must be at least 2.5 (now '+(c.rr?c.rr.toFixed(2):'–')+')');
 if(c.m<1.5)e.push('Margin must be at least 1.50 USDT');if(c.lev!==5)e.push('Leverage rule is 5x');
 const meta=instMeta[inst];let size=0;if(meta){const cv=+meta.contractValue||1,lot=+meta.lotSize||1;size=Math.floor(c.qty/cv/lot)*lot;size=+size.toFixed(8);if(size<(+meta.minSize||lot))e.push('Size below instrument minimum; raise margin')}else e.push('Instrument data not loaded');
 return {e,c,size}}
async function send(dir){const v=validate(dir);if(v.e.length){setMsg('orderMsg',v.e.join(' · '),'err');return}
 if(!confirm(`${dir>0?'LONG':'SHORT'} ${inst} ${otype} · ${v.size} contracts · margin ${fmt(v.c.m)} USDT · ${v.c.lev}x isolated\nTP ${v.c.tp}  SL ${v.c.sl}  (${mode.toUpperCase()})\nSend this order?`))return;
 const r=await ipc.invoke('tr:order',{instId:inst,side:dir>0?'buy':'sell',orderType:otype,price:v.c.entry,size:v.size,leverage:v.c.lev,tpTriggerPrice:v.c.tp,slTriggerPrice:v.c.sl});
 setMsg('orderMsg',r.ok?'Order sent.':r.error,r.ok?'ok':'err');act(r.ok?`Order sent ${inst} ${dir>0?'long':'short'}`:'Order failed: '+r.error);}
$('goLong').onclick=()=>send(1);$('goShort').onclick=()=>send(-1);
// ---------- chart & instruments ----------
let chart,series;function initChart(){if(chart)return;chart=LightweightCharts.createChart($('chart'),{layout:{background:{color:'transparent'},textColor:'#9aa4c4',fontFamily:'Inter,Segoe UI,sans-serif'},grid:{vertLines:{color:'rgba(140,160,255,.06)'},horzLines:{color:'rgba(140,160,255,.06)'}},rightPriceScale:{borderColor:'rgba(140,160,255,.14)'},timeScale:{borderColor:'rgba(140,160,255,.14)',timeVisible:true},crosshair:{mode:0},autoSize:true});
 series=chart.addCandlestickSeries({upColor:'#22d3ee',downColor:'#8b5cf6',borderVisible:false,wickUpColor:'#22d3ee',wickDownColor:'#8b5cf6'});}
async function loadCandles(fit){initChart();const r=await ipc.invoke('tr:candles',inst,bar);if(!r.ok){act('Chart: '+r.error);return}
 const data=r.data.map(c=>({time:Math.floor(+c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4]})).sort((a,b)=>a.time-b.time);series.setData(data);
 if(data.length){lastPrice=data[data.length-1].close;$('lastPx').textContent=fmt(lastPrice,6)}if(fit)chart.timeScale().fitContent();proj();}
$('resetChart').onclick=()=>{chart.timeScale().resetTimeScale();chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().fitContent()};
$('barSel').onchange=()=>{bar=$('barSel').value;loadCandles(true)};
$('instSearch').oninput=()=>{const q=$('instSearch').value.toUpperCase();const m=insts.filter(i=>i.includes(q)).slice(0,60);$('instList').innerHTML=m.map(i=>`<div>${i}</div>`).join('');$('instList').style.display=m.length?'block':'none';
 $('instList').querySelectorAll('div').forEach(d=>d.onclick=()=>{inst=d.textContent;$('instSearch').value=inst;$('instList').style.display='none';loadCandles(true)})};
$('instSearch').onblur=()=>setTimeout(()=>$('instList').style.display='none',200);
let started=false;window.__startTrading=async()=>{if(started){chart&&chart.timeScale();return}started=true;
 const pr=await ipc.invoke('tr:prefs');setMute(!!pr.muted);
 const r=await ipc.invoke('tr:instruments');if(r.ok){r.data.forEach(i=>instMeta[i.instId]=i);insts=r.data.map(i=>i.instId).sort()}
 await loadCandles(true);setInterval(()=>loadCandles(false),15000);connect();};
})();
