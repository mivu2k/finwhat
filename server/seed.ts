// Demo data. Safe to re-run: skips if demo users exist. All passwords: password123
try { process.loadEnvFile(); } catch { /* env from host */ }
const { openDb, hashPassword, createWorkspace, createChannel, addChannelMember, createThread, transition } = await import('./app.ts');

const pool = await openDb();
const [existing] = await pool.query<any[]>('SELECT 1 FROM users WHERE email = "head@demo.com"');
if (existing.length) { console.log('Seed already applied.'); process.exit(0); }

const users = { head: 'Hamza (Head)', acct: 'Ayesha (Accounts)', ali: 'Ali', sara: 'Sara (Viewer)' };
const id: Record<string, string> = {};
for (const [k, name] of Object.entries(users)) {
  id[k] = crypto.randomUUID();
  await pool.query('INSERT INTO users (id, email, password_hash, full_name) VALUES (?,?,?,?)', [id[k], `${k}@demo.com`, hashPassword('password123'), name]);
}

const ws = await createWorkspace(pool, id.head, 'Demo Traders');
const ch = await createChannel(pool, id.head, ws, 'Channel A');
await addChannelMember(pool, id.head, ch, 'acct@demo.com', 'approver');
await addChannelMember(pool, id.head, ch, 'ali@demo.com', 'member');
await addChannelMember(pool, id.head, ch, 'sara@demo.com', 'viewer');
const [cats] = await pool.query<any[]>('SELECT id, name FROM categories WHERE workspace_id = ?', [ws]);
const cat = (n: string) => cats.find(c => c.name === n).id;

const t1 = await createThread(pool, id.ali, ch, { title: 'Fuel for site visit', amount: 4500, currency: 'PKR', vendor: 'PSO Gulberg',
  category_id: cat('Fuel'), payment_method: 'cash', notes: 'Lahore → Kasur', expense_date: new Date().toISOString().slice(0, 10) });
await pool.query('INSERT INTO thread_messages (id, thread_id, author_id, body) VALUES (UUID(), ?, ?, ?)', [t1, id.ali, 'Receipt attached later']);
await transition(pool, id.ali, t1, 'submitted');
await transition(pool, id.acct, t1, 'approved', 'Looks fine');
await transition(pool, id.acct, t1, 'paid');

const t2 = await createThread(pool, id.ali, ch, { title: 'Train tickets', amount: 3200, currency: 'PKR', vendor: 'Pakistan Railways', category_id: cat('Travel') });
await transition(pool, id.ali, t2, 'submitted');
await createThread(pool, id.ali, ch, { title: 'Team lunch', amount: 6800, currency: 'PKR', vendor: 'Café Aylanto' });

console.log('Seeded. Logins: head@ / acct@ / ali@ / sara@demo.com, password123');
await pool.end();
