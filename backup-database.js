import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Usage: node backup-database.js SOURCE TARGET');

const source = resolve(sourceArg);
const target = resolve(targetArg);
if (source === target) throw new Error('Source and target must be different files');
if (!existsSync(source)) throw new Error(`Database not found: ${source}`);
if (existsSync(target)) unlinkSync(target);

const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const backup = new DatabaseSync(target);
let integrity;
let tables;
try {
  integrity = backup.prepare('PRAGMA integrity_check').all();
  tables = backup.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
} finally {
  backup.close();
}

if (integrity.length !== 1 || String(integrity[0].integrity_check).toLowerCase() !== 'ok') {
  throw new Error('Backup integrity check failed');
}
const required = ['settings', 'legal_entities', 'campaigns', 'rules', 'operations', 'user_access_policies'];
const missing = required.filter(name => !tables.includes(name));
if (missing.length) throw new Error(`Backup is missing tables: ${missing.join(', ')}`);

console.log(JSON.stringify({ ok: true, file: target, bytes: statSync(target).size, tables: tables.length }));
