try { process.loadEnvFile(); } catch { /* env may come from the host instead */ }
const { openDb, createApp } = await import('./app.ts');

const pool = await openDb();
const port = Number(process.env.PORT ?? 4000);
createApp(pool).listen(port, () => console.log(`ExpenseChat API on http://localhost:${port}`));

// recurring expenses and reminders, even when nobody has the app open
const { runDaily } = await import('./core.ts');
const daily = () => runDaily(pool).catch(e => console.error('daily job', e));
daily();
setInterval(daily, 60 * 60e3);
