import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir=process.env.DIARY_DATA_DIR||'/diary-data';
const db=new DatabaseSync('/app/data/wb-autofund.sqlite');
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000');

function csv(path){if(!existsSync(path))return[];const text=readFileSync(path,'utf8'),rows=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(field);field=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';if(row.some(Boolean))rows.push(row);row=[]}else field+=c}if(field||row.length){row.push(field);rows.push(row)}if(!rows.length)return[];const heads=rows.shift().map((x,i)=>i?x:x.replace(/^\uFEFF/,''));return rows.map(values=>Object.fromEntries(heads.map((h,i)=>[h,values[i]??''])))}
const numeric=v=>{const n=Number(v);return v===''||!Number.isFinite(n)?null:n};
const cleanDate=v=>{const s=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)?s.slice(0,19).replace('T',' '):s.slice(0,19)};
const current=db.prepare(`INSERT INTO campaign_bids(campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,nm_id,placement) DO UPDATE SET campaign_name=excluded.campaign_name,subject=excluded.subject,bid_rub=excluded.bid_rub,payment_type=excluded.payment_type,updated_at=excluded.updated_at`);
const history=db.prepare(`INSERT OR IGNORE INTO campaign_bid_history(snapshot_at,campaign_id,campaign_name,nm_id,subject,placement,bid_rub,payment_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
const change=db.prepare(`INSERT OR IGNORE INTO campaign_bid_changes(changed_at,campaign_id,nm_id,placement,old_value,new_value) VALUES(?,?,?,?,?,?)`);
let currentCount=0,historyCount=0,changeCount=0;
db.exec('BEGIN IMMEDIATE');
try{
  for(const r of csv(join(dir,'campaign_bids_current.csv'))){const id=Number(r.campaign_id),nm=String(r.nm_id||''),place=String(r.placement||'');if(!id||!nm||!place)continue;current.run(id,r.campaign_name||'',nm,r.subject||'',place,numeric(r.bid_rub),r.payment_type||'',cleanDate(r.updated_at));currentCount++}
  for(const r of csv(join(dir,'campaign_bids_history.csv'))){const id=Number(r.campaign_id),nm=String(r.nm_id||''),place=String(r.placement||'');if(!id||!nm||!place)continue;history.run(cleanDate(r.snapshot_at)||cleanDate(r.updated_at),id,r.campaign_name||'',nm,r.subject||'',place,numeric(r.bid_rub),r.payment_type||'',cleanDate(r.updated_at));historyCount++}
  for(const r of csv(join(dir,'changes_log.csv'))){const type=String(r.change_type||''),lower=type.toLowerCase();if(String(r.change_area)!=='Реклама'||!lower.includes('ставк'))continue;const id=Number(String(r.sku||'').replace('ADV-','')),nm=(String(r.object_name||'').match(/\d{5,}/)||[])[0]||'',place=lower.includes('поиск')?'search':lower.includes('рекоменд')?'recommendations':'';if(!id)continue;change.run(cleanDate(r.datetime),id,nm,place,r.old_value||'',r.new_value||'');changeCount++}
  db.exec('COMMIT');
  console.log(JSON.stringify({ok:true,current:currentCount,history:historyCount,changes:changeCount}));
}catch(error){db.exec('ROLLBACK');console.error(error);process.exitCode=1}finally{db.close()}
