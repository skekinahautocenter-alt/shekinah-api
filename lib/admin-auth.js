const crypto = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function matches(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, hash] = encoded.split(':');
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
module.exports = function registerAdmin({ app, pool, adminPassword, sessionSecret, json }) {
  const configured = typeof sessionSecret === 'string' && sessionSecret.length >= 32;
  async function credentials() {
    let result = await pool.query('SELECT password_hash, version FROM admin_credentials WHERE id = 1');
    if (!result.rows[0]) {
      if (typeof adminPassword !== 'string' || adminPassword.length < 16 || adminPassword.length > 256) throw new Error('Missing bootstrap password');
      await pool.query('INSERT INTO admin_credentials (id, password_hash) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [await hashPassword(adminPassword)]);
      result = await pool.query('SELECT password_hash, version FROM admin_credentials WHERE id = 1');
    }
    return result.rows[0];
  }
  async function limited(req, res, scope) {
    const windowMs = 15 * 60 * 1000;
    const now = Date.now();
    const ip = crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex');
    const bucket = `${scope}:${ip.slice(0, 50)}:${Math.floor(now / windowMs)}`;
    await pool.query('DELETE FROM admin_login_limits WHERE expires_at < $1', [new Date(now)]);
    const result = await pool.query(`INSERT INTO admin_login_limits (bucket, attempts, expires_at) VALUES ($1, 1, $2)
      ON CONFLICT (bucket) DO UPDATE SET attempts = admin_login_limits.attempts + 1 RETURNING attempts`, [bucket, new Date((Math.floor(now / windowMs) + 1) * windowMs)]);
    if (result.rows[0].attempts <= 10) return false;
    res.set('Retry-After', String(Math.ceil((windowMs - now % windowMs) / 1000)));
    res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    return true;
  }
  async function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!configured) return res.status(503).json({ error: 'Acesso administrativo ainda não configurado no servidor.' });
    let claims;
    try {
      claims = jwt.verify(/^Bearer (.+)$/.exec(req.get('Authorization') || '')?.[1], sessionSecret, { algorithms: ['HS256'], issuer: 'shekinah-api', audience: 'shekinah-adm', subject: 'admin' });
      if (!claims.exp) throw new Error('Missing expiration');
    } catch { return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' }); }
    try {
      const current = await credentials();
      if ((claims.version ?? 0) !== current.version) return res.status(401).json({ error: 'Sua senha foi alterada. Entre novamente.' });
      req.adminCredential = current;
      next();
    } catch { res.status(503).json({ error: 'Não foi possível verificar a sessão. Tente novamente.' }); }
  }
  app.post('/api/admin/login', json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!configured) return res.status(503).json({ error: 'Acesso administrativo ainda não configurado no servidor.' });
    try {
      if (await limited(req, res, 'login')) return;
      const current = await credentials();
      if (!await matches(req.body?.password, current.password_hash)) return res.status(401).json({ error: 'Senha incorreta.' });
      const token = jwt.sign({ version: current.version }, sessionSecret, { algorithm: 'HS256', expiresIn: 8 * 60 * 60, issuer: 'shekinah-api', audience: 'shekinah-adm', subject: 'admin' });
      res.json({ token, expiresAt: jwt.decode(token).exp * 1000 });
    } catch { res.status(503).json({ error: 'Não foi possível iniciar a sessão. Tente novamente.' }); }
  });
  app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true }));
  app.put('/api/admin/password', requireAdmin, json, async (req, res) => {
    try {
      if (await limited(req, res, 'password')) return;
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (typeof newPassword !== 'string' || newPassword.length < 16 || newPassword.length > 256 || !newPassword.trim()) return res.status(400).json({ error: 'Use uma nova senha com 16 a 256 caracteres.' });
      if (newPassword !== confirmPassword) return res.status(400).json({ error: 'A confirmação não corresponde à nova senha.' });
      if (newPassword === currentPassword) return res.status(400).json({ error: 'Escolha uma senha diferente da atual.' });
      if (!await matches(currentPassword, req.adminCredential.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta.' });
      const result = await pool.query('UPDATE admin_credentials SET password_hash = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 AND version = $2 RETURNING version', [await hashPassword(newPassword), req.adminCredential.version]);
      if (!result.rowCount && !result.rows.length) return res.status(409).json({ error: 'A senha já foi alterada em outra sessão. Entre novamente.' });
      res.json({ changed: true });
    } catch { res.status(503).json({ error: 'Não foi possível alterar a senha. Tente novamente.' }); }
  });
  return { requireAdmin };
};
