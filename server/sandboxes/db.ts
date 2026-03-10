import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATH } from '../config';

const dbDir = path.dirname(DATABASE_PATH);
fs.mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(DATABASE_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
`);
