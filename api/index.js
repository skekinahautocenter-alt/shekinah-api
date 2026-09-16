const { Pool } = require('pg');
const { createApp } = require('../lib/app');
require('dotenv').config();

if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL no servidor.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
const app = createApp({ pool, adminPassword: process.env.ADMIN_PASSWORD, sessionSecret: process.env.ADMIN_SESSION_SECRET, trustProxy: process.env.VERCEL ? 1 : false });
module.exports = app;
if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('API Shekinah iniciada.'));
}
