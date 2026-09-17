const { Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config();
async function migrate() {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('Configure DATABASE_URL_UNPOOLED para a migração.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try {
    const directory = path.join(__dirname, '../migrations');
    for (const file of (await fs.readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      await pool.query(await fs.readFile(path.join(directory, file), 'utf8'));
    }
    console.log('Migrações concluídas.');
  } finally { await pool.end(); }
}
migrate().catch(() => { console.error('Falha na migração. Confira a conexão e as permissões do banco.'); process.exitCode = 1; });
