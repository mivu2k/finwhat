// ExpenseChat API: Express + MySQL. Every permission check lives here, MySQL has no RLS.
import express, { type NextFunction, type Request, type Response } from 'express';
import mysql, { type Pool } from 'mysql2/promise';
import { createHmac, randomBytes, scryptSync, timingSafeEqual, randomUUID, createHash, randomInt, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { envAiConfig, testExtract, transcribe, extract, type AiConfig } from './ai.ts';
import { exportRoutes } from './export.ts';
import { SCHEMA, MIGRATIONS } from './schema.ts';
import { canEditFields, canComment } from '../src/lib/workflow.ts';
import { HttpError, fail, rows, one, channelRole, systemMessage, coreRoutes, recordAttachment, threadRoleOf, userOut, type Ctx } from './core.ts';
// re-exported for seed.ts and tests
export { HttpError, createWorkspace, createChannel, addChannelMember, createThread, updateThread, transition, addPayment, cleanItems } from './core.ts';

const SECRET = process.env.JWT_SECRET ?? '';
if (SECRET.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
const UPLOADS = process.env.UPLOAD_DIR ?? join(import.meta.dirname, 'uploads');
mkdirSync(UPLOADS, { recursive: true });


// ───────────── crypto helpers ─────────────
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const hmac = (s: string) => createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function signToken(sub: string, ttlSec = 60 * 60 * 24 * 30) {
  const body = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSec }))}`;
  return `${body}.${hmac(body)}`;
}
function verifyToken(token: string): string | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s || !safeEq(s, hmac(`${h}.${p}`))) return null;
  const { sub, exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
  return exp > Date.now() / 1000 ? sub : null;
}
export function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  return safeEq(scryptSync(pw, salt, 64).toString('hex'), hash);
}
// AI keys at rest: AES-256-GCM with a key derived from the server secret
const aiKeyBytes = () => createHash('sha256').update(`ai-settings:${SECRET}`).digest();
const seal = (plain: string) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', aiKeyBytes(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
};
const unseal = (sealed: string | null) => {
  if (!sealed) return null;
  const [iv, tag, data] = sealed.split('.').map(x => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', aiKeyBytes(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
};
const fileSig = (id: string, exp: number) => hmac(`file:${id}:${exp}`);
const signedFileUrl = (base: string, id: string) => {
  // same link for a whole hour (valid 1-2h), so refreshing a list doesn't make images and audio reload
  const exp = (Math.floor(Date.now() / 3600e3) + 2) * 3600;
  return `${base}/files/${id}?exp=${exp}&sig=${fileSig(id, exp)}`;
};

// ───────────── db helpers ─────────────
/** DATABASE_URL picks the backend: `sqlite:./data/expensechat.db` (one file, nothing to install) or `mysql://user:pw@host/db`. */
export async function openDb(url = process.env.DATABASE_URL ?? 'sqlite:./data/expensechat.db') {
  const schema = SCHEMA;
  if (url.startsWith('sqlite:')) {
    const file = url.slice('sqlite:'.length).replace(/^\/\//, '') || ':memory:';
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const { createSqlitePool, translateSchema } = await import('./sqlite.ts');
    const pool = createSqlitePool(file);
    const c = await pool.getConnection();
    try {
      for (const stmt of translateSchema(schema).split(/;\s*\n(?!\s*BEGIN|\s*END)/).filter(x => x.trim())) await c.query(stmt);
      for (const alter of MIGRATIONS.map(m => m.replace(/JSON NULL/, 'TEXT NULL')))
        await c.query(alter).catch((e: any) => { if (e.errno !== 1060) throw e; });
    } finally { c.release(); }
    return pool as unknown as Pool;
  }
  const c = await mysql.createConnection({ uri: url, multipleStatements: true });
  await c.query(schema);
  for (const alter of MIGRATIONS) await c.query(alter).catch((e: any) => { if (e.errno !== 1060) throw e; }); // 1060 = column exists
  await c.end();
  return mysql.createPool({ uri: url, connectionLimit: 10, dateStrings: true, decimalNumbers: true, timezone: 'Z' });
}

// ───────────── HTTP ─────────────
type AuthedReq = Request & { uid: string };

// ponytail: in-memory rate limit, per process; move to Redis when running >1 instance.
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(max: number, windowMs: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const k = `${req.ip}:${req.path}`; const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return next(new HttpError(429, 'too many attempts, try again later'));
    next();
  };
}

export function createApp(pool: Pool) {
  const app = express();
  /** The workspace's own AI settings, or .env when it has never saved any. */
  const aiConfig = async (workspaceId: string): Promise<AiConfig> => {
    const r = await one(pool, 'SELECT * FROM ai_settings WHERE workspace_id = ?', [workspaceId]);
    if (!r) return envAiConfig();
    return { extract: { provider: r.extract_provider, url: r.extract_url, model: r.extract_model, key: unseal(r.extract_key) },
      transcribe: { provider: r.transcribe_provider, url: r.transcribe_url, model: r.transcribe_model, key: unseal(r.transcribe_key) } };
  };
  const threadWorkspace = async (threadId: string) => (await one(pool, 'SELECT c.workspace_id AS w FROM threads t JOIN channels c ON c.id = t.channel_id WHERE t.id = ?', [threadId])).w as string;
  const requireAdmin = async (uid: string, wsId: string) => {
    if ((await one(pool, 'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [wsId, uid]))?.role !== 'admin') fail(403, 'only a workspace admin can change AI settings');
  };
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const json = express.json({ limit: '100kb' });
  const base = (req: Request) => process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.get('host')}`;

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    const uid = verifyToken((req.get('authorization') ?? '').replace(/^Bearer /, ''));
    if (!uid) return next(new HttpError(401, 'not signed in'));
    (req as AuthedReq).uid = uid; next();
  };
  const r = (fn: (req: AuthedReq, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => { const out = await fn(req as AuthedReq, res); if (!res.headersSent) res.json(out ?? { ok: true }); };

  // auth
  app.post('/auth/signup', rateLimit(10, 15 * 60e3), json, r(async req => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'valid email required');
    if (password.length < 8) fail(400, 'password must be at least 8 characters');
    if (await one(pool, 'SELECT 1 FROM users WHERE email = ?', [email])) fail(409, 'that email is already registered');
    const id = randomUUID();
    await pool.query('INSERT INTO users (id, email, password_hash, full_name) VALUES (?,?,?,?)',
      [id, email, hashPassword(password), String(req.body.full_name ?? '').trim() || email.split('@')[0]]);
    return { token: signToken(id), user: userOut(await one(pool, 'SELECT * FROM users WHERE id = ?', [id])) };
  }));
  app.post('/auth/login', rateLimit(20, 15 * 60e3), json, r(async req => {
    const u = await one(pool, 'SELECT * FROM users WHERE email = ?', [String(req.body.email ?? '').trim().toLowerCase()]);
    if (!u || !checkPassword(String(req.body.password ?? ''), u.password_hash)) fail(401, 'wrong email or password');
    return { token: signToken(u.id), user: userOut(u) };
  }));



  // workspaces & channels













  // threads





  // "Convert to form": AI prefill from transcripts + receipt images/PDFs. Never writes the thread itself.
  app.post('/threads/:id/extract', auth, r(async req => {
    const threadId = req.params.id as string;
    const t = await one(pool, 'SELECT * FROM threads WHERE id = ?', [threadId]);
    const role = t ? await channelRole(pool, req.uid, t.channel_id) : null;
    if (!role) fail(404, 'thread not found');
    if (!canEditFields(t.status, role, t.created_by === req.uid)) fail(403, 'this expense is locked for you');
    const ai = await aiConfig(await threadWorkspace(threadId));
    if (ai.extract.provider === 'none') fail(503, 'AI is not set up for this workspace. An admin can set it up under Channels → workspace menu → AI settings.');
    const texts = (await rows(pool, 'SELECT text FROM transcripts WHERE thread_id = ? ORDER BY created_at', [threadId])).map(r => r.text);
    const notes = (await rows(pool, 'SELECT body FROM thread_messages WHERE thread_id = ? AND type = "text" AND author_id = ? ORDER BY created_at LIMIT 10',
      [threadId, t.created_by])).map(r => `Submitter wrote: ${r.body}`);
    const files = (await rows(pool, `SELECT storage_path, mime FROM attachments WHERE thread_id = ? AND (mime LIKE 'image/%' OR mime = 'application/pdf')
      ORDER BY created_at DESC LIMIT 5`, [threadId])).map(a => ({ path: join(UPLOADS, a.storage_path), mime: a.mime }));
    if (!texts.length && !files.length && !notes.length) fail(400, 'nothing to extract from: add a voice note, photo or comment first');
    const cats = await rows(pool, 'SELECT k.id, k.name FROM categories k JOIN channels c ON c.workspace_id = k.workspace_id WHERE c.id = ?', [t.channel_id]);
    const me = await one(pool, 'SELECT default_currency FROM users WHERE id = ?', [req.uid]);
    const result = await extract(ai.extract, { texts: [...texts, ...notes], files, categories: cats.map(c => c.name),
      defaultCurrency: me.default_currency, today: new Date().toISOString().slice(0, 10) });
    await pool.query('INSERT INTO extractions (id, thread_id, fields, line_items, model, created_by) VALUES (?,?,?,?,?,?)',
      [randomUUID(), threadId, JSON.stringify(result.fields), JSON.stringify(result.line_items), process.env.EXTRACT_MODEL ?? 'claude-opus-5-5', req.uid]);
    const catName = String(result.fields.category.value ?? '').toLowerCase();
    return { ...result, category_id: cats.find(c => c.name.toLowerCase() === catName)?.id ?? null };
  }));

  // Possible duplicates: same amount + vendor + date in the channel, or a shared identical file.









  // attachments: raw body upload, served back through short-lived signed URLs
  const ALLOWED = /^(image\/(jpeg|png|webp|heic|gif)|application\/pdf|audio\/(mp4|m4a|x-m4a|mpeg|webm|wav|x-wav|aac|ogg|3gpp))$/;
  app.post('/threads/:id/attachments', auth, express.raw({ type: () => true, limit: '20mb' }), r(async req => {
    const threadId = req.params.id as string;
    const { role, channel_id, status } = await threadRoleOf(pool, req.uid, threadId);
    if (!canComment(role)) fail(403, 'viewers cannot upload');
    if (status === 'closed') fail(403, 'thread is closed');
    const mime = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED.test(mime)) fail(415, 'only images, PDFs and voice notes are allowed');
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'empty file');
    const name = String(req.query.name ?? 'file').replace(/[^\w.-]/g, '_').slice(0, 120);
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.query.client_id)) ? String(req.query.client_id).toLowerCase() : randomUUID();
    if (await one(pool, 'SELECT 1 FROM attachments WHERE id = ?', [id])) return { id, transcript: null }; // offline retry
    const rel = `${channel_id}/${threadId}/${id}-${name}`;
    mkdirSync(join(UPLOADS, channel_id, threadId), { recursive: true });
    writeFileSync(join(UPLOADS, rel), req.body);
    const sha = createHash('sha256').update(req.body).digest('hex');
    await recordAttachment(pool, req.uid, threadId, channel_id, { id, name, mime, size: req.body.length, sha256: sha, storagePath: rel });
    let transcript: string | null = null;
    const ai = mime.startsWith('audio/') ? await aiConfig(await threadWorkspace(threadId)) : null;
    if (ai && ai.transcribe.provider !== 'none') {
      try {
        const tr = await transcribe(ai.transcribe, join(UPLOADS, rel), mime, name);
        transcript = tr.text;
        await pool.query('INSERT INTO transcripts (id, thread_id, attachment_id, text, language) VALUES (?,?,?,?,?)', [randomUUID(), threadId, id, tr.text, tr.language ?? null]);
        await systemMessage(pool, threadId, `Transcript${tr.language ? ` (${tr.language})` : ''}: ${tr.text}`);
      } catch (e) {
        console.error(e);
        await systemMessage(pool, threadId, 'Transcription failed; fill the form manually or retry later.');
      }
    }
    return { id, transcript };
  }));
  // password reset: a 6-digit code by email (printed to the server log until SMTP_URL is set)
  const codeHash = (uid: string, code: string) => hmac(`reset:${uid}:${code}`);
  app.post('/auth/forgot', rateLimit(5, 15 * 60e3), json, r(async req => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const u = await one(pool, 'SELECT id FROM users WHERE email = ?', [email]);
    if (u) {
      const code = String(randomInt(100000, 1000000));
      await pool.query('INSERT INTO password_resets (user_id, code_hash, expires_at, attempts) VALUES (?,?,?,0) ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0',
        [u.id, codeHash(u.id, code), Date.now() + 15 * 60e3]);
      if (process.env.SMTP_URL) {
        const { createTransport } = await import('nodemailer');
        await createTransport(process.env.SMTP_URL).sendMail({ from: process.env.MAIL_FROM ?? 'ExpenseChat <no-reply@expensechat.app>', to: email,
          subject: 'Your ExpenseChat password reset code', text: `Your code is ${code}. It expires in 15 minutes. If you did not ask for this, ignore this email.` });
      } else console.log(`[password reset] SMTP_URL not set. Code for ${email}: ${code}`);
    }
    return { ok: true }; // same answer either way: don't reveal who has an account
  }));
  app.post('/auth/reset', rateLimit(10, 15 * 60e3), json, r(async req => {
    const u = await one(pool, 'SELECT id FROM users WHERE email = ?', [String(req.body.email ?? '').trim().toLowerCase()]);
    const row = u ? await one(pool, 'SELECT * FROM password_resets WHERE user_id = ?', [u.id]) : null;
    const good = row && Number(row.expires_at) > Date.now() && row.attempts < 5 && safeEq(row.code_hash, codeHash(u.id, String(req.body.code ?? '').trim()));
    if (row && !good) await pool.query('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?', [u.id]);
    if (!good) fail(400, 'that code is wrong or has expired');
    if (String(req.body.password ?? '').length < 8) fail(400, 'password must be at least 8 characters');
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(req.body.password)), u.id]);
    await pool.query('DELETE FROM password_resets WHERE user_id = ?', [u.id]);
    return { ok: true };
  }));
  // account deletion: financial records must survive, so the person is anonymised rather than removed
  app.delete('/me', auth, json, r(async req => {
    const u = await one(pool, 'SELECT * FROM users WHERE id = ?', [req.uid]);
    if (!checkPassword(String(req.body?.password ?? ''), u.password_hash)) fail(403, 'wrong password');
    const sole = await rows(pool, `SELECT c.name FROM channel_members m JOIN channels c ON c.id = m.channel_id WHERE m.user_id = ? AND m.role = 'owner'
      AND (SELECT COUNT(*) FROM channel_members o WHERE o.channel_id = m.channel_id AND o.role = 'owner') = 1
      AND (SELECT COUNT(*) FROM channel_members a WHERE a.channel_id = m.channel_id) > 1`, [req.uid]);
    if (sole.length) fail(400, `make someone else the owner of ${sole.map(s => s.name).join(', ')} first`);
    await pool.query('DELETE FROM channel_members WHERE user_id = ?', [req.uid]);
    await pool.query('DELETE FROM workspace_members WHERE user_id = ?', [req.uid]);
    await pool.query('DELETE FROM push_tokens WHERE user_id = ?', [req.uid]);
    await pool.query(`UPDATE users SET email = ?, full_name = 'Deleted user', password_hash = ? WHERE id = ?`, [`deleted-${req.uid}@deleted.invalid`, hashPassword(randomUUID()), req.uid]);
    return { ok: true };
  }));

  app.get('/files/:id', async (req, res) => {
    const exp = Number(req.query.exp);
    const id = req.params.id;
    if (!(exp > Date.now() / 1000) || !safeEq(String(req.query.sig ?? ''), fileSig(id, exp))) throw new HttpError(403, 'link expired');
    const a = await one(pool, 'SELECT storage_path, mime, file_name FROM attachments WHERE id = ?', [id]);
    if (!a) throw new HttpError(404, 'not found');
    res.set({ 'Content-Type': a.mime, 'Content-Disposition': `inline; filename="${a.file_name}"`, 'Cache-Control': 'private, max-age=3600' });
    res.sendFile(a.storage_path, { root: UPLOADS }); // handles Range requests: needed to seek in audio, and for playback on iOS
  });

  // notifications (in-app center; client polls the unread count)



  // dashboard: amounts in workspace base currency (ledger base_amount); pending = not yet approved


  // search + saved views over threads (title, vendor, notes, transcripts)


  // AI settings (admins). Keys go in, never out: the app only learns whether one is saved.
  app.get('/workspaces/:id/ai', auth, r(async req => {
    await requireAdmin(req.uid, req.params.id as string);
    const c = await aiConfig(req.params.id as string);
    const pub = (x: AiConfig['extract']) => ({ provider: x.provider, url: x.url ?? '', model: x.model ?? '', has_key: !!x.key });
    return { extract: pub(c.extract), transcribe: pub(c.transcribe), from_env: !(await one(pool, 'SELECT 1 AS y FROM ai_settings WHERE workspace_id = ?', [req.params.id])) };
  }));
  const cleanAi = (x: any, kinds: string[]) => {
    const provider = kinds.includes(x?.provider) ? x.provider : 'none';
    const url = String(x?.url ?? '').trim().slice(0, 300) || null, model = String(x?.model ?? '').trim().slice(0, 120) || null;
    if (url && !/^https?:\/\/\S+$/.test(url)) fail(400, 'the address must start with http:// or https://');
    if (provider === 'openai' && !url && !x?.key && !x?.has_key) fail(400, 'give the server address, or an API key for OpenAI');
    return { provider, url, model, key: String(x?.key ?? '').trim() };
  };
  /** Blank key keeps the saved one; clear_key removes it. */
  const mergeAi = async (wsId: string, body: any) => {
    const old = await aiConfig(wsId);
    const ex = cleanAi(body.extract, ['none', 'anthropic', 'openai']), tr = cleanAi(body.transcribe, ['none', 'openai']);
    return { extract: { ...ex, key: body.extract?.clear_key ? null : ex.key || old.extract.key || null }, transcribe: { ...tr, key: body.transcribe?.clear_key ? null : tr.key || old.transcribe.key || null } };
  };
  app.put('/workspaces/:id/ai', auth, json, r(async req => {
    const wsId = req.params.id as string;
    await requireAdmin(req.uid, wsId);
    const c = await mergeAi(wsId, req.body);
    await pool.query(`INSERT INTO ai_settings (workspace_id, extract_provider, extract_url, extract_model, extract_key, transcribe_provider, transcribe_url, transcribe_model, transcribe_key) VALUES (?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE extract_provider = VALUES(extract_provider), extract_url = VALUES(extract_url), extract_model = VALUES(extract_model), extract_key = VALUES(extract_key),
      transcribe_provider = VALUES(transcribe_provider), transcribe_url = VALUES(transcribe_url), transcribe_model = VALUES(transcribe_model), transcribe_key = VALUES(transcribe_key)`,
      [wsId, c.extract.provider, c.extract.url, c.extract.model, c.extract.key && seal(c.extract.key), c.transcribe.provider, c.transcribe.url, c.transcribe.model, c.transcribe.key && seal(c.transcribe.key)]);
    return { ok: true };
  }));
  app.post('/workspaces/:id/ai/test', auth, json, r(async req => {
    const wsId = req.params.id as string;
    await requireAdmin(req.uid, wsId);
    const c = await mergeAi(wsId, req.body);
    if (c.extract.provider === 'none') fail(400, 'choose an AI first');
    const started = Date.now();
    try { await testExtract(c.extract); return { ok: true, ms: Date.now() - started }; }
    catch (e) { // only a short reason: this must not become a way to read other servers' responses
      const m = (e as Error).message ?? '';
      return { ok: false, error: /answered \d+|empty reply/.test(m) ? m : /401|403|auth/i.test(m) ? 'the key was refused' : /404|model/i.test(m) ? 'that model was not found' : 'could not reach that address from the server' };
    }
  }));

  // every database-only route lives in core.ts (shared with the phone's offline mode); mount them behind auth
  for (const route of coreRoutes(pool, { ai: async w => { const c = await aiConfig(w); return { extract: c.extract.provider !== 'none', transcribe: c.transcribe.provider !== 'none' }; }, fileUrl: (ctx, id) => signedFileUrl((ctx as Ctx & { base: string }).base, id) })) {
    const handler = r(async req => route.h({ uid: req.uid, params: req.params as Record<string, string>, query: req.query as Record<string, any>,
      body: req.body, base: base(req) } as Ctx));
    app[route.m.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](route.p, auth, json, handler);
  }

  exportRoutes(app, pool, auth, json, base);

  // ledger




  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'file too large (max 20 MB)' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
