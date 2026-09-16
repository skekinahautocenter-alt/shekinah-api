const { Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config();
async function migrate() {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('Configure DATABASE_URL_UNPOOLED para a migração.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try { await pool.query(await fs.readFile(path.join(__dirname, '../migrations/001_site_banner.sql'), 'utf8')); console.log('Migração de banner concluída.'); }
  finally { await pool.end(); }
}
migrate().catch(() => { console.error('Falha na migração. Confira a conexão e as permissões do banco.'); process.exitCode = 1; });
