// Keeps Hermes cron prompts pointed at the credential file the user loaded in the B / C tab.
// Only paths and field descriptions are written into prompts; key values are never read here.
const fs=require('fs'),path=require('path'),os=require('os');const {execFile}=require('child_process');
const home=()=>process.env.CUSTOM_HERMES_HOME||path.join(os.homedir(),'Custom-Hermes','hermes-home');
const EXN={b:'BloFin',c:'Coinbase'};const RX={b:/blo\s*fin/i,c:/coinbase/i};const OTHER={b:/coinbase|propr|poly/i,c:/blo\s*fin|propr|poly/i};
const BEGIN='[CREDENTIALS · managed by Custom Hermes';const END='[/CREDENTIALS]';
function relevant(j,ex){const n=String(j.name||''),p=String(j.prompt||'');if(RX[ex].test(n))return true;return !OTHER[ex].test(n)&&RX[ex].test(p)&&!OTHER[ex].test(p.slice(0,400));}
function block(ex,file,fmt){const L=[BEGIN+']'];
  if(ex==='b')L.push('BloFin API credential file in use: "'+file+'"','File format: '+fmt+'.','It holds 3 BloFin fields: API key, secret, passphrase (all three are required for signed BloFin calls; mode live/demo if present).');
  else L.push('Coinbase API credential file in use: "'+file+'"','File format: '+fmt+'.','It holds 2 Coinbase fields: API key name (organizations/.../apiKeys/...) and private key (EC PEM or Ed25519). There is NO passphrase for this key - do not look for one.');
  L.push('Read the values from that file at run time. Never print, log or copy them. Ignore any other '+EXN[ex]+' credential path.',END);return L.join('\n');}
const PATH=/[A-Za-z]:\\[^"\r\n<>|?*]*?\.(?:txt|env|json|pem|key|cred|ya?ml|md)\b/g;
const CREDLINE=/credential|api|key|secret|passphrase|compendium|use exactly/i;
function rewrite(prompt,ex,file,fmt){let p=String(prompt||'');
  const i=p.indexOf(BEGIN);if(i>=0){const k=p.indexOf(END,i);p=(p.slice(0,i)+(k>=0?p.slice(k+END.length):'')).replace(/^\s+/,'');}
  p=p.split('\n').map(l=>CREDLINE.test(l)?l.replace(PATH,m=>(/lessons|memory|\.md$/i.test(m)?m:file)):l).join('\n');
  return block(ex,file,fmt)+'\n\n'+p;}
function readJobs(h){return JSON.parse(fs.readFileSync(path.join(h,'cron','jobs.json'),'utf8'));}
function hermes(h,args){return new Promise((res,rej)=>execFile(process.env.CUSTOM_HERMES_BIN||path.join(h,'bin','hermes.exe'),args,{env:{...process.env,HERMES_HOME:h,PYTHONIOENCODING:'utf-8'},windowsHide:true,timeout:60000,maxBuffer:1<<20},(e,o,er)=>e?rej(new Error(String(er||e.message).slice(0,200))):res(o)));}
// returns {updated,total,ids,backup} ; dry=true only computes
let Q=Promise.resolve();
function sync(...a){const p=Q.then(()=>sync1(...a));Q=p.catch(()=>{});return p;}
async function sync1(ex,file,fmt,dry){const h=home();const st=readJobs(h);const jobs=(st.jobs||[]).filter(j=>relevant(j,ex));
  const plan=jobs.map(j=>({id:j.id,name:j.name,state:j.state,enabled:j.enabled,old:j.prompt,neu:rewrite(j.prompt,ex,file,fmt)})).filter(x=>x.neu!==x.old);
  if(dry||!plan.length)return {updated:0,total:jobs.length,plan};
  const bd=path.join(h,'cron','backups');fs.mkdirSync(bd,{recursive:true});const backup=path.join(bd,'jobs.'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  fs.copyFileSync(path.join(h,'cron','jobs.json'),backup);let n=0;const errs=[];
  for(const x of plan){try{await hermes(h,['cron','edit',x.id,'--prompt',x.neu]);n++}catch(e){errs.push(x.name+': '+e.message)}}
  const after=readJobs(h).jobs||[];const bad=plan.filter(x=>{const a=after.find(j=>j.id===x.id);return !a||a.prompt!==x.neu||a.state!==x.state||a.enabled!==x.enabled});
  return {updated:n-bad.length,total:jobs.length,backup,errors:errs.concat(bad.map(b=>b.name+': not verified'))};}
module.exports={sync,rewrite,relevant,home};
