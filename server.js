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
CREATE TABLE IF NOT EXISTS hourly_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, campaign_name TEXT, status TEXT, snapshot_at TEXT NOT NULL, impressions_total INTEGER, clicks_total INTEGER, quality TEXT NOT NULL DEFAULT 'ok', note TEXT, UNIQUE(campaign_id,snapshot_at));
CREATE TABLE IF NOT EXISTS campaign_daily_stats (campaign_id INTEGER NOT NULL, stat_date TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0, spend REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, ctr REAL NOT NULL DEFAULT 0, drr REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(campaign_id,stat_date));
CREATE TABLE IF NOT EXISTS sync_history (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, campaigns INTEGER NOT NULL DEFAULT 0, message TEXT);
CREATE TABLE IF NOT EXISTS campaign_bids (campaign_id INTEGER NOT NULL, campaign_name TEXT, nm_id TEXT NOT NULL, subject TEXT, placement TEXT NOT NULL, bid_rub REAL, payment_type TEXT, updated_at TEXT, PRIMARY KEY(campaign_id,nm_id,placement));
CREATE TABLE IF NOT EXISTS campaign_bid_history (snapshot_at TEXT NOT NULL, campaign_id INTEGER NOT NULL, campaign_name TEXT, nm_id TEXT NOT NULL, subject TEXT, placement TEXT NOT NULL, bid_rub REAL, payment_type TEXT, updated_at TEXT, PRIMARY KEY(snapshot_at,campaign_id,nm_id,placement));
CREATE TABLE IF NOT EXISTS campaign_bid_changes (changed_at TEXT NOT NULL, campaign_id INTEGER NOT NULL, nm_id TEXT, placement TEXT, old_value TEXT, new_value TEXT, PRIMARY KEY(changed_at,campaign_id,nm_id,placement));
INSERT OR IGNORE INTO settings(id,demo_mode,check_minutes,updated_at) VALUES(1,1,5,datetime('now'));`);
migrateColumn('rules','use_max_drr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_min_ctr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_time_window','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','time_from','TEXT NOT NULL DEFAULT \'00:00\'');
migrateColumn('rules','time_to','TEXT NOT NULL DEFAULT \'23:59\'');
migrateColumn('settings','stats_days','INTEGER NOT NULL DEFAULT 7');
migrateColumn('settings','auto_sync_enabled','INTEGER NOT NULL DEFAULT 1');
migrateColumn('campaigns','views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('campaigns','metrics_available','INTEGER NOT NULL DEFAULT 0');
migrateColumn('campaigns','metrics_from','TEXT');
migrateColumn('campaigns','metrics_to','TEXT');
migrateColumn('campaigns','orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','use_min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','use_min_orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','min_orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','metrics_days','INTEGER NOT NULL DEFAULT 7');
migrateColumn('rules','auto_resume','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','resume_daily_limit','INTEGER NOT NULL DEFAULT 1');
seedDemo();
// A large Diary archive can contain hundreds of thousands of rows. Importing it
// synchronously before listen() makes Docker health checks fail with a 502.
// Enable the one-off import explicitly after the web service is known to start.
if(process.env.IMPORT_DIARY_ON_START==='true') importDiaryData();

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
    const campaigns=db.prepare(`SELECT c.*,r.enabled,r.auto_resume,r.resume_daily_limit,r.use_max_drr,r.max_drr,r.use_min_ctr,r.min_ctr,r.use_min_views,r.min_views,r.use_min_orders,r.min_orders,r.metrics_days,r.use_time_window,r.time_from,r.time_to,r.min_budget,r.deposit_amount,r.daily_limit,r.funding_type FROM campaigns c LEFT JOIN rules r ON r.campaign_id=c.id WHERE c.status<>'archived' ORDER BY c.id`).all();
    let periodFrom=url.searchParams.get('from'),periodTo=url.searchParams.get('to');
    const requestedDays=Number(url.searchParams.get('days'));
    if(Number.isFinite(requestedDays)&&requestedDays>=1&&requestedDays<=31){const range=moscowDateRange(requestedDays);periodFrom=range.from;periodTo=range.to;}
    if(/^\d{4}-\d{2}-\d{2}$/.test(periodFrom||'')&&/^\d{4}-\d{2}-\d{2}$/.test(periodTo||'')&&periodFrom<=periodTo){
      const periodRows=db.prepare(`SELECT campaign_id,SUM(views) views,SUM(clicks) clicks,SUM(orders) orders,SUM(spend) spend,SUM(revenue) revenue,COUNT(*) days FROM campaign_daily_stats WHERE stat_date BETWEEN ? AND ? GROUP BY campaign_id`).all(periodFrom,periodTo),byCampaign=new Map(periodRows.map(row=>[Number(row.campaign_id),row]));
      for(const campaign of campaigns){const metrics=byCampaign.get(Number(campaign.id));if(!metrics){campaign.metrics_available=0;continue}campaign.views=Number(metrics.views||0);campaign.orders=Number(metrics.orders||0);campaign.spend=Number(metrics.spend||0);campaign.revenue=Number(metrics.revenue||0);campaign.ctr=metrics.views?Number(metrics.clicks||0)*100/Number(metrics.views):0;campaign.drr=metrics.revenue?campaign.spend*100/campaign.revenue:(campaign.spend>0?999999:0);campaign.metrics_available=1;campaign.metrics_from=periodFrom;campaign.metrics_to=periodTo;}
    }
    const operations=db.prepare(`SELECT * FROM operations ORDER BY id DESC LIMIT 100`).all();
    const s=db.prepare(`SELECT demo_mode,check_minutes,stats_days,auto_sync_enabled,token_enc IS NOT NULL AS token_saved FROM settings WHERE id=1`).get();
    return send(res,200,{campaigns,operations,settings:{...s,display_from:periodFrom||null,display_to:periodTo||null,live_deposits:process.env.WB_LIVE_DEPOSITS==='true',live_resume:process.env.WB_LIVE_RESUME==='true'}});
  }
  if (req.method==='GET' && url.pathname==='/api/hourly') return send(res,200,hourlyDataV2(url.searchParams.get('campaign_id'),url.searchParams.get('week')));
  if (req.method==='GET' && url.pathname==='/api/analytics') return send(res,200,analyticsDataV2(url.searchParams.get('from'),url.searchParams.get('to'),url.searchParams.get('campaign_id')));
  if (req.method==='GET' && url.pathname==='/api/shared/export') return send(res,200,sharedExport(url.searchParams.get('from'),url.searchParams.get('to')));
  if (req.method==='POST' && url.pathname==='/api/settings') {
    const current=db.prepare('SELECT * FROM settings WHERE id=1').get();
    const token=typeof body.token==='string'&&body.token.trim()?encrypt(body.token.trim()):current.token_enc;
    db.prepare('UPDATE settings SET token_enc=?,demo_mode=?,check_minutes=?,stats_days=?,auto_sync_enabled=?,updated_at=? WHERE id=1').run(token,body.demo_mode?1:0,clamp(body.check_minutes,1,1440),clamp(body.stats_days ?? current.stats_days ?? 7,1,31),body.auto_sync_enabled===false?0:1,now());
    return send(res,200,{ok:true});
  }
  const ruleMatch=url.pathname.match(/^\/api\/campaigns\/(\d+)\/rule$/);
  if (req.method==='PUT' && ruleMatch) {
    const id=Number(ruleMatch[1]);
    const currentRule=db.prepare('SELECT metrics_days,auto_resume,resume_daily_limit FROM rules WHERE campaign_id=?').get(id);
    db.prepare(`INSERT INTO rules(campaign_id,enabled,auto_resume,resume_daily_limit,use_max_drr,max_drr,use_min_ctr,min_ctr,use_min_views,min_views,use_min_orders,min_orders,metrics_days,use_time_window,time_from,time_to,min_budget,deposit_amount,daily_limit,funding_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET enabled=excluded.enabled,auto_resume=excluded.auto_resume,resume_daily_limit=excluded.resume_daily_limit,use_max_drr=excluded.use_max_drr,max_drr=excluded.max_drr,use_min_ctr=excluded.use_min_ctr,min_ctr=excluded.min_ctr,use_min_views=excluded.use_min_views,min_views=excluded.min_views,use_min_orders=excluded.use_min_orders,min_orders=excluded.min_orders,metrics_days=excluded.metrics_days,use_time_window=excluded.use_time_window,time_from=excluded.time_from,time_to=excluded.time_to,min_budget=excluded.min_budget,deposit_amount=excluded.deposit_amount,daily_limit=excluded.daily_limit,funding_type=excluded.funding_type,updated_at=excluded.updated_at`).run(id,body.enabled?1:0,body.auto_resume==null?Number(currentRule?.auto_resume||0):(body.auto_resume?1:0),clamp(body.resume_daily_limit??currentRule?.resume_daily_limit??1,1,24),body.use_max_drr!==false?1:0,positive(body.max_drr),body.use_min_ctr!==false?1:0,positive(body.min_ctr),body.use_min_views?1:0,Math.round(positive(body.min_views)),body.use_min_orders?1:0,Math.round(positive(body.min_orders)),clamp(body.metrics_days??currentRule?.metrics_days??7,1,31),body.use_time_window?1:0,validTime(body.time_from,'00:00'),validTime(body.time_to,'23:59'),positive(body.min_budget),Math.round(positive(body.deposit_amount)),clamp(body.daily_limit,1,100),[0,1,3].includes(Number(body.funding_type))?Number(body.funding_type):1,now());
    return send(res,200,{ok:true});
  }
  if (req.method==='POST' && url.pathname==='/api/sync') {
    const alreadyRunning=Boolean(activeSync);
    if(!alreadyRunning) syncCampaigns().catch(error=>console.error('Manual WB sync failed:',error));
    return send(res,202,{ok:true,started:!alreadyRunning,running:true});
  }
  if (req.method==='POST' && url.pathname==='/api/run') { const result=await evaluateAll(); return send(res,200,result); }
  return send(res,404,{error:'Метод не найден'});
}

async function evaluateAll() {
  const rows=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE r.enabled=1 OR r.auto_resume=1`).all();
  let deposited=0,resumed=0,skipped=0;
  for (const c of rows) { const result=await evaluate(c); result==='deposited'?deposited++:result==='resumed'?resumed++:skipped++; }
  return {checked:rows.length,deposited,resumed,skipped};
}

async function evaluate(c) {
  const before=Number(c.budget),periodMetrics=campaignMetricsForDays(c.campaign_id,c.metrics_days||7);
  c.metrics_available=periodMetrics.available?1:0;c.ctr=periodMetrics.ctr;c.drr=periodMetrics.drr;c.views=periodMetrics.views;c.orders=periodMetrics.orders;
  const metrics={ctr:Number(c.ctr),drr:Number(c.drr)};
  let reason='';
  if (c.use_time_window && !isMoscowTimeAllowed(c.time_from,c.time_to)) reason=`Вне разрешённого времени (${c.time_from}–${c.time_to} МСК)`;
  else if ((c.use_max_drr || c.use_min_ctr || c.use_min_views || c.use_min_orders) && !c.metrics_available) reason='Статистика кампании не получена — действие заблокировано';
  else if (c.use_max_drr && metrics.drr>c.max_drr) reason='ДРР выше максимума';
  else if (c.use_min_ctr && metrics.ctr<c.min_ctr) reason='CTR ниже минимума';
  else if (c.use_min_views && Number(c.views)<Number(c.min_views)) reason='Показы ниже минимума';
  else if (c.use_min_orders && Number(c.orders)<Number(c.min_orders)) reason='Заказы ниже минимума';
  if (!reason && c.status!=='active' && c.auto_resume) {
    const resumedToday=db.prepare(`SELECT count(*) n FROM operations WHERE campaign_id=? AND action='resume' AND status='resumed' AND date(created_at,'+3 hours')=date('now','+3 hours')`).get(c.campaign_id).n;
    if (resumedToday>=Number(c.resume_daily_limit||1)) reason='Достигнут дневной лимит автовозобновлений';
    else if (before<=0) reason='Недостаточно бюджета для возобновления';
    else {
      const resumeKey=createHash('sha256').update(`resume:${c.campaign_id}:${ymdMoscow(new Date())}`).digest('hex');
      try {
        const settings=db.prepare('SELECT * FROM settings WHERE id=1').get();
        if (!settings.demo_mode) {
          if (process.env.WB_LIVE_RESUME!=='true') throw new Error('Боевое возобновление выключено в .env');
          await wbCommand(`/adv/v0/start?id=${c.campaign_id}`,decrypt(settings.token_enc));
        }
        db.prepare(`UPDATE campaigns SET status='active',updated_at=? WHERE id=?`).run(now(),c.campaign_id);
        c.status='active';
        logAction(c,'resume','resumed',settings.demo_mode?'Демо-возобновление':'Кампания возобновлена через WB API',0,before,before,resumeKey);
        if (!c.enabled) return 'resumed';
      } catch(e) { logAction(c,'resume','error',e.message,0,before,before,resumeKey); return 'skipped'; }
    }
  }
  if (!reason && c.status!=='active') reason='Кампания не активна';
  else if (!reason && !c.enabled) return 'skipped';
  else if (!reason && before>=c.min_budget) reason='Остаток не ниже порога';
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
  await syncCampaignBids(token,campaigns);
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

async function syncCampaignBids(token,campaigns){
  const ids=campaigns.map(a=>Number(a.advertId||a.advert_id||a.id)).filter(Boolean),stamp=moscowTimestamp();let changed=0,seen=0;
  for(let offset=0;offset<ids.length;offset+=50){if(offset)await new Promise(resolve=>setTimeout(resolve,1100));const response=await wb(`/api/advert/v2/adverts?ids=${ids.slice(offset,offset+50).join(',')}`,token),items=Array.isArray(response)?response:(response?.adverts||response?.data||[]);
    for(const item of items){const id=Number(item.advertId||item.advert_id||item.id);if(!id)continue;const settings=item.settings&&typeof item.settings==='object'?item.settings:{},name=item.name||item.campaignName||item.advertName||settings.name||`Кампания ${id}`,payment=String(item.paymentType||item.payment_type||settings.payment_type||settings.paymentType||'').toUpperCase(),nms=Array.isArray(item.nm_settings)?item.nm_settings:(Array.isArray(settings.nm_settings)?settings.nm_settings:[]);
      for(const nm of nms){const nmId=String(nm.nm_id||nm.nmId||nm.nm||'');if(!nmId)continue;const bids=nm.bids_kopecks&&typeof nm.bids_kopecks==='object'?nm.bids_kopecks:{},subject=typeof nm.subject==='object'?(nm.subject.name||nm.subject.id||''):(nm.subject||nm.subject_name||nm.name||'');for(const placement of ['search','recommendations']){const kopecks=Number(bids[placement]);if(!Number.isFinite(kopecks))continue;const rub=kopecks/100,old=db.prepare(`SELECT bid_rub FROM campaign_bids WHERE campaign_id=? AND nm_id=? AND placement=?`).get(id,nmId,placement);if(old&&Number(old.bid_rub)!==rub){db.prepare(`INSERT OR IGNORE INTO campaign_bid_changes(changed_at,campaign_id,nm_id,placement,old_value,new_value) VALUES(?,?,?,?,?,?)`).run(stamp,id,nmId,placement,String(old.bid_rub),String(rub));changed++}db.prepare(`INSERT INTO campaign_bids(campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,nm_id,placement) DO UPDATE SET campaign_name=excluded.campaign_name,subject=excluded.subject,bid_rub=excluded.bid_rub,payment_type=excluded.payment_type,updated_at=excluded.updated_at`).run(id,name,nmId,String(subject),placement,rub,payment,stamp);db.prepare(`INSERT OR IGNORE INTO campaign_bid_history(snapshot_at,campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(stamp,id,name,nmId,String(subject),placement,rub,payment,stamp);seen++}}}
  }
  console.log(`WB bids synced: ${seen}; changed: ${changed}`);return{seen,changed};
}

function emptyStatMetrics(){return{views:0,clicks:0,orders:0,spend:0,revenue:0}}
function sumStatMetrics(total,value){
  total.views+=value.views;total.clicks+=value.clicks;total.orders+=value.orders;
  total.spend+=value.spend;total.revenue+=value.revenue;return total;
}
function wbStatMetrics(source){
  const direct={views:Math.round(Number(source?.views||0)),clicks:Math.round(Number(source?.clicks||0)),orders:Math.round(Number(source?.orders||0)),spend:Number(source?.sum||0),revenue:Number(source?.sum_price||source?.sumPrice||0)};
  const apps=Array.isArray(source?.apps)?source.apps:[];
  if(!apps.length)return direct;
  const nested=apps.map(app=>({views:Math.round(Number(app?.views||0)),clicks:Math.round(Number(app?.clicks||0)),orders:Math.round(Number(app?.orders||0)),spend:Number(app?.sum||0),revenue:Number(app?.sum_price||app?.sumPrice||0)})).reduce(sumStatMetrics,emptyStatMetrics());
  // Prefer an explicit aggregate, but recover individual zero fields from the
  // platform rows when WB omitted them at the parent level.
  return Object.fromEntries(Object.keys(direct).map(key=>[key,direct[key]||nested[key]||0]));
}

async function syncStatistics(token, ids, days) {
  const end=new Date(),begin=new Date(end),decisionBegin=new Date(end),decisionDays=Math.max(1,Math.min(31,Number(days)||7));
  // One WB request costs the same rate-limit slot for one or 31 days. Keep the
  // complete allowed history so the extension can mirror the period selected
  // in the WB interface without making another request.
  begin.setUTCDate(begin.getUTCDate()-30);decisionBegin.setUTCDate(decisionBegin.getUTCDate()-(decisionDays-1));
  const beginDate=ymdMoscow(begin),decisionBeginDate=ymdMoscow(decisionBegin),endDate=ymdMoscow(end);
  db.prepare(`UPDATE campaigns SET metrics_available=0 WHERE source='wb'`).run();
  for (let offset=0;offset<ids.length;offset+=50) {
    const batch=ids.slice(offset,offset+50);
    if (offset) await new Promise(resolve=>setTimeout(resolve,20500));
    const stats=await wb(`/adv/v3/fullstats?ids=${batch.join(',')}&beginDate=${beginDate}&endDate=${endDate}`,token);
    const statItems=Array.isArray(stats)?stats:(Array.isArray(stats?.data)?stats.data:(Array.isArray(stats?.adverts)?stats.adverts:[]));
    for (const item of statItems) {
      const id=Number(item.advertId || item.advert_id || item.id); if (!id) continue;
      const days=Array.isArray(item.days)?item.days:[];
      // WB can return stale/zero totals at campaign level while the actual
      // values are present in days/apps. Build campaign totals from the daily
      // rows, which also makes the selected statistics period unambiguous.
      const decisionPeriod=days.filter(day=>String(day.date||'').slice(0,10)>=decisionBeginDate);
      const period=decisionPeriod.length?decisionPeriod.map(wbStatMetrics).reduce(sumStatMetrics,emptyStatMetrics()):wbStatMetrics(item);
      const spend=period.spend,revenue=period.revenue,views=period.views,orders=period.orders;
      const ctr=views?period.clicks/views*100:0;
      // Spend without attributed orders must never look like an excellent 0% DRR.
      const drr=revenue>0?spend/revenue*100:(spend>0?999999:0);
      db.prepare(`UPDATE campaigns SET ctr=?,drr=?,spend=?,revenue=?,views=?,orders=?,metrics_available=1,metrics_from=?,metrics_to=?,updated_at=? WHERE id=?`).run(ctr,drr,spend,revenue,views,orders,decisionBeginDate,endDate,now(),id);
      for(const day of days){
        const statDate=String(day.date||'').slice(0,10);if(!statDate)continue;
        const dayMetrics=wbStatMetrics(day),daySpend=dayMetrics.spend,dayRevenue=dayMetrics.revenue,dayViews=dayMetrics.views,dayClicks=dayMetrics.clicks,dayOrders=dayMetrics.orders;
        const dayCtr=Number.isFinite(Number(day.ctr))?Number(day.ctr):(dayViews?dayClicks/dayViews*100:0),dayDrr=dayRevenue?daySpend/dayRevenue*100:(daySpend?999999:0);
        db.prepare(`INSERT INTO campaign_daily_stats(campaign_id,stat_date,views,clicks,orders,spend,revenue,ctr,drr,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,stat_date) DO UPDATE SET views=excluded.views,clicks=excluded.clicks,orders=excluded.orders,spend=excluded.spend,revenue=excluded.revenue,ctr=excluded.ctr,drr=excluded.drr,updated_at=excluded.updated_at`).run(id,statDate,dayViews,dayClicks,dayOrders,daySpend,dayRevenue,dayCtr,dayDrr,now());
      }
      const today=days.find(day=>String(day.date||'').slice(0,10)===endDate);
      if(today){const campaign=db.prepare('SELECT name,status FROM campaigns WHERE id=?').get(id)||{},todayMetrics=wbStatMetrics(today);db.prepare(`INSERT OR IGNORE INTO hourly_snapshots(campaign_id,campaign_name,status,snapshot_at,impressions_total,clicks_total,quality,note) VALUES(?,?,?,?,?,?,'ok','WB API')`).run(id,campaign.name||'',campaign.status||'',moscowTimestamp(),todayMetrics.views,todayMetrics.clicks);}
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
async function wbCommand(path,token){
  const r=await fetch(`${process.env.WB_API_BASE||'https://advert-api.wildberries.ru'}${path}`,{method:'GET',headers:{Authorization:token}});
  if(!r.ok)throw new Error(`WB API: ${r.status} ${await r.text()}`);
  const text=await r.text();return text?JSON.parse(text):{};
}
function logAction(c,action,status,reason,amount,before,after,idem=null){db.prepare(`INSERT OR IGNORE INTO operations(campaign_id,campaign_name,created_at,action,status,reason,amount,budget_before,budget_after,ctr,drr,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.campaign_id||c.id,c.name,now(),action,status,reason,amount,before,after,c.ctr,c.drr,idem);}
function log(c,status,reason,amount,before,after,idem=null){logAction(c,'evaluation',status,reason,amount,before,after,idem);}
function seedDemo(){if(db.prepare('SELECT count(*) n FROM campaigns').get().n)return;const q=db.prepare(`INSERT INTO campaigns(id,name,status,budget,ctr,drr,spend,revenue,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);[[9134001,'Кроссовки — Поиск','active',320,7.4,8.1,8100,100000],[9134002,'Рюкзаки — Каталог','active',870,3.8,14.6,7300,50000],[9134003,'Футболки — Авто','active',190,6.2,10.9,5450,50000]].forEach(x=>q.run(...x,'demo',now()));}
function importDiaryData(){
  const dir=process.env.DIARY_DATA_DIR||'/diary-data';
  const hourly=join(dir,'campaign_hourly_snapshots.csv'),stats=join(dir,'campaign_stats.csv'),bids=join(dir,'campaign_bids_current.csv'),history=join(dir,'campaign_bids_history.csv'),changes=join(dir,'changes_log.csv');
  if(existsSync(hourly))for(const r of parseCsv(readFileSync(hourly,'utf8'))){const id=Number(r.campaign_id),at=normalizeMoscowDate(r.snapshot_at);if(!id||!at)continue;db.prepare(`INSERT OR IGNORE INTO hourly_snapshots(campaign_id,campaign_name,status,snapshot_at,impressions_total,clicks_total,quality,note) VALUES(?,?,?,?,?,?,?,?)`).run(id,r.campaign_name||'',r.status||'',at,numOrNull(r.impressions_total),numOrNull(r.clicks_total),r.quality||'missing',r.quality_note||'Импортировано из Дневника');}
  if(existsSync(stats))for(const r of parseCsv(readFileSync(stats,'utf8'))){if(r.row_type&&r.row_type!=='campaign')continue;const id=Number(r.campaign_id),date=String(r.date_to||r.date_from||'').slice(0,10);if(!id||!date)continue;const views=Number(r.impressions||0),clicks=Number(r.clicks||0),orders=Number(r.orders||0),spend=Number(r.spend||0),revenue=Number(r.revenue||0),ctr=Number(r.ctr||0),drr=Number(r.cost_share||0);db.prepare(`INSERT OR IGNORE INTO campaign_daily_stats(campaign_id,stat_date,views,clicks,orders,spend,revenue,ctr,drr,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,date,views,clicks,orders,spend,revenue,ctr,drr,now());}
  const importBid=(r,isHistory=false)=>{const id=Number(r.campaign_id),nm=String(r.nm_id||''),placement=String(r.placement||'');if(!id||!nm||!placement)return;const stamp=normalizeMoscowDate(r.snapshot_at)||String(r.snapshot_at||'').slice(0,19)||normalizeMoscowDate(r.updated_at)||moscowTimestamp();if(isHistory)db.prepare(`INSERT OR IGNORE INTO campaign_bid_history(snapshot_at,campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(stamp,id,r.campaign_name||'',nm,r.subject||'',placement,numOrNull(r.bid_rub),r.payment_type||'',r.updated_at||'');else db.prepare(`INSERT INTO campaign_bids(campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,nm_id,placement) DO UPDATE SET campaign_name=excluded.campaign_name,subject=excluded.subject,bid_rub=excluded.bid_rub,payment_type=excluded.payment_type,updated_at=excluded.updated_at`).run(id,r.campaign_name||'',nm,r.subject||'',placement,numOrNull(r.bid_rub),r.payment_type||'',r.updated_at||'');};
  if(existsSync(bids))for(const r of parseCsv(readFileSync(bids,'utf8')))importBid(r);
  if(existsSync(history))for(const r of parseCsv(readFileSync(history,'utf8')))importBid(r,true);
  if(existsSync(changes))for(const r of parseCsv(readFileSync(changes,'utf8'))){if(String(r.change_area)!=='Реклама'||!String(r.change_type||'').toLowerCase().includes('ставк'))continue;const id=Number(String(r.sku||'').replace('ADV-','')),nm=(String(r.object_name||'').match(/\d{5,}/)||[])[0]||'',type=String(r.change_type||'').toLowerCase(),placement=type.includes('поиск')?'search':type.includes('рекоменд')?'recommendations':'';if(id)db.prepare(`INSERT OR IGNORE INTO campaign_bid_changes(changed_at,campaign_id,nm_id,placement,old_value,new_value) VALUES(?,?,?,?,?,?)`).run(normalizeMoscowDate(r.datetime)||String(r.datetime||'').slice(0,19),id,nm,placement,r.old_value||'',r.new_value||'');}
}
function parseCsv(text){const rows=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(field);field=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';if(row.some(Boolean))rows.push(row);row=[]}else field+=c}if(field||row.length){row.push(field);rows.push(row)}if(!rows.length)return[];const headers=rows.shift().map((x,i)=>i===0?x.replace(/^\uFEFF/,''):x);return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??''])))}
function hourlyData(campaignId,week){const campaigns=db.prepare(`SELECT id,name,status FROM campaigns WHERE status<>'archived' ORDER BY name`).all();const id=Number(campaignId)||Number(campaigns[0]?.id||0);const start=/^\d{4}-\d{2}-\d{2}$/.test(week||'')?week:weekMonday();const end=new Date(`${start}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+7);const rows=db.prepare(`SELECT * FROM hourly_snapshots WHERE campaign_id=? AND snapshot_at>=? AND snapshot_at<? ORDER BY snapshot_at`).all(id,`${start} 00:00:00`,`${end.toISOString().slice(0,10)} 00:00:00`);const cells=[];let previous=null,previousDay='';for(const r of rows){const day=r.snapshot_at.slice(0,10),hour=Number(r.snapshot_at.slice(11,13));let views=null,clicks=null,uncertain=r.quality!=='ok',note=r.note||'';if(previous&&previousDay===day&&r.impressions_total!=null&&previous.impressions_total!=null){views=Math.max(0,r.impressions_total-previous.impressions_total);clicks=Math.max(0,r.clicks_total-previous.clicks_total)}else if(r.impressions_total!=null){views=r.impressions_total;clicks=r.clicks_total;uncertain=true;note=note||'Первый снимок дня'}cells.push({date:day,hour,views,clicks,uncertain,note});previous=r;previousDay=day}return{campaigns,selected_id:id,week:start,cells};}
function analyticsData(from,to){const end=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?to:ymdMoscow(new Date()),start=from&&/^\d{4}-\d{2}-\d{2}$/.test(from)?from:(()=>{const d=new Date();d.setUTCDate(d.getUTCDate()-6);return ymdMoscow(d)})();const rows=db.prepare(`SELECT d.campaign_id,COALESCE(c.name,'Кампания '||d.campaign_id) name,SUM(d.views) views,SUM(d.clicks) clicks,SUM(d.orders) orders,SUM(d.spend) spend,SUM(d.revenue) revenue,CASE WHEN SUM(d.views)>0 THEN SUM(d.clicks)*100.0/SUM(d.views) ELSE 0 END ctr,CASE WHEN SUM(d.revenue)>0 THEN SUM(d.spend)*100.0/SUM(d.revenue) ELSE 0 END drr FROM campaign_daily_stats d LEFT JOIN campaigns c ON c.id=d.campaign_id WHERE d.stat_date BETWEEN ? AND ? GROUP BY d.campaign_id,c.name ORDER BY spend DESC`).all(start,end);return{from:start,to:end,rows};}
function hourlyDataV2(campaignId,week){
  const campaigns=db.prepare(`SELECT c.id,c.name,c.status FROM campaigns c WHERE c.status<>'archived' AND EXISTS(SELECT 1 FROM hourly_snapshots h WHERE h.campaign_id=c.id) ORDER BY c.name`).all();
  const id=Number(campaignId)||Number(campaigns[0]?.id||0);
  const available=db.prepare(`SELECT DISTINCT substr(h.snapshot_at,1,10) day FROM hourly_snapshots h JOIN campaigns c ON c.id=h.campaign_id WHERE c.status<>'archived' ORDER BY day DESC`).all().map(x=>mondayOf(x.day));
  const weeks=[...new Set([weekMonday(),...available])].sort().reverse().map(value=>({value,label:weekLabel(value)}));
  const start=/^\d{4}-\d{2}-\d{2}$/.test(week||'')?mondayOf(week):weeks[0]?.value||weekMonday(),end=new Date(`${start}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
  const rows=db.prepare(`SELECT * FROM hourly_snapshots WHERE campaign_id=? AND snapshot_at>=? AND snapshot_at<? ORDER BY snapshot_at`).all(id,`${start} 00:00:00`,`${end.toISOString().slice(0,10)} 00:00:00`),cells=[];
  // Several syncs can happen within one hour. Keep the latest cumulative
  // snapshot for each hour, so the resulting delta represents the whole hour.
  const latestByHour=new Map();
  for(const row of rows) latestByHour.set(row.snapshot_at.slice(0,13),row);
  rows.splice(0,rows.length,...latestByHour.values());
  let previous=null,previousDay='';
  for(const r of rows){const day=r.snapshot_at.slice(0,10),hour=Number(r.snapshot_at.slice(11,13));let views=null,clicks=null,uncertain=r.quality!=='ok',note=r.note||'';if(previous&&previousDay===day&&r.impressions_total!=null&&previous.impressions_total!=null){views=Math.max(0,r.impressions_total-previous.impressions_total);clicks=Math.max(0,r.clicks_total-previous.clicks_total)}else if(r.impressions_total!=null){views=r.impressions_total;clicks=r.clicks_total;uncertain=true;note=note||'Первый снимок дня'}cells.push({date:day,hour,views,clicks,uncertain,note});previous=r;previousDay=day}
  return{campaigns,weeks,selected_id:id,week:start,cells};
}
function analyticsDataV2(from,to,campaignId){
  const end=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?to:ymdMoscow(new Date()),start=from&&/^\d{4}-\d{2}-\d{2}$/.test(from)?from:(()=>{const d=new Date();d.setUTCDate(d.getUTCDate()-6);return ymdMoscow(d)})();
  const stats=db.prepare(`SELECT d.campaign_id,SUM(d.views) views,SUM(d.clicks) clicks,SUM(d.orders) orders,SUM(d.spend) spend,SUM(d.revenue) revenue,CASE WHEN SUM(d.views)>0 THEN SUM(d.clicks)*100.0/SUM(d.views) ELSE 0 END ctr,CASE WHEN SUM(d.revenue)>0 THEN SUM(d.spend)*100.0/SUM(d.revenue) ELSE 0 END drr FROM campaign_daily_stats d JOIN campaigns c ON c.id=d.campaign_id WHERE d.stat_date BETWEEN ? AND ? AND c.status<>'archived' GROUP BY d.campaign_id`).all(start,end);
  const rows=stats.map(s=>{const c=db.prepare(`SELECT name,status FROM campaigns WHERE id=?`).get(s.campaign_id)||{},b=db.prepare(`SELECT COUNT(DISTINCT nm_id) products,MIN(bid_rub) bid_min,MAX(bid_rub) bid_max FROM campaign_bids WHERE campaign_id=?`).get(s.campaign_id),ch=db.prepare(`SELECT COUNT(DISTINCT nm_id) changed_products,MAX(changed_at) last_bid_change FROM campaign_bid_changes WHERE campaign_id=? AND changed_at BETWEEN ? AND ?`).get(s.campaign_id,`${start} 00:00:00`,`${end} 23:59:59`);return{...s,name:c.name||`Кампания ${s.campaign_id}`,status:c.status||'',type:'CPC',products:b.products||0,bid_min:b.bid_min,bid_max:b.bid_max,changed_products:ch.changed_products||0,last_bid_change:ch.last_bid_change}}).sort((a,b)=>b.spend-a.spend);
  const selected=Number(campaignId)||Number(rows[0]?.campaign_id||0);
  const products=db.prepare(`SELECT b.*,ch.old_value,ch.new_value,ch.changed_at,(SELECT COUNT(*) FROM campaign_bid_changes x WHERE x.campaign_id=b.campaign_id AND x.nm_id=b.nm_id AND x.placement=b.placement AND x.changed_at BETWEEN ? AND ?) changes FROM campaign_bids b LEFT JOIN campaign_bid_changes ch ON ch.rowid=(SELECT x.rowid FROM campaign_bid_changes x WHERE x.campaign_id=b.campaign_id AND x.nm_id=b.nm_id AND x.placement=b.placement AND x.changed_at BETWEEN ? AND ? ORDER BY x.changed_at DESC LIMIT 1) WHERE b.campaign_id=? ORDER BY b.nm_id,b.placement`).all(`${start} 00:00:00`,`${end} 23:59:59`,`${start} 00:00:00`,`${end} 23:59:59`,selected);
  return{from:start,to:end,selected_id:selected,rows,products};
}
function sharedExport(from,to){const end=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?to:ymdMoscow(new Date()),start=from&&/^\d{4}-\d{2}-\d{2}$/.test(from)?from:(()=>{const d=new Date();d.setUTCDate(d.getUTCDate()-6);return ymdMoscow(d)})();return{generated_at:now(),from:start,to:end,campaigns:db.prepare(`SELECT * FROM campaigns WHERE status<>'archived' ORDER BY id`).all(),daily_stats:db.prepare(`SELECT * FROM campaign_daily_stats WHERE stat_date BETWEEN ? AND ? ORDER BY stat_date,campaign_id`).all(start,end),bids:db.prepare(`SELECT * FROM campaign_bids ORDER BY campaign_id,nm_id,placement`).all(),bid_changes:db.prepare(`SELECT * FROM campaign_bid_changes WHERE changed_at BETWEEN ? AND ? ORDER BY changed_at`).all(`${start} 00:00:00`,`${end} 23:59:59`),hourly:db.prepare(`SELECT * FROM hourly_snapshots WHERE snapshot_at BETWEEN ? AND ? ORDER BY snapshot_at`).all(`${start} 00:00:00`,`${end} 23:59:59`)}}
function mondayOf(value){const d=new Date(`${String(value).slice(0,10)}T00:00:00Z`);if(Number.isNaN(d.getTime()))return weekMonday();d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10)}
function weekLabel(value){const a=new Date(`${value}T00:00:00Z`),b=new Date(a);b.setUTCDate(b.getUTCDate()+6);const f=d=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'}).format(d);return `${f(a)} — ${f(b)}`}
function moscowDateRange(days){const to=ymdMoscow(new Date()),fromDate=new Date(`${to}T00:00:00Z`);fromDate.setUTCDate(fromDate.getUTCDate()-(Math.max(1,Math.min(31,Number(days)||7))-1));return{from:fromDate.toISOString().slice(0,10),to}}
function campaignMetricsForDays(campaignId,days){const range=moscowDateRange(days),row=db.prepare(`SELECT SUM(views) views,SUM(clicks) clicks,SUM(orders) orders,SUM(spend) spend,SUM(revenue) revenue,COUNT(*) records FROM campaign_daily_stats WHERE campaign_id=? AND stat_date BETWEEN ? AND ?`).get(campaignId,range.from,range.to),views=Number(row?.views||0),clicks=Number(row?.clicks||0),orders=Number(row?.orders||0),spend=Number(row?.spend||0),revenue=Number(row?.revenue||0);return{available:Number(row?.records||0)>0,from:range.from,to:range.to,views,clicks,orders,spend,revenue,ctr:views?clicks*100/views:0,drr:revenue?spend*100/revenue:(spend>0?999999:0)}}
function migrateColumn(table,column,definition){const columns=db.prepare(`PRAGMA table_info(${table})`).all();if(!columns.some(x=>x.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function validTime(value,fallback){return typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value)?value:fallback;}
function ymdMoscow(date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
function moscowTimestamp(date=new Date()){const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);return parts.replace('T',' ')}
function normalizeMoscowDate(value){const s=String(value||'').trim();return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)?s.slice(0,19).replace('T',' '):''}
function numOrNull(value){const n=Number(value);return value===''||!Number.isFinite(n)?null:n}
function weekMonday(){const today=new Date(`${ymdMoscow(new Date())}T00:00:00Z`),day=(today.getUTCDay()+6)%7;today.setUTCDate(today.getUTCDate()-day);return today.toISOString().slice(0,10)}
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
  if(!settings.auto_sync_enabled||running||Date.now()-lastAutomaticRun<minutes*60000)return;
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
