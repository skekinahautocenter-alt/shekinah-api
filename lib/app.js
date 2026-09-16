const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const registerProducts = require('./products');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;

function createApp({ pool, adminPassword, sessionSecret, trustProxy = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(cors({ methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  // Apply the larger parser only after authentication on the upload route.
  const json = express.json({ limit: '100kb' });
  const authReady = typeof adminPassword === 'string' && adminPassword.length >= 16 && typeof sessionSecret === 'string' && sessionSecret.length >= 32;
  const digest = value => crypto.createHash('sha256').update(value).digest();

  function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!authReady) return res.status(503).json({ error: 'Acesso administrativo ainda não configurado no servidor.' });
    const token = /^Bearer (.+)$/.exec(req.get('Authorization') || '')?.[1];
    try {
      const claims = jwt.verify(token, sessionSecret, { algorithms: ['HS256'], issuer: 'shekinah-api', audience: 'shekinah-adm', subject: 'admin' });
      if (!claims.exp) throw new Error('Missing expiration');
      next();
    } catch {
      return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
    }
  }

  app.post('/api/admin/login', json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authReady) return res.status(503).json({ error: 'Acesso administrativo ainda não configurado no servidor.' });
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const bucket = `${digest(req.ip || 'unknown').toString('hex')}:${Math.floor(now / windowMs)}`;
    try {
      // Stored in Postgres so limits are shared across serverless instances.
      await pool.query('DELETE FROM admin_login_limits WHERE expires_at < $1', [new Date(now)]);
      const result = await pool.query(`INSERT INTO admin_login_limits (bucket, attempts, expires_at) VALUES ($1, 1, $2)
        ON CONFLICT (bucket) DO UPDATE SET attempts = admin_login_limits.attempts + 1 RETURNING attempts`, [bucket, new Date((Math.floor(now / windowMs) + 1) * windowMs)]);
      if (result.rows[0].attempts > 10) {
        res.set('Retry-After', String(Math.ceil((windowMs - now % windowMs) / 1000)));
        return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
      }
      const password = req.body?.password;
      if (typeof password !== 'string' || password.length > 1024 || !crypto.timingSafeEqual(digest(password), digest(adminPassword))) {
        return res.status(401).json({ error: 'Senha incorreta.' });
      }
      const token = jwt.sign({}, sessionSecret, { algorithm: 'HS256', expiresIn: SESSION_SECONDS, issuer: 'shekinah-api', audience: 'shekinah-adm', subject: 'admin' });
      return res.json({ token, expiresAt: jwt.decode(token).exp * 1000 });
    } catch {
      return res.status(503).json({ error: 'Não foi possível iniciar a sessão. Tente novamente.' });
    }
  });
  app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true }));

  const describe = row => row ? {
    imageUrl: `/api/banner/image?v=${encodeURIComponent(row.version)}`,
    altText: row.alt_text,
    width: 1080,
    height: 1080,
    updatedAt: row.updated_at
  } : null;
  app.get('/api/banner', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await pool.query('SELECT alt_text, version, updated_at FROM site_banner WHERE id = 1');
      res.json({ banner: describe(result.rows[0]) });
    } catch {
      res.status(503).json({ error: 'Não foi possível carregar o banner.' });
    }
  });
  app.get('/api/banner/image', async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    try {
      const result = await pool.query('SELECT image, version FROM site_banner WHERE id = 1');
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: 'Banner não cadastrado.' });
      res.type('image/webp').set('ETag', `"${row.version}"`).send(row.image);
    } catch {
      res.status(503).json({ error: 'Não foi possível carregar a imagem.' });
    }
  });

  app.put('/api/banner', requireAdmin, express.json({ limit: '3mb' }), async (req, res) => {
    const { imageData, altText } = req.body || {};
    if (typeof altText !== 'string' || !altText.trim() || altText.trim().length > 180) {
      return res.status(400).json({ error: 'Descreva o banner em até 180 caracteres.' });
    }
    if (typeof imageData !== 'string' || imageData.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) {
      return res.status(400).json({ error: 'Envie uma imagem PNG, JPG ou WebP de até 2 MB.' });
    }
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageData);
    if (!match) return res.status(400).json({ error: 'Formato inválido. Use PNG, JPG ou WebP.' });
    const source = Buffer.from(match[2], 'base64');
    if (!source.length || source.length > MAX_IMAGE_BYTES || source.toString('base64') !== match[2]) {
      return res.status(400).json({ error: 'Imagem inválida ou maior que 2 MB.' });
    }
    let image;
    try {
      const input = sharp(source, { limitInputPixels: 1080 * 1080, failOn: 'warning' });
      const metadata = await input.metadata();
      if (metadata.format !== match[1] || (metadata.pages || 1) !== 1 || metadata.width !== 1080 || metadata.height !== 1080) {
        return res.status(400).json({ error: 'A arte deve ser uma imagem estática de exatamente 1080 × 1080 pixels.' });
      }
      // Fully decode and re-encode: reject corrupt files and discard embedded metadata.
      image = await input.rotate().webp({ quality: 90 }).toBuffer();
    } catch {
      return res.status(400).json({ error: 'Não foi possível ler a arte. Use uma imagem válida de 1080 × 1080 pixels.' });
    }
    try {
      const result = await pool.query(`INSERT INTO site_banner (id, image, alt_text, version) VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET image = EXCLUDED.image, alt_text = EXCLUDED.alt_text, version = EXCLUDED.version, updated_at = CURRENT_TIMESTAMP
        RETURNING alt_text, version, updated_at`, [image, altText.trim(), crypto.randomUUID()]);
      res.json({ banner: describe(result.rows[0]) });
    } catch {
      res.status(503).json({ error: 'Não foi possível salvar. O banner anterior foi mantido.' });
    }
  });
  app.delete('/api/banner', requireAdmin, async (req, res) => {
    try {
      await pool.query('DELETE FROM site_banner WHERE id = 1');
      res.json({ banner: null });
    } catch {
      res.status(503).json({ error: 'Não foi possível restaurar o banner padrão.' });
    }
  });

  // Product reads stay public; writes now use the same server-side session as banner uploads.
  app.use(json);
  registerProducts(app, pool, requireAdmin);
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo muito grande. O limite é 2 MB por imagem.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
    res.status(500).json({ error: 'Não foi possível concluir a solicitação.' });
  });
  return app;
}
module.exports = { createApp, MAX_IMAGE_BYTES };
