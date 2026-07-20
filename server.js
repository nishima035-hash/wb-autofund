import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

loadEnv();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !/^[a-f0-9]{64}$/i.test(process.env.APP_ENCRYPTION_KEY || '')) throw new Error('В production задайте APP_ENCRYPTION_KEY: ровно 64 hex-символа');
if (isProduction && String(process.env.ADMIN_PASSWORD || '').length < 12) throw new Error('В production задайте ADMIN_PASSWORD длиной не менее 12 символов');
const DATA = join(process.cwd(), 'data');
mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(join(DATA, 'wb-autofund.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), token_enc TEXT, demo_mode INTEGER NOT NULL DEFAULT 1, check_minutes INTEGER NOT NULL DEFAULT 5, updated_at TEXT);
CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', budget REAL NOT NULL, ctr REAL NOT NULL, drr REAL NOT NULL, spend REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'demo', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, max_drr REAL NOT NULL, min_ctr REAL NOT NULL, min_budget REAL NOT NULL, deposit_amount INTEGER NOT NULL, daily_limit INTEGER NOT NULL, funding_type INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, campaign_name TEXT NOT NULL, created_at TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, amount INTEGER NOT NULL DEFAULT 0, budget_before REAL, budget_after REAL, ctr REAL, drr REAL, idempotency_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS locks (campaign_id INTEGER PRIMARY KEY, locked_until TEXT NOT NULL);
INSERT OR IGNORE INTO settings(id,demo_mode,check_minutes,updated_at) VALUES(1,1,5,datetime('now'));`);
migrateColumn('rules','use_max_drr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_min_ctr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_time_window','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','time_from','TEXT NOT NULL DEFAULT \'00:00\'');
migrateColumn('rules','time_to','TEXT NOT NULL DEFAULT \'23:59\'');
migrateColumn('settings','stats_days','INTEGER NOT NULL DEFAULT 7');
migrateColumn('campaigns','views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('campaigns','metrics_available','INTEGER NOT NULL DEFAULT 0');
migrateColumn('campaigns','metrics_from','TEXT');
migrateColumn('campaigns','metrics_to','TEXT');
migrateColumn('campaigns','orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','use_min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','use_min_orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','min_orders','INTEGER NOT NULL DEFAULT 0');
seedDemo();

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname!=='/api/health' && isProduction && !authorized(req)) { res.writeHead(401,{'www-authenticate':'Basic realm="WB AutoFund", charset="UTF-8"','content-type':'text/plain; charset=utf-8'}); return res.end('Требуется вход'); }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(process.cwd(),'public',file);
    if (!existsSync(path) || !path.startsWith(join(process.cwd(),'public'))) return send(res,404,{error:'Не найдено'});
    res.writeHead(200, {'content-type': mime[extname(path)] || 'application/octet-stream'}); res.end(readFileSync(path));
  } catch (e) { console.error(e); send(res,500,{error:e.message || 'Ошибка сервера'}); }
});

async function api(req,res,url) {
  if (req.method==='GET' && url.pathname==='/api/health') return send(res,200,{status:'ok',database:'sqlite',time:now()});
  const body = ['POST','PUT','PATCH'].includes(req.method) ? await jsonBody(req) : {};
  if (req.method==='GET' && url.pathname==='/api/dashboard') {
    const campaigns=db.prepare(`SELECT c.*,r.enabled,r.use_max_drr,r.max_drr,r.use_min_ctr,r.min_ctr,r.use_min_views,r.min_views,r.use_min_orders,r.min_orders,r.use_time_window,r.time_from,r.time_to,r.min_budget,r.deposit_amount,r.daily_limit,r.funding_type FROM campaigns c LEFT JOIN rules r ON r.campaign_id=c.id WHERE c.status<>'archived' ORDER BY c.id`).all();
    const operations=db.prepare(`SELECT * FROM operations ORDER BY id DESC LIMIT 100`).all();
    const s=db.prepare(`SELECT demo_mode,check_minutes,stats_days,token_enc IS NOT NULL AS token_saved FROM settings WHERE id=1`).get();
    return send(res,200,{campaigns,operations,settings:{...s,live_deposits:process.env.WB_LIVE_DEPOSITS==='true'}});
  }
  if (req.method==='POST' && url.pathname==='/api/settings') {
    const current=db.prepare('SELECT * FROM settings WHERE id=1').get();
    const token=typeof body.token==='string'&&body.token.trim()?encrypt(body.token.trim()):current.token_enc;
    db.prepare('UPDATE settings SET token_enc=?,demo_mode=?,check_minutes=?,stats_days=?,updated_at=? WHERE id=1').run(token,body.demo_mode?1:0,clamp(body.check_minutes,1,60),clamp(body.stats_days ?? current.stats_days ?? 7,1,31),now());
    return send(res,200,{ok:true});
  }
  const ruleMatch=url.pathname.match(/^\/api\/campaigns\/(\d+)\/rule$/);
  if (req.method==='PUT' && ruleMatch) {
    const id=Number(ruleMatch[1]);
    db.prepare(`INSERT INTO rules(campaign_id,enabled,use_max_drr,max_drr,use_min_ctr,min_ctr,use_min_views,min_views,use_min_orders,min_orders,use_time_window,time_from,time_to,min_budget,deposit_amount,daily_limit,funding_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET enabled=excluded.enabled,use_max_drr=excluded.use_max_drr,max_drr=excluded.max_drr,use_min_ctr=excluded.use_min_ctr,min_ctr=excluded.min_ctr,use_min_views=excluded.use_min_views,min_views=excluded.min_views,use_min_orders=excluded.use_min_orders,min_orders=excluded.min_orders,use_time_window=excluded.use_time_window,time_from=excluded.time_from,time_to=excluded.time_to,min_budget=excluded.min_budget,deposit_amount=excluded.deposit_amount,daily_limit=excluded.daily_limit,funding_type=excluded.funding_type,updated_at=excluded.updated_at`).run(id,body.enabled?1:0,body.use_max_drr!==false?1:0,positive(body.max_drr),body.use_min_ctr!==false?1:0,positive(body.min_ctr),body.use_min_views?1:0,Math.round(positive(body.min_views)),body.use_min_orders?1:0,Math.round(positive(body.min_orders)),body.use_time_window?1:0,validTime(body.time_from,'00:00'),validTime(body.time_to,'23:59'),positive(body.min_budget),Math.round(positive(body.deposit_amount)),clamp(body.daily_limit,1,100),[0,1,3].includes(Number(body.funding_type))?Number(body.funding_type):1,now());
    return send(res,200,{ok:true});
  }
  if (req.method==='POST' && url.pathname==='/api/sync') { await syncCampaigns(); return send(res,200,{ok:true}); }
  if (req.method==='POST' && url.pathname==='/api/run') { const result=await evaluateAll(); return send(res,200,result); }
  return send(res,404,{error:'Метод не найден'});
}

async function evaluateAll() {
  const rows=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE r.enabled=1`).all();
  let deposited=0, skipped=0;
  for (const c of rows) { const result=await evaluate(c); result==='deposited'?deposited++:skipped++; }
  return {checked:rows.length,deposited,skipped};
}

async function evaluate(c) {
  const before=Number(c.budget), metrics={ctr:Number(c.ctr),drr:Number(c.drr)};
  let reason='';
  if (c.status!=='active') reason='Кампания не активна';
  else if (c.use_time_window && !isMoscowTimeAllowed(c.time_from,c.time_to)) reason=`Вне времени пополнения (${c.time_from}–${c.time_to} МСК)`;
  else if (before>=c.min_budget) reason='Остаток не ниже порога';
  else if ((c.use_max_drr || c.use_min_ctr || c.use_min_views || c.use_min_orders) && !c.metrics_available) reason='Статистика кампании не получена — пополнение заблокировано';
  else if (c.use_max_drr && metrics.drr>c.max_drr) reason='ДРР выше максимума';
  else if (c.use_min_ctr && metrics.ctr<c.min_ctr) reason='CTR ниже минимума';
  else if (c.use_min_views && Number(c.views)<Number(c.min_views)) reason='Показы ниже минимума';
  else if (c.use_min_orders && Number(c.orders)<Number(c.min_orders)) reason='Заказы ниже минимума';
  // Wildberries rules use a Moscow calendar day, independent of the server timezone.
  const today=db.prepare(`SELECT count(*) n FROM operations WHERE campaign_id=? AND status='deposited' AND date(created_at,'+3 hours')=date('now','+3 hours')`).get(c.campaign_id).n;
  if (!reason && today>=c.daily_limit) reason='Достигнут дневной лимит';
  if (reason) { log(c,'skipped',reason,0,before,before); return 'skipped'; }
  const minuteBucket=new Date(); minuteBucket.setSeconds(0,0);
  const idem=createHash('sha256').update(`${c.campaign_id}:${minuteBucket.toISOString()}`).digest('hex');
  if (db.prepare('SELECT 1 FROM operations WHERE idempotency_key=?').get(idem)) return 'skipped';
  const lockUntil=new Date(Date.now()+120000).toISOString();
  const lock=db.prepare(`INSERT INTO locks(campaign_id,locked_until) VALUES(?,?) ON CONFLICT(campaign_id) DO UPDATE SET locked_until=excluded.locked_until WHERE locks.locked_until < ?`).run(c.campaign_id,lockUntil,now());
  if (!lock.changes) { log(c,'skipped','Проверка уже выполняется',0,before,before); return 'skipped'; }
  try {
    const settings=db.prepare('SELECT * FROM settings WHERE id=1').get(); let after;
    if (settings.demo_mode) after=before+c.deposit_amount;
    else {
      if (process.env.WB_LIVE_DEPOSITS!=='true') { log(c,'blocked','Боевые пополнения выключены в .env',0,before,before,idem); return 'skipped'; }
      const token=decrypt(settings.token_enc); const response=await wb(`/adv/v1/budget/deposit?id=${c.campaign_id}`,token,{sum:c.deposit_amount,type:c.funding_type,return:true}); after=Number(response.total);
    }
    db.prepare('UPDATE campaigns SET budget=?,updated_at=? WHERE id=?').run(after,now(),c.campaign_id);
    log(c,'deposited',settings.demo_mode?'Демо-пополнение':'Пополнено через WB API',c.deposit_amount,before,after,idem); return 'deposited';
  } catch(e) { log(c,'error',e.message,0,before,before,idem); return 'skipped'; }
  finally { db.prepare('DELETE FROM locks WHERE campaign_id=?').run(c.campaign_id); }
}

let activeSync=null;
async function syncCampaigns() {
  if(activeSync) return activeSync;
  activeSync=doSyncCampaigns();
  try { return await activeSync; } finally { activeSync=null; }
}
async function doSyncCampaigns() {
  const s=db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (s.demo_mode) { seedDemo(); return; }
  if (!s.token_enc) throw new Error('Сначала сохраните токен WB');
  const token=decrypt(s.token_enc);
  const response=await wb('/api/advert/v2/adverts?statuses=9,11&order=change&direction=desc',token);
  const root=Array.isArray(response)?response:(Array.isArray(response?.adverts)?response.adverts:[]);
  const campaigns=[];
  for (const item of root) {
    // Current v2 returns campaign objects in response.adverts. Keep support for the
    // older grouped response so existing accounts continue to sync.
    if (item && (item.id || item.advertId || item.advert_id)) campaigns.push(item);
    else for (const nested of item?.advert_list || item?.adverts || []) campaigns.push({...nested,status:nested.status??item.status});
  }
  db.prepare(`DELETE FROM campaigns WHERE source='demo'`).run();
  // Campaigns not returned for statuses 9/11 are archived. Keep their rules in
  // the database, but hide them from the site and browser extension.
  db.prepare(`UPDATE campaigns SET status='archived' WHERE source='wb'`).run();
  for (const a of campaigns) {
    const id=Number(a.advertId || a.advert_id || a.id); if (!id) continue;
    const name=a.name || a.settings?.name || `Кампания ${id}`;
    db.prepare(`INSERT INTO campaigns(id,name,status,budget,ctr,drr,source,updated_at) VALUES(?,?,?,0,0,0,'wb',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,source='wb',updated_at=excluded.updated_at`).run(id,name,Number(a.status)===9?'active':'paused',now());
  }
  // Statistics has the strictest WB limit, so request it before the per-campaign
  // budget calls consume the seller's shared promotion API allowance.
  await new Promise(resolve=>setTimeout(resolve,21000));
  await syncStatistics(token, campaigns.map(a=>Number(a.advertId || a.advert_id || a.id)).filter(Boolean), s.stats_days || 7);
  for (const a of campaigns) {
    const id=Number(a.advertId || a.advert_id || a.id); if (!id) continue;
    const budget=await wb(`/adv/v1/budget?id=${id}`,token);
    db.prepare(`UPDATE campaigns SET budget=?,updated_at=? WHERE id=?`).run(Number(budget.total||0),now(),id);
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}

async function syncStatistics(token, ids, days) {
  const end=new Date(),begin=new Date(end); begin.setUTCDate(begin.getUTCDate()-Math.max(0,Number(days)-1));
  const beginDate=ymdMoscow(begin),endDate=ymdMoscow(end);
  db.prepare(`UPDATE campaigns SET metrics_available=0 WHERE source='wb'`).run();
  for (let offset=0;offset<ids.length;offset+=50) {
    const batch=ids.slice(offset,offset+50);
    if (offset) await new Promise(resolve=>setTimeout(resolve,20500));
    const stats=await wb(`/adv/v3/fullstats?ids=${batch.join(',')}&beginDate=${beginDate}&endDate=${endDate}`,token);
    for (const item of Array.isArray(stats)?stats:[]) {
      const id=Number(item.advertId || item.advert_id || item.id); if (!id) continue;
      const spend=Number(item.sum||0),revenue=Number(item.sum_price||0),views=Math.round(Number(item.views||0)),orders=Math.round(Number(item.orders||0));
      const ctr=Number.isFinite(Number(item.ctr))?Number(item.ctr):(views?Number(item.clicks||0)/views*100:0);
      // Spend without attributed orders must never look like an excellent 0% DRR.
      const drr=revenue>0?spend/revenue*100:(spend>0?999999:0);
      db.prepare(`UPDATE campaigns SET ctr=?,drr=?,spend=?,revenue=?,views=?,orders=?,metrics_available=1,metrics_from=?,metrics_to=?,updated_at=? WHERE id=?`).run(ctr,drr,spend,revenue,views,orders,beginDate,endDate,now(),id);
    }
  }
}

async function wb(path,token,body) {
  const options={method:body?'POST':'GET',headers:{Authorization:token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined};
  for (let attempt=0;attempt<6;attempt++) {
    const r=await fetch(`${process.env.WB_API_BASE||'https://advert-api.wildberries.ru'}${path}`,options);
    if (r.ok) { const text=await r.text(); return text?JSON.parse(text):{}; }
    const errorText=await r.text();
    // Only retry read operations. Retrying a deposit could charge a campaign twice.
    if (r.status!==429 || body || attempt===5) throw new Error(`WB API: ${r.status} ${errorText}`);
    const retryAfter=Number(r.headers.get('x-ratelimit-retry') || r.headers.get('retry-after'));
    const baseDelay=path.startsWith('/adv/v3/fullstats')?21000:1100;
    await new Promise(resolve=>setTimeout(resolve,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:baseDelay*(attempt+1)));
  }
}
function log(c,status,reason,amount,before,after,idem=null){db.prepare(`INSERT OR IGNORE INTO operations(campaign_id,campaign_name,created_at,action,status,reason,amount,budget_before,budget_after,ctr,drr,idempotency_key) VALUES(?, ?, ?, 'evaluation', ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.campaign_id||c.id,c.name,now(),status,reason,amount,before,after,c.ctr,c.drr,idem);}
function seedDemo(){if(db.prepare('SELECT count(*) n FROM campaigns').get().n)return;const q=db.prepare(`INSERT INTO campaigns(id,name,status,budget,ctr,drr,spend,revenue,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);[[9134001,'Кроссовки — Поиск','active',320,7.4,8.1,8100,100000],[9134002,'Рюкзаки — Каталог','active',870,3.8,14.6,7300,50000],[9134003,'Футболки — Авто','active',190,6.2,10.9,5450,50000]].forEach(x=>q.run(...x,'demo',now()));}
function migrateColumn(table,column,definition){const columns=db.prepare(`PRAGMA table_info(${table})`).all();if(!columns.some(x=>x.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function validTime(value,fallback){return typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value)?value:fallback;}
function ymdMoscow(date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
function isMoscowTimeAllowed(from,to,date=new Date()){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);const current=Number(parts.find(x=>x.type==='hour').value)*60+Number(parts.find(x=>x.type==='minute').value);const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3));const start=minutes(from),end=minutes(to);return start<=end?current>=start&&current<=end:current>=start||current<=end;}
function key(){const raw=process.env.APP_ENCRYPTION_KEY;if(!raw||!/^[a-f0-9]{64}$/i.test(raw))return createHash('sha256').update(`local-dev:${process.cwd()}`).digest();return Buffer.from(raw,'hex');}
function encrypt(s){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([c.update(s,'utf8'),c.final()]);return [iv,c.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');}
function decrypt(s){if(!s)throw new Error('Токен WB не сохранён');const [i,t,d]=s.split('.').map(x=>Buffer.from(x,'base64url'));const c=createDecipheriv('aes-256-gcm',key(),i);c.setAuthTag(t);return Buffer.concat([c.update(d),c.final()]).toString();}
function loadEnv(){if(!existsSync('.env'))return;for(const line of readFileSync('.env','utf8').split(/\r?\n/)){const m=line.match(/^([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim();}}
function authorized(req){const value=req.headers.authorization||'';if(!value.startsWith('Basic '))return false;let decoded='';try{decoded=Buffer.from(value.slice(6),'base64').toString('utf8')}catch{return false}const separator=decoded.indexOf(':');if(separator<0)return false;const username=decoded.slice(0,separator),password=decoded.slice(separator+1);return safeEqual(username,process.env.ADMIN_USERNAME||'admin')&&safeEqual(password,process.env.ADMIN_PASSWORD||'');}
function safeEqual(a,b){return timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());}
function now(){return new Date().toISOString()} function positive(v){v=Number(v);if(!Number.isFinite(v)||v<0)throw new Error('Поля правила должны быть неотрицательными');return v} function clamp(v,a,b){return Math.max(a,Math.min(b,Math.round(Number(v)||a)))}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))} async function jsonBody(req){let s='';for await(const c of req){s+=c;if(s.length>1e6)throw new Error('Слишком большой запрос')}return s?JSON.parse(s):{}}

server.listen(PORT,HOST,()=>console.log(`WB AutoFund: http://${HOST}:${PORT}`));
let running=false,lastAutomaticRun=0;setInterval(async()=>{
  const settings=db.prepare('SELECT * FROM settings WHERE id=1').get(),minutes=settings.check_minutes;
  if(running||Date.now()-lastAutomaticRun<minutes*60000)return;
  running=true;lastAutomaticRun=Date.now();
  try {
    // A closed browser must not stop automation: refresh WB data on the server
    // before every decision. If sync fails, evaluation is skipped safely.
    if(!settings.demo_mode) await syncCampaigns();
    await evaluateAll();
  } catch(e) { console.error('Automatic cycle skipped:',e); }
  finally { running=false; }
},15000);
function shutdown(){server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
