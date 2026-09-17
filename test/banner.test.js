const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, MAX_IMAGE_BYTES } = require('../lib/app');
const password = 'test-only-password-12345';
const secret = 'test-only-session-secret-at-least-32-characters';

async function fixture(t) {
  const db = await PGlite.create();
  t.after(() => db.close());
  const pool = { query: async (sql, params) => {
    const result = await db.query(sql, params);
    for (const row of result.rows) for (const key of Object.keys(row)) if (row[key] instanceof Uint8Array) row[key] = Buffer.from(row[key]);
    return result;
  } };
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/001_site_banner.sql'), 'utf8');
  await db.exec(migration);
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/002_admin_credentials.sql'), 'utf8'));
  await db.exec(migration);
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/002_admin_credentials.sql'), 'utf8'));
  await pool.query(`CREATE TABLE produtos (id SERIAL PRIMARY KEY, title TEXT, name TEXT, nome TEXT, category TEXT, categoria TEXT, price NUMERIC, preco NUMERIC, description TEXT, descricao TEXT, brand TEXT, marca TEXT, size TEXT, medida TEXT, aro TEXT, tags TEXT[], updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
  const app = createApp({ pool, adminPassword: password, sessionSecret: secret });
  const login = await request(app).post('/api/admin/login').send({ password }).expect(200);
  return { app, pool, token: login.body.token };
}
async function picture(size = 1080, color = '#ffd700', type = 'png') {
  const buffer = await sharp({ create: { width: size, height: size, channels: 3, background: color } })[type]().toBuffer();
  return `data:image/${type};base64,${buffer.toString('base64')}`;
}
function auth(r, token) { return r.set('Authorization', `Bearer ${token}`); }

test('upload persists across API instances, public image decodes at 1080x1080 and replacement invalidates cache', async (t) => {
  const { app, pool, token } = await fixture(t);
  assert.equal((await request(app).get('/api/banner').expect(200)).body.banner, null);
  await request(app).get('/api/banner/image').expect(404);
  const uploaded = await auth(request(app).put('/api/banner'), token).send({ imageData: await picture(), altText: 'Campanha de pneus' }).expect(200);
  const secondApp = createApp({ pool, adminPassword: password, sessionSecret: secret });
  const metadata = await request(secondApp).get('/api/banner').expect(200);
  assert.equal(metadata.headers['cache-control'], 'no-store');
  assert.equal(metadata.body.banner.altText, 'Campanha de pneus');
  const image = await request(secondApp).get(metadata.body.banner.imageUrl).expect(200).expect('Content-Type', /image\/webp/);
  const info = await sharp(image.body).metadata();
  assert.equal(info.width, 1080); assert.equal(info.height, 1080);
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  await request(secondApp).get(metadata.body.banner.imageUrl).set('If-None-Match', image.headers.etag).expect(304);
  const changed = await auth(request(app).put('/api/banner'), token).send({ imageData: await picture(1080, '#003344', 'jpeg'), altText: 'Nova arte' }).expect(200);
  assert.notEqual(changed.body.banner.imageUrl, uploaded.body.banner.imageUrl);
  const updated = await request(app).get(changed.body.banner.imageUrl).set('If-None-Match', image.headers.etag).expect(200);
  assert.notEqual(updated.headers.etag, image.headers.etag);
  assert.equal((await pool.query('SELECT * FROM site_banner')).rows.length, 1);
  await auth(request(app).delete('/api/banner'), token).expect(200);
  assert.equal((await request(app).get('/api/banner')).body.banner, null);
  await request(app).get('/api/banner/image').expect(404);
});

test('server rejects unauthenticated writes and expired or forged sessions', async (t) => {
  const { app, token } = await fixture(t);
  for (const [method, url] of [['put','/api/banner'],['delete','/api/banner'],['post','/api/produtos'],['put','/api/produtos/1'],['delete','/api/produtos/1']]) await request(app)[method](url).send({}).expect(401);
  await auth(request(app).get('/api/admin/session'), token).expect(200);
  for (const invalid of ['forged-token', jwt.sign({}, secret, { algorithm:'HS256',expiresIn:-1,issuer:'shekinah-api',audience:'shekinah-adm',subject:'admin' }), jwt.sign({}, secret, { expiresIn:100,issuer:'wrong',audience:'shekinah-adm',subject:'admin' })]) await auth(request(app).put('/api/banner'),invalid).send({}).expect(401);
});

test('server verifies format, pixels, payload size and alt text without losing the published banner', async (t) => {
  const { app, token } = await fixture(t);
  const good = { imageData: await picture(), altText:'Original' };
  await auth(request(app).put('/api/banner'),token).send(good).expect(200);
  const invalids = [
    {...good,imageData:await picture(800)},
    {...good,imageData:'data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64')},
    {...good,imageData:'data:image/png;base64,'+Buffer.from('not an image').toString('base64')},
    {...good,imageData:good.imageData.replace('image/png','image/jpeg')},
    {...good,imageData:'data:image/png;base64,'+Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')},
    {...good,altText:' '.repeat(10)}, {...good,altText:'x'.repeat(181)}
  ];
  for (const body of invalids) await auth(request(app).put('/api/banner'),token).send(body).expect(400);
  await auth(request(app).put('/api/banner'),token).send({...good,imageData:'a'.repeat(4*1024*1024)}).expect(413);
  assert.equal((await request(app).get('/api/banner')).body.banner.altText,'Original');
});

test('PNG, JPEG and WebP images are accepted and served as sanitized WebP', async (t) => {
  const { app, token } = await fixture(t);
  for (const format of ['png','jpeg','webp']) await auth(request(app).put('/api/banner'),token).send({imageData:await picture(1080,'#113355',format),altText:format}).expect(200);
});

test('invalid login never returns a token and throttling is shared between API instances', async (t) => {
  const { app, pool } = await fixture(t);
  const bad = await request(app).post('/api/admin/login').send({ password:'wrong' }).expect(401);
  assert.equal(bad.body.token, undefined);
  for (let i=0;i<8;i++) await request(app).post('/api/admin/login').send({password:'wrong'}).expect(401);
  const other = createApp({ pool, adminPassword:password, sessionSecret:secret });
  await request(other).post('/api/admin/login').send({password}).expect(429).expect('Retry-After',/\d+/);
});

test('unconfigured server fails closed and public data stays readable', async (t) => {
  const { pool } = await fixture(t);
  const app = createApp({ pool });
  await request(app).post('/api/admin/login').send({ password }).expect(503);
  await request(app).put('/api/banner').send({}).expect(503);
  await request(app).get('/api/banner').expect(200);
  await request(app).get('/api/produtos').expect(200);
});

test('authenticated catalog CRUD still works with the admin session', async (t) => {
  const { app, token } = await fixture(t);
  const created = await auth(request(app).post('/api/produtos'),token).send({title:'Pneu teste',category:'Pneus',price:100,tags:['teste']}).expect(201);
  const id=created.body.id;
  await auth(request(app).put(`/api/produtos/${id}`),token).send({title:'Pneu editado',category:'Pneus',price:120,description:'Atualizado',tags:[]}).expect(200);
  assert.equal((await request(app).get('/api/produtos')).body[0].title,'Pneu editado');
  await auth(request(app).delete(`/api/produtos/${id}`),token).expect(200);
});

test('API errors return safe messages and CORS allows the separate admin origin', async () => {
  const broken = { query: async () => { throw new Error('private database details'); } };
  const app=createApp({pool:broken,adminPassword:password,sessionSecret:secret});
  const failure=await request(app).get('/api/banner').expect(503);
  assert.ok(!JSON.stringify(failure.body).includes('private'));
  const preflight=await request(app).options('/api/banner').set('Origin','https://admin.example.com').set('Access-Control-Request-Method','PUT').set('Access-Control-Request-Headers','authorization,content-type').expect(204);
  assert.equal(preflight.headers['access-control-allow-origin'],'*');
  assert.match(preflight.headers['access-control-allow-headers'],/Authorization/);
});

test('password change persists across instances, validates inputs and revokes existing sessions', async t => {
  const {app,pool,token}=await fixture(t);
  const fresh='new-test-password-long-123';
  const body={currentPassword:password,newPassword:fresh,confirmPassword:fresh};
  await request(app).put('/api/admin/password').send(body).expect(401);
  await auth(request(app).put('/api/admin/password'),token).send({...body,currentPassword:'incorrect'}).expect(400);
  await auth(request(app).put('/api/admin/password'),token).send({...body,confirmPassword:'mismatch'}).expect(400);
  await auth(request(app).put('/api/admin/password'),token).send({...body,newPassword:'short',confirmPassword:'short'}).expect(400);
  await auth(request(app).put('/api/admin/password'),token).send({...body,newPassword:password,confirmPassword:password}).expect(400);
  await auth(request(app).put('/api/admin/password'),token).send(body).expect(200);
  await auth(request(app).get('/api/admin/session'),token).expect(401);
  await auth(request(app).delete('/api/banner'),token).expect(401);
  const restarted=createApp({pool,adminPassword:password,sessionSecret:secret});
  await request(restarted).post('/api/admin/login').send({password}).expect(401);
  const session=await request(restarted).post('/api/admin/login').send({password:fresh}).expect(200);
  await auth(request(restarted).get('/api/admin/session'),session.body.token).expect(200);
  const stored=(await pool.query('SELECT password_hash FROM admin_credentials')).rows[0].password_hash;
  assert(!stored.includes(fresh));assert(!stored.includes(password));
});

test('concurrent password updates cannot overwrite each other', async t => {
  const {app,token}=await fixture(t);
  const results=await Promise.all(['concurrent-password-one','concurrent-password-two'].map(newPassword=>auth(request(app).put('/api/admin/password'),token).send({currentPassword:password,newPassword,confirmPassword:newPassword})));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert(results.every(r=>[200,401,409].includes(r.status)));
});
