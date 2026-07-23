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
const applicationUsers = loadApplicationUsers();
if (isProduction && applicationUsers.some(user => user.password.length < 12)) throw new Error('Пароль каждого дополнительного пользователя должен содержать не менее 12 символов');
const DATA = join(process.cwd(), 'data');
mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(join(DATA, 'wb-autofund.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), token_enc TEXT, demo_mode INTEGER NOT NULL DEFAULT 1, check_minutes INTEGER NOT NULL DEFAULT 5, updated_at TEXT);
CREATE TABLE IF NOT EXISTS legal_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_enc TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
CREATE TABLE IF NOT EXISTS supplier_orders (legal_entity_id INTEGER NOT NULL, srid TEXT NOT NULL, order_date TEXT NOT NULL, last_change_date TEXT, nm_id TEXT, supplier_article TEXT, total_price REAL, finished_price REAL, is_cancel INTEGER NOT NULL DEFAULT 0, cancel_date TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(legal_entity_id,srid));
CREATE TABLE IF NOT EXISTS entity_sync_state (legal_entity_id INTEGER PRIMARY KEY, orders_last_change TEXT, orders_last_sync_at TEXT, orders_last_error TEXT);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_entity_date_nm ON supplier_orders(legal_entity_id,order_date,nm_id);
INSERT OR IGNORE INTO settings(id,demo_mode,check_minutes,updated_at) VALUES(1,1,5,datetime('now'));`);
migrateColumn('rules','use_max_drr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_min_ctr','INTEGER NOT NULL DEFAULT 1');
migrateColumn('rules','use_time_window','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','time_from','TEXT NOT NULL DEFAULT \'00:00\'');
migrateColumn('rules','time_to','TEXT NOT NULL DEFAULT \'23:59\'');
migrateColumn('settings','stats_days','INTEGER NOT NULL DEFAULT 7');
migrateColumn('settings','auto_sync_enabled','INTEGER NOT NULL DEFAULT 1');
migrateColumn('settings','active_entity_id','INTEGER');
migrateColumn('campaigns','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('operations','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('hourly_snapshots','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('hourly_snapshots','orders_total','INTEGER');
migrateColumn('campaign_daily_stats','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('sync_history','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('campaign_bids','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('campaign_bid_history','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
migrateColumn('campaign_bid_changes','legal_entity_id','INTEGER NOT NULL DEFAULT 1');
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
migrateColumn('rules','resume_delay_seconds','INTEGER NOT NULL DEFAULT 15');
migrateColumn('campaigns','resume_after_at','TEXT');
migrateColumn('rules','auto_pause','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_use_max_drr','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_max_drr','REAL NOT NULL DEFAULT 100');
migrateColumn('rules','pause_use_min_ctr','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_min_ctr','REAL NOT NULL DEFAULT 0');
migrateColumn('rules','pause_use_min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_min_views','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_use_min_orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_min_orders','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_use_max_daily_spend','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','pause_max_daily_spend','REAL NOT NULL DEFAULT 0');
migrateColumn('rules','schedule_enabled','INTEGER NOT NULL DEFAULT 0');
migrateColumn('rules','schedule_windows','TEXT NOT NULL DEFAULT \'[]\'');
migrateColumn('rules','schedule_auto_resume','INTEGER NOT NULL DEFAULT 1');
migrateColumn('campaigns','schedule_paused','INTEGER NOT NULL DEFAULT 0');
ensureDefaultLegalEntity();
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
  if (req.method==='GET' && url.pathname==='/api/legal-entities') return send(res,200,{entities:listLegalEntities(),active_entity_id:activeEntityId(url)});
  if (req.method==='POST' && url.pathname==='/api/legal-entities') {
    const name=String(body.name||'').trim();if(!name)throw new Error('Укажите название юрлица');
    const token=String(body.token||'').trim();if(!token)throw new Error('Укажите API-токен WB');
    const result=db.prepare('INSERT INTO legal_entities(name,token_enc,enabled,created_at,updated_at) VALUES(?,?,1,?,?)').run(name,encrypt(token),now(),now());
    db.prepare('UPDATE settings SET active_entity_id=?,updated_at=? WHERE id=1').run(Number(result.lastInsertRowid),now());
    return send(res,201,{ok:true,id:Number(result.lastInsertRowid)});
  }
  const entityMatch=url.pathname.match(/^\/api\/legal-entities\/(\d+)$/);
  if (req.method==='PUT' && entityMatch) {
    const id=Number(entityMatch[1]),current=db.prepare('SELECT * FROM legal_entities WHERE id=?').get(id);if(!current)throw new Error('Юрлицо не найдено');
    const name=String(body.name??current.name).trim();if(!name)throw new Error('Укажите название юрлица');
    const token=String(body.token||'').trim()?encrypt(String(body.token).trim()):current.token_enc;
    db.prepare('UPDATE legal_entities SET name=?,token_enc=?,enabled=?,updated_at=? WHERE id=?').run(name,token,body.enabled===false?0:1,now(),id);return send(res,200,{ok:true});
  }
  if (req.method==='POST' && url.pathname==='/api/legal-entities/select') {
    const id=Number(body.id);if(!db.prepare('SELECT id FROM legal_entities WHERE id=?').get(id))throw new Error('Юрлицо не найдено');
    db.prepare('UPDATE settings SET active_entity_id=?,updated_at=? WHERE id=1').run(id,now());return send(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/dashboard') {
    const entityId=activeEntityId(url);
    const campaigns=db.prepare(`SELECT c.*,r.enabled,r.auto_resume,r.resume_daily_limit,r.resume_delay_seconds,r.use_max_drr,r.max_drr,r.use_min_ctr,r.min_ctr,r.use_min_views,r.min_views,r.use_min_orders,r.min_orders,r.metrics_days,r.use_time_window,r.time_from,r.time_to,r.min_budget,r.deposit_amount,r.daily_limit,r.funding_type,r.auto_pause,r.pause_use_max_drr,r.pause_max_drr,r.pause_use_min_ctr,r.pause_min_ctr,r.pause_use_min_views,r.pause_min_views,r.pause_use_min_orders,r.pause_min_orders,r.pause_use_max_daily_spend,r.pause_max_daily_spend,r.schedule_enabled,r.schedule_windows,r.schedule_auto_resume FROM campaigns c LEFT JOIN rules r ON r.campaign_id=c.id WHERE c.status<>'archived' AND c.legal_entity_id=? ORDER BY c.id`).all(entityId);
    let periodFrom=url.searchParams.get('from'),periodTo=url.searchParams.get('to');
    const requestedDays=Number(url.searchParams.get('days'));
    if(Number.isFinite(requestedDays)&&requestedDays>=1&&requestedDays<=31){const range=moscowDateRange(requestedDays);periodFrom=range.from;periodTo=range.to;}
    if(/^\d{4}-\d{2}-\d{2}$/.test(periodFrom||'')&&/^\d{4}-\d{2}-\d{2}$/.test(periodTo||'')&&periodFrom<=periodTo){
      const periodRows=db.prepare(`SELECT campaign_id,SUM(views) views,SUM(clicks) clicks,SUM(orders) orders,SUM(spend) spend,SUM(revenue) revenue,COUNT(*) days FROM campaign_daily_stats WHERE legal_entity_id=? AND stat_date BETWEEN ? AND ? GROUP BY campaign_id`).all(entityId,periodFrom,periodTo),byCampaign=new Map(periodRows.map(row=>[Number(row.campaign_id),row]));
      for(const campaign of campaigns){const metrics=byCampaign.get(Number(campaign.id));if(!metrics){campaign.metrics_available=0;continue}campaign.views=Number(metrics.views||0);campaign.orders=Number(metrics.orders||0);campaign.spend=Number(metrics.spend||0);campaign.revenue=Number(metrics.revenue||0);campaign.ctr=metrics.views?Number(metrics.clicks||0)*100/Number(metrics.views):0;campaign.drr=metrics.revenue?campaign.spend*100/campaign.revenue:(campaign.spend>0?999999:0);campaign.metrics_available=1;campaign.metrics_from=periodFrom;campaign.metrics_to=periodTo;}
    }
    const operations=db.prepare(`SELECT * FROM operations WHERE legal_entity_id=? ORDER BY id DESC LIMIT 100`).all(entityId);
    const activityOperations=db.prepare(`SELECT * FROM operations WHERE legal_entity_id=? AND status IN ('deposited','resumed','paused') ORDER BY id DESC LIMIT 100`).all(entityId);
    const s=db.prepare(`SELECT demo_mode,check_minutes,stats_days,auto_sync_enabled,token_enc IS NOT NULL AS token_saved FROM settings WHERE id=1`).get();
    const entities=listLegalEntities(),entity=entities.find(x=>x.id===entityId);
    return send(res,200,{campaigns,operations,activity_operations:activityOperations,entities,active_entity_id:entityId,settings:{...s,token_saved:entity?.token_saved||0,display_from:periodFrom||null,display_to:periodTo||null,live_deposits:process.env.WB_LIVE_DEPOSITS==='true',live_resume:process.env.WB_LIVE_RESUME==='true'}});
  }
    if (req.method==='GET' && url.pathname==='/api/hourly') return send(res,200,hourlyDataWithOrders(url.searchParams.get('campaign_id'),url.searchParams.get('week'),activeEntityId(url)));
  if (req.method==='GET' && url.pathname==='/api/analytics') return send(res,200,analyticsDataV2(url.searchParams.get('from'),url.searchParams.get('to'),url.searchParams.get('campaign_id'),activeEntityId(url)));
  if (req.method==='GET' && url.pathname==='/api/shared/export') return send(res,200,sharedExport(url.searchParams.get('from'),url.searchParams.get('to')));
  if (req.method==='POST' && url.pathname==='/api/settings') {
    const current=db.prepare('SELECT * FROM settings WHERE id=1').get();
    const entityId=Number(body.legal_entity_id)||Number(current.active_entity_id)||1;
    if(typeof body.token==='string'&&body.token.trim())db.prepare('UPDATE legal_entities SET token_enc=?,updated_at=? WHERE id=?').run(encrypt(body.token.trim()),now(),entityId);
    db.prepare('UPDATE settings SET active_entity_id=?,demo_mode=?,check_minutes=?,stats_days=?,auto_sync_enabled=?,updated_at=? WHERE id=1').run(entityId,body.demo_mode?1:0,clamp(body.check_minutes,1,1440),clamp(body.stats_days ?? current.stats_days ?? 7,1,31),body.auto_sync_enabled===false?0:1,now());
    return send(res,200,{ok:true});
  }
  const ruleMatch=url.pathname.match(/^\/api\/campaigns\/(\d+)\/rule$/);
  if (req.method==='PUT' && ruleMatch) {
    const id=Number(ruleMatch[1]);
    const currentRule=db.prepare('SELECT metrics_days,auto_resume,resume_daily_limit,resume_delay_seconds FROM rules WHERE campaign_id=?').get(id);
    db.prepare(`INSERT INTO rules(campaign_id,enabled,auto_resume,resume_daily_limit,resume_delay_seconds,use_max_drr,max_drr,use_min_ctr,min_ctr,use_min_views,min_views,use_min_orders,min_orders,metrics_days,use_time_window,time_from,time_to,min_budget,deposit_amount,daily_limit,funding_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET enabled=excluded.enabled,auto_resume=excluded.auto_resume,resume_daily_limit=excluded.resume_daily_limit,resume_delay_seconds=excluded.resume_delay_seconds,use_max_drr=excluded.use_max_drr,max_drr=excluded.max_drr,use_min_ctr=excluded.use_min_ctr,min_ctr=excluded.min_ctr,use_min_views=excluded.use_min_views,min_views=excluded.min_views,use_min_orders=excluded.use_min_orders,min_orders=excluded.min_orders,metrics_days=excluded.metrics_days,use_time_window=excluded.use_time_window,time_from=excluded.time_from,time_to=excluded.time_to,min_budget=excluded.min_budget,deposit_amount=excluded.deposit_amount,daily_limit=excluded.daily_limit,funding_type=excluded.funding_type,updated_at=excluded.updated_at`).run(id,body.enabled?1:0,body.auto_resume==null?Number(currentRule?.auto_resume||0):(body.auto_resume?1:0),clamp(body.resume_daily_limit??currentRule?.resume_daily_limit??1,1,24),clamp(body.resume_delay_seconds??currentRule?.resume_delay_seconds??15,5,300),body.use_max_drr!==false?1:0,positive(body.max_drr),body.use_min_ctr!==false?1:0,positive(body.min_ctr),body.use_min_views?1:0,Math.round(positive(body.min_views)),body.use_min_orders?1:0,Math.round(positive(body.min_orders)),clamp(body.metrics_days??currentRule?.metrics_days??7,1,31),body.use_time_window?1:0,validTime(body.time_from,'00:00'),validTime(body.time_to,'23:59'),positive(body.min_budget),Math.round(positive(body.deposit_amount)),clamp(body.daily_limit,1,100),[0,1,3].includes(Number(body.funding_type))?Number(body.funding_type):1,now());
    db.prepare(`UPDATE rules SET auto_pause=?,pause_use_max_drr=?,pause_max_drr=?,pause_use_min_ctr=?,pause_min_ctr=?,pause_use_min_views=?,pause_min_views=?,pause_use_min_orders=?,pause_min_orders=?,pause_use_max_daily_spend=?,pause_max_daily_spend=? WHERE campaign_id=?`).run(body.auto_pause?1:0,body.pause_use_max_drr?1:0,positive(body.pause_max_drr),body.pause_use_min_ctr?1:0,positive(body.pause_min_ctr),body.pause_use_min_views?1:0,Math.round(positive(body.pause_min_views)),body.pause_use_min_orders?1:0,Math.round(positive(body.pause_min_orders)),body.pause_use_max_daily_spend?1:0,positive(body.pause_max_daily_spend),id);
    if(Object.hasOwn(body,'schedule_enabled')||Object.hasOwn(body,'schedule_windows')||Object.hasOwn(body,'schedule_auto_resume'))db.prepare(`UPDATE rules SET schedule_enabled=?,schedule_windows=?,schedule_auto_resume=? WHERE campaign_id=?`).run(body.schedule_enabled?1:0,JSON.stringify(normalizeScheduleWindows(body.schedule_windows)),body.schedule_auto_resume===false?0:1,id);
    setTimeout(()=>evaluateCampaign(id).catch(error=>console.error(`Immediate evaluation ${id} failed:`,error)),100);
    const settings=db.prepare('SELECT demo_mode FROM settings WHERE id=1').get();
    const liveDepositReady=Boolean(settings.demo_mode)||process.env.WB_LIVE_DEPOSITS==='true';
    return send(res,200,{ok:true,evaluation_queued:true,live_deposit_ready:liveDepositReady,live_resume_ready:Boolean(settings.demo_mode)||process.env.WB_LIVE_RESUME==='true',live_pause_ready:Boolean(settings.demo_mode)||process.env.WB_LIVE_PAUSE==='true'});
  }
  if (req.method==='POST' && url.pathname==='/api/sync') {
    const alreadyRunning=Boolean(activeSync);
    if(!alreadyRunning) syncCampaigns(Number(body.legal_entity_id)||activeEntityId(url)).catch(error=>console.error('Manual WB sync failed:',error));
    return send(res,202,{ok:true,started:!alreadyRunning,running:true});
  }
  if (req.method==='POST' && url.pathname==='/api/run') { const result=await evaluateAll(); return send(res,200,result); }
  return send(res,404,{error:'Метод не найден'});
}

async function evaluateAll() {
  const rows=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE r.enabled=1 OR r.auto_resume=1 OR r.auto_pause=1 OR r.schedule_enabled=1 OR c.schedule_paused=1`).all();
  let deposited=0,resumed=0,skipped=0;
  for (const c of rows) { const result=await evaluate(c); result==='deposited'?deposited++:result==='resumed'?resumed++:skipped++; }
  return {checked:rows.length,deposited,resumed,skipped};
}

async function evaluateCampaign(campaignId) {
  const row=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE c.id=? AND (r.enabled=1 OR r.auto_resume=1 OR r.auto_pause=1 OR r.schedule_enabled=1 OR c.schedule_paused=1)`).get(campaignId);
  return row?evaluate(row):'skipped';
}

async function evaluate(c) {
  const before=Number(c.budget),periodMetrics=campaignMetricsForDays(c.campaign_id,c.metrics_days||7);
  const scheduledNow=Boolean(c.schedule_enabled)&&isInsideSchedule(c.schedule_windows);
  if(scheduledNow&&c.status==='active')return pauseCampaignBySchedule(c,before);
  if(!scheduledNow&&c.schedule_paused&&c.schedule_auto_resume)return resumeCampaignBySchedule(c,before);
  if(scheduledNow||c.schedule_paused)return 'skipped';
  c.metrics_available=periodMetrics.available?1:0;c.ctr=periodMetrics.ctr;c.drr=periodMetrics.drr;c.views=periodMetrics.views;c.orders=periodMetrics.orders;
  const metrics={ctr:Number(c.ctr),drr:Number(c.drr)};
  if (c.status==='active' && c.auto_pause) {
    const stopConditions=[];
    if (c.metrics_available) {
      if (c.pause_use_max_drr && metrics.drr>Number(c.pause_max_drr)) stopConditions.push(`ДРР ${metrics.drr.toFixed(2)}% > ${Number(c.pause_max_drr)}%`);
      if (c.pause_use_min_ctr && metrics.ctr<Number(c.pause_min_ctr)) stopConditions.push(`CTR ${metrics.ctr.toFixed(2)}% < ${Number(c.pause_min_ctr)}%`);
      if (c.pause_use_min_views && Number(c.views)<Number(c.pause_min_views)) stopConditions.push(`Показы ${Number(c.views)} < ${Number(c.pause_min_views)}`);
      if (c.pause_use_min_orders && Number(c.orders)<Number(c.pause_min_orders)) stopConditions.push(`Заказы ${Number(c.orders)} < ${Number(c.pause_min_orders)}`);
    }
    const todaySpend=campaignSpendForMoscowToday(c.campaign_id,c.legal_entity_id);
    const dailySpendLimit=Number(c.pause_max_daily_spend);
    if (c.pause_use_max_daily_spend && dailySpendLimit>0 && todaySpend.available && todaySpend.spend>=dailySpendLimit) stopConditions.push(`Расход за ${todaySpend.date} достиг ${todaySpend.spend.toFixed(2)} ₽ при лимите ${dailySpendLimit} ₽`);
    if (stopConditions.length) return pauseCampaign(c,before,stopConditions.join('; '));
  }
  let reason='';
  if (c.use_time_window && !isMoscowTimeAllowed(c.time_from,c.time_to)) reason=`Вне разрешённого времени (${c.time_from}–${c.time_to} МСК)`;
  else if ((c.use_max_drr || c.use_min_ctr || c.use_min_views || c.use_min_orders) && !c.metrics_available) reason='Статистика кампании не получена — действие заблокировано';
  else if (c.use_max_drr && metrics.drr>c.max_drr) reason='ДРР выше максимума';
  else if (c.use_min_ctr && metrics.ctr<c.min_ctr) reason='CTR ниже минимума';
  else if (c.use_min_views && Number(c.views)<Number(c.min_views)) reason='Показы ниже минимума';
  else if (c.use_min_orders && Number(c.orders)<Number(c.min_orders)) reason='Заказы ниже минимума';
  if (reason) { log(c,'skipped',reason,0,before,before); return 'skipped'; }
  // A paused campaign that needs money is funded first. Resume is handled only
  // after the configured delay and a fresh WB budget check.
  if (c.status!=='active' && c.auto_resume && c.enabled && before<c.min_budget) return depositCampaign(c,before,true);
  if (c.status!=='active' && c.auto_resume) {
    if (c.resume_after_at && new Date(c.resume_after_at)>new Date()) return 'skipped';
    return resumeCampaign(c,before);
  }
  if (!reason && c.status!=='active') reason='Кампания не активна';
  else if (!reason && !c.enabled) return 'skipped';
  else if (!reason && before>=c.min_budget) reason='Остаток не ниже порога';
  // Wildberries rules use a Moscow calendar day, independent of the server timezone.
  const today=db.prepare(`SELECT count(*) n FROM operations WHERE campaign_id=? AND status='deposited' AND date(created_at,'+3 hours')=date('now','+3 hours')`).get(c.campaign_id).n;
  if (!reason && today>=c.daily_limit) reason='Достигнут дневной лимит';
  if (reason) { log(c,'skipped',reason,0,before,before); return 'skipped'; }
  return depositCampaign(c,before,false);
}

async function pauseCampaign(c,before,reason) {
  const pauseKey=createHash('sha256').update(`pause:${c.campaign_id}:${Date.now()}`).digest('hex');
  try {
    const settings=db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (!settings.demo_mode) {
      if (process.env.WB_LIVE_PAUSE!=='true') throw new Error('Боевое автоотключение выключено в .env');
      await wbCommand(`/adv/v0/pause?id=${c.campaign_id}`,tokenForEntity(c.legal_entity_id));
    }
    db.prepare(`UPDATE campaigns SET status='paused',resume_after_at=NULL,updated_at=? WHERE id=?`).run(now(),c.campaign_id);
    // A safety latch: an automatically paused campaign must not be funded or
    // resumed again until the user explicitly edits and enables those options.
    db.prepare(`UPDATE rules SET enabled=0,auto_resume=0,updated_at=? WHERE campaign_id=?`).run(now(),c.campaign_id);
    logAction(c,'pause','paused',`${settings.demo_mode?'Демо-автоотключение':'Кампания поставлена на паузу через WB API'}: ${reason}`,0,before,before,pauseKey);
    return 'paused';
  } catch(e) { logAction(c,'pause','error',e.message,0,before,before,pauseKey);return 'skipped'; }
}

async function pauseCampaignBySchedule(c,before){
  const key=createHash('sha256').update(`schedule-pause:${c.campaign_id}:${moscowTimestamp().slice(0,16)}`).digest('hex');
  try{const settings=db.prepare('SELECT demo_mode FROM settings WHERE id=1').get();if(!settings.demo_mode){if(process.env.WB_LIVE_PAUSE!=='true')throw new Error('Боевое автоотключение выключено в .env');await wbCommand(`/adv/v0/pause?id=${c.campaign_id}`,tokenForEntity(c.legal_entity_id));}db.prepare(`UPDATE campaigns SET status='paused',schedule_paused=1,resume_after_at=NULL,updated_at=? WHERE id=?`).run(now(),c.campaign_id);logAction(c,'schedule_pause','paused','Пауза по расписанию МСК',0,before,before,key);return'paused'}catch(error){logAction(c,'schedule_pause','error',error.message,0,before,before,key);return'skipped'}
}
async function resumeCampaignBySchedule(c,before){
  const key=createHash('sha256').update(`schedule-resume:${c.campaign_id}:${moscowTimestamp().slice(0,16)}`).digest('hex');
  try{const settings=db.prepare('SELECT demo_mode FROM settings WHERE id=1').get();let budget=before;if(!settings.demo_mode){if(process.env.WB_LIVE_RESUME!=='true')throw new Error('Боевое автовключение выключено в .env');const token=tokenForEntity(c.legal_entity_id),answer=await wb(`/adv/v1/budget?id=${c.campaign_id}`,token);budget=Number(answer.total||0);if(budget<=0)throw new Error('Кампания не включена: на бюджете нет средств');await wbCommand(`/adv/v0/start?id=${c.campaign_id}`,token);}db.prepare(`UPDATE campaigns SET status='active',schedule_paused=0,budget=?,updated_at=? WHERE id=?`).run(budget,now(),c.campaign_id);logAction(c,'schedule_resume','resumed','Включено после окончания паузы по расписанию МСК',0,before,budget,key);return'resumed'}catch(error){logAction(c,'schedule_resume','error',error.message,0,before,before,key);return'skipped'}
}

async function depositCampaign(c,before,scheduleResume) {
  const depositsToday=db.prepare(`SELECT count(*) n FROM operations WHERE campaign_id=? AND status='deposited' AND date(created_at,'+3 hours')=date('now','+3 hours')`).get(c.campaign_id).n;
  if (depositsToday>=Number(c.daily_limit||1)) { log(c,'skipped','Достигнут дневной лимит пополнений',0,before,before); return 'skipped'; }
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
      const token=tokenForEntity(c.legal_entity_id); const response=await wb(`/adv/v1/budget/deposit?id=${c.campaign_id}`,token,{sum:c.deposit_amount,type:c.funding_type,return:true}); after=Number(response.total);
    }
    const resumeAfter=scheduleResume?new Date(Date.now()+Number(c.resume_delay_seconds||15)*1000).toISOString():null;
    db.prepare('UPDATE campaigns SET budget=?,resume_after_at=?,updated_at=? WHERE id=?').run(after,resumeAfter,now(),c.campaign_id);
    log(c,'deposited',settings.demo_mode?'Демо-пополнение':'Пополнено через WB API',c.deposit_amount,before,after,idem); return 'deposited';
  } catch(e) { log(c,'error',e.message,0,before,before,idem); return 'skipped'; }
  finally { db.prepare('DELETE FROM locks WHERE campaign_id=?').run(c.campaign_id); }
}

async function resumeCampaign(c,before) {
  const resumedToday=db.prepare(`SELECT count(*) n FROM operations WHERE campaign_id=? AND action='resume' AND status='resumed' AND date(created_at,'+3 hours')=date('now','+3 hours')`).get(c.campaign_id).n;
  if (resumedToday>=Number(c.resume_daily_limit||1)) { logAction(c,'resume','skipped','Достигнут дневной лимит автовозобновлений',0,before,before); return 'skipped'; }
  const resumeKey=createHash('sha256').update(`resume:${c.campaign_id}:${Date.now()}`).digest('hex');
  try {
    const settings=db.prepare('SELECT * FROM settings WHERE id=1').get();let confirmedBudget=before;
    if (!settings.demo_mode) {
      if (process.env.WB_LIVE_RESUME!=='true') throw new Error('Боевое возобновление выключено в .env');
      const token=tokenForEntity(c.legal_entity_id),budget=await wb(`/adv/v1/budget?id=${c.campaign_id}`,token);
      confirmedBudget=Number(budget.total||0);
      if (confirmedBudget<=0) {
        db.prepare('UPDATE campaigns SET resume_after_at=?,updated_at=? WHERE id=?').run(new Date(Date.now()+30000).toISOString(),now(),c.campaign_id);
        return 'skipped';
      }
      await wbCommand(`/adv/v0/start?id=${c.campaign_id}`,token);
    }
    db.prepare(`UPDATE campaigns SET status='active',budget=?,resume_after_at=NULL,updated_at=? WHERE id=?`).run(confirmedBudget,now(),c.campaign_id);
    logAction(c,'resume','resumed',settings.demo_mode?'Демо-возобновление':'Бюджет подтверждён, кампания возобновлена через WB API',0,before,confirmedBudget,resumeKey);
    return 'resumed';
  } catch(e) {
    db.prepare('UPDATE campaigns SET resume_after_at=?,updated_at=? WHERE id=?').run(new Date(Date.now()+60000).toISOString(),now(),c.campaign_id);
    logAction(c,'resume','error',e.message,0,before,before,resumeKey);return 'skipped';
  }
}

let activeSync=null;
async function syncCampaigns(entityId=1) {
  if(activeSync) return activeSync;
  activeSync=doSyncCampaigns(entityId);
  try { return await activeSync; } finally { activeSync=null; }
}
async function doSyncCampaigns(entityId) {
  const s=db.prepare('SELECT * FROM settings WHERE id=1').get();
  if (s.demo_mode) { seedDemo(); return; }
  const entity=db.prepare('SELECT * FROM legal_entities WHERE id=? AND enabled=1').get(entityId);
  if (!entity?.token_enc) throw new Error('Сначала сохраните токен WB для выбранного юрлица');
  const token=decrypt(entity.token_enc);
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
  db.prepare(`UPDATE campaigns SET status='archived' WHERE source='wb' AND legal_entity_id=?`).run(entityId);
  for (const a of campaigns) {
    const id=Number(a.advertId || a.advert_id || a.id); if (!id) continue;
    const name=a.name || a.settings?.name || `Кампания ${id}`;
    db.prepare(`INSERT INTO campaigns(id,name,status,budget,ctr,drr,source,updated_at,legal_entity_id) VALUES(?,?,?,0,0,0,'wb',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,source='wb',updated_at=excluded.updated_at,legal_entity_id=excluded.legal_entity_id`).run(id,name,Number(a.status)===9?'active':'paused',now(),entityId);
  }
  await syncCampaignBids(token,campaigns,entityId);
  // The Statistics API contains the actual order timestamp. It is independent
  // from Promotion API limits and must never block campaign automation.
  try { await syncSupplierOrders(token,entityId); }
  catch(error) {
    console.warn(`WB supplier orders sync failed for entity ${entityId}:`,error.message);
    db.prepare(`INSERT INTO entity_sync_state(legal_entity_id,orders_last_sync_at,orders_last_error) VALUES(?,?,?) ON CONFLICT(legal_entity_id) DO UPDATE SET orders_last_sync_at=excluded.orders_last_sync_at,orders_last_error=excluded.orders_last_error`).run(entityId,now(),String(error.message||error).slice(0,1000));
  }
  // Statistics has the strictest WB limit, so request it before the per-campaign
  // budget calls consume the seller's shared promotion API allowance.
  await new Promise(resolve=>setTimeout(resolve,21000));
  await syncStatistics(token, campaigns.map(a=>Number(a.advertId || a.advert_id || a.id)).filter(Boolean), s.stats_days || 7,entityId);
  for (const a of campaigns) {
    const id=Number(a.advertId || a.advert_id || a.id); if (!id) continue;
    const budget=await wb(`/adv/v1/budget?id=${id}`,token);
    db.prepare(`UPDATE campaigns SET budget=?,updated_at=? WHERE id=?`).run(Number(budget.total||0),now(),id);
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}

async function syncCampaignBids(token,campaigns,entityId=1){
  const ids=campaigns.map(a=>Number(a.advertId||a.advert_id||a.id)).filter(Boolean),stamp=moscowTimestamp();let changed=0,seen=0;
  for(let offset=0;offset<ids.length;offset+=50){if(offset)await new Promise(resolve=>setTimeout(resolve,1100));const response=await wb(`/api/advert/v2/adverts?ids=${ids.slice(offset,offset+50).join(',')}`,token),items=Array.isArray(response)?response:(response?.adverts||response?.data||[]);
    for(const item of items){const id=Number(item.advertId||item.advert_id||item.id);if(!id)continue;const settings=item.settings&&typeof item.settings==='object'?item.settings:{},name=item.name||item.campaignName||item.advertName||settings.name||`Кампания ${id}`,payment=String(item.paymentType||item.payment_type||settings.payment_type||settings.paymentType||'').toUpperCase(),nms=Array.isArray(item.nm_settings)?item.nm_settings:(Array.isArray(settings.nm_settings)?settings.nm_settings:[]);
      for(const nm of nms){const nmId=String(nm.nm_id||nm.nmId||nm.nm||'');if(!nmId)continue;const bids=nm.bids_kopecks&&typeof nm.bids_kopecks==='object'?nm.bids_kopecks:{},subject=typeof nm.subject==='object'?(nm.subject.name||nm.subject.id||''):(nm.subject||nm.subject_name||nm.name||'');for(const placement of ['search','recommendations']){const kopecks=Number(bids[placement]);if(!Number.isFinite(kopecks))continue;const rub=kopecks/100,old=db.prepare(`SELECT bid_rub FROM campaign_bids WHERE campaign_id=? AND nm_id=? AND placement=? AND legal_entity_id=?`).get(id,nmId,placement,entityId);if(old&&Number(old.bid_rub)!==rub){db.prepare(`INSERT OR IGNORE INTO campaign_bid_changes(changed_at,campaign_id,nm_id,placement,old_value,new_value,legal_entity_id) VALUES(?,?,?,?,?,?,?)`).run(stamp,id,nmId,placement,String(old.bid_rub),String(rub),entityId);changed++}db.prepare(`INSERT INTO campaign_bids(campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at,legal_entity_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,nm_id,placement) DO UPDATE SET campaign_name=excluded.campaign_name,subject=excluded.subject,bid_rub=excluded.bid_rub,payment_type=excluded.payment_type,updated_at=excluded.updated_at,legal_entity_id=excluded.legal_entity_id`).run(id,name,nmId,String(subject),placement,rub,payment,stamp,entityId);db.prepare(`INSERT OR IGNORE INTO campaign_bid_history(snapshot_at,campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at,legal_entity_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(stamp,id,name,nmId,String(subject),placement,rub,payment,stamp,entityId);seen++}}}
  }
  console.log(`WB bids synced: ${seen}; changed: ${changed}`);return{seen,changed};
}

async function syncSupplierOrders(token,entityId=1,force=false){
  const state=db.prepare(`SELECT * FROM entity_sync_state WHERE legal_entity_id=?`).get(entityId);
  const lastSyncMs=Date.parse(state?.orders_last_sync_at||'');
  if(!force&&Number.isFinite(lastSyncMs)&&Date.now()-lastSyncMs<25*60*1000)return{skipped:true};
  const fallback=new Date(Date.now()-7*86400000).toISOString();
  const cursor=state?.orders_last_change?new Date(`${state.orders_last_change.replace(' ','T')}+03:00`):null;
  const dateFrom=cursor&&!Number.isNaN(cursor.getTime())?new Date(cursor.getTime()-2*3600000).toISOString():fallback;
  const rows=await wbStatistics(`/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`,token);
  let maxChange=state?.orders_last_change||'';
  const upsert=db.prepare(`INSERT INTO supplier_orders(legal_entity_id,srid,order_date,last_change_date,nm_id,supplier_article,total_price,finished_price,is_cancel,cancel_date,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(legal_entity_id,srid) DO UPDATE SET order_date=excluded.order_date,last_change_date=excluded.last_change_date,nm_id=excluded.nm_id,supplier_article=excluded.supplier_article,total_price=excluded.total_price,finished_price=excluded.finished_price,is_cancel=excluded.is_cancel,cancel_date=excluded.cancel_date,updated_at=excluded.updated_at`);
  for(const row of Array.isArray(rows)?rows:[]){
    const srid=String(row.srid||'').trim(),orderDate=normalizeMoscowDate(row.date),changed=normalizeMoscowDate(row.lastChangeDate);
    if(!srid||!orderDate)continue;
    upsert.run(entityId,srid,orderDate,changed||null,String(row.nmId||''),String(row.supplierArticle||''),numOrNull(row.totalPrice),numOrNull(row.finishedPrice),row.isCancel?1:0,normalizeMoscowDate(row.cancelDate)||null,now());
    if(changed>maxChange)maxChange=changed;
  }
  db.prepare(`INSERT INTO entity_sync_state(legal_entity_id,orders_last_change,orders_last_sync_at,orders_last_error) VALUES(?,?,?,NULL) ON CONFLICT(legal_entity_id) DO UPDATE SET orders_last_change=excluded.orders_last_change,orders_last_sync_at=excluded.orders_last_sync_at,orders_last_error=NULL`).run(entityId,maxChange||null,now());
  console.log(`WB supplier orders synced for entity ${entityId}: ${Array.isArray(rows)?rows.length:0}`);
  return{rows:Array.isArray(rows)?rows.length:0};
}

async function wbStatistics(path,token){
  const base=process.env.WB_STATISTICS_API_BASE||'https://statistics-api.wildberries.ru';
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(`${base}${path}`,{headers:{Authorization:token}});
    if(response.ok){const text=await response.text();return text?JSON.parse(text):[]}
    const error=await response.text();
    if(response.status!==429||attempt===2)throw new Error(`WB Statistics API: ${response.status} ${error}`);
    const retryAfter=Number(response.headers.get('retry-after'));
    await new Promise(resolve=>setTimeout(resolve,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:60_000));
  }
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

async function syncStatistics(token, ids, days,entityId=1) {
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
        db.prepare(`INSERT INTO campaign_daily_stats(campaign_id,stat_date,views,clicks,orders,spend,revenue,ctr,drr,updated_at,legal_entity_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,stat_date) DO UPDATE SET views=excluded.views,clicks=excluded.clicks,orders=excluded.orders,spend=excluded.spend,revenue=excluded.revenue,ctr=excluded.ctr,drr=excluded.drr,updated_at=excluded.updated_at,legal_entity_id=excluded.legal_entity_id`).run(id,statDate,dayViews,dayClicks,dayOrders,daySpend,dayRevenue,dayCtr,dayDrr,now(),entityId);
      }
      const today=days.find(day=>String(day.date||'').slice(0,10)===endDate);
      if(today){const campaign=db.prepare('SELECT name,status FROM campaigns WHERE id=?').get(id)||{},todayMetrics=wbStatMetrics(today);db.prepare(`INSERT OR IGNORE INTO hourly_snapshots(campaign_id,campaign_name,status,snapshot_at,impressions_total,clicks_total,orders_total,quality,note,legal_entity_id) VALUES(?,?,?,?,?,?,?,'ok','WB API',?)`).run(id,campaign.name||'',campaign.status||'',moscowTimestamp(),todayMetrics.views,todayMetrics.clicks,todayMetrics.orders,entityId);}
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
function logAction(c,action,status,reason,amount,before,after,idem=null){db.prepare(`INSERT OR IGNORE INTO operations(campaign_id,campaign_name,created_at,action,status,reason,amount,budget_before,budget_after,ctr,drr,idempotency_key,legal_entity_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.campaign_id||c.id,c.name,now(),action,status,reason,amount,before,after,c.ctr,c.drr,idem,Number(c.legal_entity_id)||1);}
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
function hourlyDataV2(campaignId,week,entityId=1){
  const campaigns=db.prepare(`SELECT c.id,c.name,c.status FROM campaigns c WHERE c.status<>'archived' AND c.legal_entity_id=? AND EXISTS(SELECT 1 FROM hourly_snapshots h WHERE h.campaign_id=c.id AND h.legal_entity_id=?) ORDER BY c.name`).all(entityId,entityId);
  const id=Number(campaignId)||Number(campaigns[0]?.id||0);
  const available=db.prepare(`SELECT DISTINCT substr(h.snapshot_at,1,10) day FROM hourly_snapshots h JOIN campaigns c ON c.id=h.campaign_id WHERE c.status<>'archived' AND h.legal_entity_id=? ORDER BY day DESC`).all(entityId).map(x=>mondayOf(x.day));
  const weeks=[...new Set([weekMonday(),...available])].sort().reverse().map(value=>({value,label:weekLabel(value)}));
  const start=/^\d{4}-\d{2}-\d{2}$/.test(week||'')?mondayOf(week):weeks[0]?.value||weekMonday(),end=new Date(`${start}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
  const rows=db.prepare(`SELECT * FROM hourly_snapshots WHERE campaign_id=? AND legal_entity_id=? AND snapshot_at>=? AND snapshot_at<? ORDER BY snapshot_at`).all(id,entityId,`${start} 00:00:00`,`${end.toISOString().slice(0,10)} 00:00:00`),cells=[];
  // Several syncs can happen within one hour. Keep the latest cumulative
  // snapshot for each hour, so the resulting delta represents the whole hour.
  const latestByHour=new Map();
  for(const row of rows) latestByHour.set(row.snapshot_at.slice(0,13),row);
  rows.splice(0,rows.length,...latestByHour.values());
  let previous=null,previousDay='';
  for(const r of rows){const day=r.snapshot_at.slice(0,10),hour=Number(r.snapshot_at.slice(11,13));let views=null,clicks=null,uncertain=r.quality!=='ok',note=r.note||'';if(previous&&previousDay===day&&r.impressions_total!=null&&previous.impressions_total!=null){views=Math.max(0,r.impressions_total-previous.impressions_total);clicks=Math.max(0,r.clicks_total-previous.clicks_total)}else if(r.impressions_total!=null){views=r.impressions_total;clicks=r.clicks_total;uncertain=true;note=note||'Первый снимок дня'}cells.push({date:day,hour,views,clicks,uncertain,note});previous=r;previousDay=day}
  return{campaigns,weeks,selected_id:id,week:start,cells};
}
function hourlyDataWithOrders(campaignId,week,entityId=1){
  const campaigns=db.prepare(`SELECT c.id,c.name,c.status FROM campaigns c WHERE c.status<>'archived' AND c.legal_entity_id=? ORDER BY c.name`).all(entityId);
  const id=Number(campaignId)||Number(campaigns[0]?.id||0);
  const available=db.prepare(`SELECT day FROM (
    SELECT DISTINCT substr(snapshot_at,1,10) day FROM hourly_snapshots WHERE legal_entity_id=?
    UNION
    SELECT DISTINCT substr(order_date,1,10) day FROM supplier_orders WHERE legal_entity_id=?
  ) ORDER BY day DESC`).all(entityId,entityId).map(x=>mondayOf(x.day));
  const weeks=[...new Set([weekMonday(),...available])].sort().reverse().map(value=>({value,label:weekLabel(value)}));
  const start=/^\d{4}-\d{2}-\d{2}$/.test(week||'')?mondayOf(week):weeks[0]?.value||weekMonday();
  const end=new Date(`${start}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
  const endDay=end.toISOString().slice(0,10);
  const rows=db.prepare(`SELECT * FROM hourly_snapshots WHERE campaign_id=? AND legal_entity_id=? AND snapshot_at>=? AND snapshot_at<? ORDER BY snapshot_at`).all(id,entityId,`${start} 00:00:00`,`${end.toISOString().slice(0,10)} 00:00:00`);
  const latestByHour=new Map();
  for(const row of rows) latestByHour.set(row.snapshot_at.slice(0,13),row);
  const cells=[],hourRows=[...latestByHour.values()];
  let previous=null,previousDay='';
  for(const row of hourRows){
    const day=row.snapshot_at.slice(0,10),hour=Number(row.snapshot_at.slice(11,13));
    let views=null,clicks=null,orders=null,uncertain=row.quality!=='ok',note=row.note||'';
    if(previous&&previousDay===day&&row.impressions_total!=null&&previous.impressions_total!=null){
      const viewsDelta=row.impressions_total-previous.impressions_total,clicksDelta=row.clicks_total-previous.clicks_total;
      views=Math.max(0,viewsDelta);
      clicks=Math.max(0,clicksDelta);
      if(row.orders_total!=null&&previous.orders_total!=null) orders=Math.max(0,row.orders_total-previous.orders_total);
      const previousMs=Date.parse(previous.snapshot_at.replace(' ','T')+'+03:00'),currentMs=Date.parse(row.snapshot_at.replace(' ','T')+'+03:00');
      const gapMinutes=Math.round((currentMs-previousMs)/60000);
      if(viewsDelta<0||clicksDelta<0){uncertain=true;note=[note,'Счётчик WB был пересчитан или сброшен'].filter(Boolean).join('. ')}
      if(gapMinutes>90){uncertain=true;note=[note,`Между снимками ${gapMinutes} мин.; показы и клики относятся ко всему этому интервалу`].filter(Boolean).join('. ')}
    }else if(row.impressions_total!=null){
      views=row.impressions_total;
      clicks=row.clicks_total;
      if(row.orders_total!=null) orders=row.orders_total;
      uncertain=true;
      note=note||'Первый снимок дня';
    }
    cells.push({date:day,hour,views,clicks,orders,orders_uncertain:orders!=null,uncertain,note,captured_at:row.snapshot_at});
    previous=row;previousDay=day;
  }
  const cellMap=new Map(cells.map(cell=>[`${cell.date}-${cell.hour}`,cell]));
  const nmRows=db.prepare(`SELECT DISTINCT nm_id FROM campaign_bids WHERE campaign_id=? AND legal_entity_id=? AND nm_id<>''`).all(id,entityId);
  const nmIds=nmRows.map(row=>String(row.nm_id));
  const syncState=db.prepare(`SELECT orders_last_sync_at,orders_last_error FROM entity_sync_state WHERE legal_entity_id=?`).get(entityId)||{};
  let ordersMode='promotion_report_time',ambiguousProducts=0;
  if(nmIds.length&&syncState.orders_last_sync_at&&!syncState.orders_last_error){
    const placeholders=nmIds.map(()=>'?').join(',');
    const orderRows=db.prepare(`SELECT substr(order_date,1,10) date,CAST(substr(order_date,12,2) AS INTEGER) hour,COUNT(*) orders
      FROM supplier_orders WHERE legal_entity_id=? AND is_cancel=0 AND nm_id IN (${placeholders})
      AND order_date>=? AND order_date<? GROUP BY substr(order_date,1,10),CAST(substr(order_date,12,2) AS INTEGER)`)
      .all(entityId,...nmIds,`${start} 00:00:00`,`${endDay} 00:00:00`);
    ambiguousProducts=db.prepare(`SELECT COUNT(*) count FROM (
      SELECT nm_id FROM campaign_bids WHERE legal_entity_id=? AND nm_id IN (${placeholders})
      GROUP BY nm_id HAVING COUNT(DISTINCT campaign_id)>1
    )`).get(entityId,...nmIds).count||0;
    for(const cell of cells){cell.orders=null;cell.orders_uncertain=false}
    for(const order of orderRows){
      const key=`${order.date}-${order.hour}`;
      const cell=cellMap.get(key)||{date:order.date,hour:order.hour,views:null,clicks:null,uncertain:true,note:'Нет снимка рекламной статистики за этот час'};
      cell.orders=Number(order.orders)||0;
      cell.orders_uncertain=ambiguousProducts>0;
      cell.note=[cell.note,'Заказы показаны по фактическому времени оформления',ambiguousProducts?'Привязка к кампании расчётная: один или несколько товаров участвуют в нескольких кампаниях':'Привязка к кампании рассчитана по товарам из кампании'].filter(Boolean).join('. ');
      if(!cellMap.has(key)){cells.push(cell);cellMap.set(key,cell)}
    }
    ordersMode='statistics_actual_time';
  }else{
    for(const cell of cells)if(cell.orders!=null){
      cell.orders_uncertain=true;
      cell.note=[cell.note,'Заказы распределены по часу появления в рекламном отчёте WB и могут уточняться позже'].filter(Boolean).join('. ');
    }
  }
  cells.sort((a,b)=>a.date.localeCompare(b.date)||a.hour-b.hour);
  return{campaigns,weeks,selected_id:id,week:start,cells,orders_mode:ordersMode,orders_last_sync_at:syncState.orders_last_sync_at||null,orders_sync_error:syncState.orders_last_error||null,ambiguous_products:ambiguousProducts};
}
function analyticsDataV2(from,to,campaignId,entityId=1){
  const end=to&&/^\d{4}-\d{2}-\d{2}$/.test(to)?to:ymdMoscow(new Date()),start=from&&/^\d{4}-\d{2}-\d{2}$/.test(from)?from:(()=>{const d=new Date();d.setUTCDate(d.getUTCDate()-6);return ymdMoscow(d)})();
  const stats=db.prepare(`SELECT d.campaign_id,SUM(d.views) views,SUM(d.clicks) clicks,SUM(d.orders) orders,SUM(d.spend) spend,SUM(d.revenue) revenue,CASE WHEN SUM(d.views)>0 THEN SUM(d.clicks)*100.0/SUM(d.views) ELSE 0 END ctr,CASE WHEN SUM(d.revenue)>0 THEN SUM(d.spend)*100.0/SUM(d.revenue) ELSE 0 END drr FROM campaign_daily_stats d JOIN campaigns c ON c.id=d.campaign_id WHERE d.legal_entity_id=? AND d.stat_date BETWEEN ? AND ? AND c.status<>'archived' GROUP BY d.campaign_id`).all(entityId,start,end);
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
function campaignSpendForMoscowToday(campaignId,entityId=1){const date=ymdMoscow(new Date()),row=db.prepare(`SELECT spend FROM campaign_daily_stats WHERE campaign_id=? AND legal_entity_id=? AND stat_date=?`).get(campaignId,Number(entityId)||1,date);return{available:Boolean(row),date,spend:Number(row?.spend||0)}}
function migrateColumn(table,column,definition){const columns=db.prepare(`PRAGMA table_info(${table})`).all();if(!columns.some(x=>x.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function ensureDefaultLegalEntity(){
  if(!db.prepare('SELECT id FROM legal_entities LIMIT 1').get()){const s=db.prepare('SELECT token_enc FROM settings WHERE id=1').get()||{};db.prepare('INSERT INTO legal_entities(id,name,token_enc,enabled,created_at,updated_at) VALUES(1,?,?,1,?,?)').run('Основное юрлицо',s.token_enc||null,now(),now());}
  const s=db.prepare('SELECT active_entity_id FROM settings WHERE id=1').get();if(!s?.active_entity_id)db.prepare('UPDATE settings SET active_entity_id=1 WHERE id=1').run();
}
function listLegalEntities(){return db.prepare('SELECT id,name,enabled,token_enc IS NOT NULL AS token_saved,created_at,updated_at FROM legal_entities ORDER BY id').all().map(x=>({...x,id:Number(x.id)}));}
function activeEntityId(url){const requested=Number(url?.searchParams?.get('legal_entity_id'));if(requested&&db.prepare('SELECT id FROM legal_entities WHERE id=?').get(requested))return requested;return Number(db.prepare('SELECT active_entity_id FROM settings WHERE id=1').get()?.active_entity_id)||1;}
function tokenForEntity(id){const entity=db.prepare('SELECT token_enc FROM legal_entities WHERE id=? AND enabled=1').get(Number(id)||1);return decrypt(entity?.token_enc);}
function normalizeScheduleWindows(value){let rows=value;if(typeof rows==='string')try{rows=JSON.parse(rows)}catch{rows=[]}if(!Array.isArray(rows))return[];return rows.slice(0,12).map(row=>({from:validTime(row?.from,'00:00'),to:validTime(row?.to,'00:00')})).filter(row=>row.from!==row.to)}
function isInsideSchedule(value,date=new Date()){const windows=normalizeScheduleWindows(value),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date),hour=Number(parts.find(x=>x.type==='hour')?.value||0),minute=Number(parts.find(x=>x.type==='minute')?.value||0),nowMinutes=hour*60+minute,toMinutes=time=>Number(time.slice(0,2))*60+Number(time.slice(3));return windows.some(window=>{const from=toMinutes(window.from),to=toMinutes(window.to);return from<to?nowMinutes>=from&&nowMinutes<to:nowMinutes>=from||nowMinutes<to})}
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
function authorized(req){const value=req.headers.authorization||'';if(!value.startsWith('Basic '))return false;let decoded='';try{decoded=Buffer.from(value.slice(6),'base64').toString('utf8')}catch{return false}const separator=decoded.indexOf(':');if(separator<0)return false;const username=decoded.slice(0,separator),password=decoded.slice(separator+1);return applicationUsers.some(user=>safeEqual(username,user.username)&&safeEqual(password,user.password));}
function loadApplicationUsers(){
  const users=[{username:process.env.ADMIN_USERNAME||'admin',password:process.env.ADMIN_PASSWORD||''}];
  const raw=String(process.env.ADDITIONAL_USERS_JSON||'').trim();
  if(!raw)return users;
  let extra;
  try{extra=JSON.parse(raw)}catch{throw new Error('ADDITIONAL_USERS_JSON должен содержать корректный JSON-массив')}
  if(!Array.isArray(extra))throw new Error('ADDITIONAL_USERS_JSON должен быть JSON-массивом');
  const names=new Set(users.map(user=>user.username));
  for(const item of extra){
    const username=String(item?.username||'').trim(),password=String(item?.password||'');
    if(!username||!password)throw new Error('У каждого дополнительного пользователя должны быть username и password');
    if(names.has(username))throw new Error(`Логин пользователя повторяется: ${username}`);
    names.add(username);users.push({username,password});
  }
  return users;
}
function safeEqual(a,b){return timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());}
function now(){return new Date().toISOString()} function positive(v){v=Number(v);if(!Number.isFinite(v)||v<0)throw new Error('Поля правила должны быть неотрицательными');return v} function clamp(v,a,b){return Math.max(a,Math.min(b,Math.round(Number(v)||a)))}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))} async function jsonBody(req){let s='';for await(const c of req){s+=c;if(s.length>1e6)throw new Error('Слишком большой запрос')}return s?JSON.parse(s):{}}

server.listen(PORT,HOST,()=>console.log(`WB AutoFund: http://${HOST}:${PORT}`));
let scheduleRunning=false;setInterval(async()=>{
  if(scheduleRunning)return;scheduleRunning=true;
  try{const rows=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE c.status<>'archived' AND (r.schedule_enabled=1 OR c.schedule_paused=1)`).all();for(const c of rows){const inside=Boolean(c.schedule_enabled)&&isInsideSchedule(c.schedule_windows);if(inside&&c.status==='active')await pauseCampaignBySchedule(c,Number(c.budget));else if(!inside&&c.schedule_paused&&c.schedule_auto_resume)await resumeCampaignBySchedule(c,Number(c.budget));}}
  catch(error){console.error('Schedule cycle failed:',error)}finally{scheduleRunning=false}
},30000).unref();
let pendingResumeRunning=false;setInterval(async()=>{
  if(pendingResumeRunning)return;pendingResumeRunning=true;
  try{const rows=db.prepare(`SELECT c.*,r.* FROM campaigns c JOIN rules r ON r.campaign_id=c.id WHERE r.auto_resume=1 AND c.status<>'active' AND c.status<>'archived' AND c.resume_after_at IS NOT NULL AND c.resume_after_at<=?`).all(now());for(const row of rows)await resumeCampaign(row,Number(row.budget));}
  catch(error){console.error('Pending resume failed:',error)}finally{pendingResumeRunning=false}
},5000).unref();
let running=false,lastAutomaticRun=0;setInterval(async()=>{
  const settings=db.prepare('SELECT * FROM settings WHERE id=1').get(),minutes=settings.check_minutes;
  if(!settings.auto_sync_enabled||running||Date.now()-lastAutomaticRun<minutes*60000)return;
  running=true;lastAutomaticRun=Date.now();
  try {
    // A closed browser must not stop automation: refresh WB data on the server
    // before every decision. If sync fails, evaluation is skipped safely.
    if(!settings.demo_mode) for(const entity of listLegalEntities().filter(x=>x.enabled&&x.token_saved))await syncCampaigns(entity.id);
    await evaluateAll();
  } catch(e) { console.error('Automatic cycle skipped:',e); }
  finally { running=false; }
},15000);
function shutdown(){server.close(()=>{db.close();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
