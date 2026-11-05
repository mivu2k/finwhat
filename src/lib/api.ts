import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Role, Status } from './workflow';
import { localRequest, localUpload } from './localBridge';

/** Server address: build-time default, overridable on the login screen (saved on the device) so a test APK can follow the server. */
export const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
export let API_URL = DEFAULT_API_URL;
const URL_KEY = 'expensechat.apiUrl';
export const setApiUrl = async (url: string) => {
  API_URL = url.trim().replace(/\/+$/, '') || DEFAULT_API_URL;
  await AsyncStorage.setItem(URL_KEY, API_URL);
};
/** True when the server answers at all (any HTTP status), within 5 s. */
export const pingApi = async (url = API_URL) => {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
  try { await fetch(url.replace(/\/+$/, '') + '/me', { signal: ctl.signal }); return true; } catch { return false; } finally { clearTimeout(timer); }
};
/** 'server': talk to the API over the network. 'local': everything runs on this phone (src/lib/local.ts). */
export type Mode = 'server' | 'local';
export let MODE: Mode = 'server';
const MODE_KEY = 'expensechat.mode';
export const LOCAL_TOKEN = 'local';
export const setMode = async (m: Mode) => { MODE = m; await AsyncStorage.setItem(MODE_KEY, m); };
const KEY = 'expensechat.token';
const OUTBOX = 'expensechat.outbox';

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const loadToken = async () => {
  API_URL = (await AsyncStorage.getItem(URL_KEY)) || DEFAULT_API_URL;
  MODE = ((await AsyncStorage.getItem(MODE_KEY)) as Mode) || 'server';
  return (token = await AsyncStorage.getItem(KEY));
};
export const setToken = async (t: string | null) => {
  token = t;
  if (t) await AsyncStorage.setItem(KEY, t); else { await AsyncStorage.removeItem(KEY); await AsyncStorage.removeItem(OUTBOX); }
};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

/** Client-side ids make offline creates idempotent: a retried create is a no-op on the server. */
export const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

export class OfflineError extends Error { constructor() { super('offline'); } }
class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

async function raw(method: string, path: string, body?: unknown) {
  if (MODE === 'local') {
    try { return await localRequest(method, path, body); }
    catch (e: any) { throw new HttpError(e?.status ?? 500, e?.message ?? String(e)); }
  }
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new OfflineError(); }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && token) { await setToken(null); onUnauthorized(); }
  if (!res.ok) throw new HttpError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** GETs are cached so the app can be browsed offline; writes throw OfflineError when there is no network. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== 'GET') return raw(method, path, body);
  try {
    const data = await raw(method, path);
    AsyncStorage.setItem(`cache:${path}`, JSON.stringify(data)).catch(() => {});
    return data;
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    const cached = await AsyncStorage.getItem(`cache:${path}`);
    if (cached) return JSON.parse(cached);
    throw e;
  }
}

// ───── offline outbox: creates (threads, comments, uploads) queued in order and replayed ─────
type Job =
  | { kind: 'req'; method: string; path: string; body?: unknown }
  | { kind: 'upload'; threadId: string; uri: string; name: string; mime: string; clientId: string };

async function readOutbox(): Promise<Job[]> { return JSON.parse((await AsyncStorage.getItem(OUTBOX)) ?? '[]'); }
async function writeOutbox(jobs: Job[]) { await AsyncStorage.setItem(OUTBOX, JSON.stringify(jobs)); outboxListeners.forEach(f => f(jobs.length)); }
const outboxListeners = new Set<(n: number) => void>();
export const onOutboxChange = (f: (n: number) => void) => { outboxListeners.add(f); readOutbox().then(j => f(j.length)); return () => { outboxListeners.delete(f); }; };

/** Run a create now; if offline, queue it and resolve with { queued: true }. */
export async function send(method: string, path: string, body?: unknown): Promise<{ queued: boolean; data?: any }> {
  if ((await readOutbox()).length) { await writeOutbox([...(await readOutbox()), { kind: 'req', method, path, body }]); flushOutbox(); return { queued: true }; }
  try { return { queued: false, data: await raw(method, path, body) }; }
  catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    await writeOutbox([...(await readOutbox()), { kind: 'req', method, path, body }]);
    return { queued: true };
  }
}

export async function uploadFile(threadId: string, uri: string, name: string, mime: string): Promise<{ queued: boolean; transcript?: string | null }> {
  const job: Job = { kind: 'upload', threadId, uri, name, mime, clientId: uuid() };
  if ((await readOutbox()).length) { await writeOutbox([...(await readOutbox()), job]); flushOutbox(); return { queued: true }; }
  try { return { queued: false, ...(await doUpload(job)) }; }
  catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    await writeOutbox([...(await readOutbox()), job]);
    return { queued: true };
  }
}

async function doUpload(j: Extract<Job, { kind: 'upload' }>) {
  if (MODE === 'local') return localUpload(j.threadId, j.uri, j.name, j.mime, j.clientId);
  // ponytail: on web, blob: URIs die on reload, so web offline uploads only survive within the session.
  const blob = await (await fetch(j.uri)).blob();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/threads/${j.threadId}/attachments?name=${encodeURIComponent(j.name)}&client_id=${j.clientId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': j.mime }, body: blob,
    });
  } catch { throw new OfflineError(); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status, data?.error ?? 'Upload failed');
  return data;
}

let flushing = false;
export const failedJobs: string[] = [];
export async function flushOutbox() {
  if (flushing || !token) return;
  flushing = true;
  try {
    let jobs = await readOutbox();
    while (jobs.length) {
      const j = jobs[0];
      try { j.kind === 'req' ? await raw(j.method, j.path, j.body) : await doUpload(j); }
      catch (e) {
        if (e instanceof OfflineError) break;            // still offline: keep order, retry later
        failedJobs.push(`${j.kind === 'req' ? j.path : j.name}: ${(e as Error).message}`); // server rejected: drop, report
      }
      jobs = jobs.slice(1);
      await writeOutbox(jobs);
    }
  } finally { flushing = false; }
}

// ───── types ─────
export type User = { id: string; email: string; full_name: string | null; default_currency: string; language: 'en' | 'ur' };
export type Payment = { id: string; amount: number; method: string; reference: string | null; paid_on: string; recorded_by: string };
export type Field = { value: string | number | null; confidence: number };
export type Thread = {
  id: string; channel_id: string; created_by: string; status: Status; source_type: 'form' | 'voice' | 'photo';
  title: string | null; amount: number | null; currency: string; fx_rate: number | null; category_id: string | null;
  vendor: string | null; expense_date: string | null; payment_method: string | null; tag: string | null; notes: string | null;
  due_date: string | null; created_at: string; updated_at: string;
  author: { full_name: string | null } | null; category: { name: string } | null; channel?: { name: string };
  reply_count?: number; last_activity?: string | null;
  line_items?: LineItem[] | null;
  kind?: 'expense' | 'advance'; assigned_to?: string | null; holder?: { full_name: string | null } | null; accounted?: number;
  settlements?: Settlement[]; balance?: { issued: number; spent: number; returned: number; reimbursed: number; pending: number; outstanding: number } | null;
  // channel feed only
  preview?: { type: 'image' | 'voice' | 'file'; mime: string; url: string } | null; transcript?: string | null;
  last_reply?: { body: string; author: string; at: string } | null;
  // detail only
  payments?: Payment[]; paid_total?: number; base_currency?: string;
  approvals?: { role: string; full_name: string; created_at: string }[];
  extraction?: { fields: Record<string, Field> } | null;
};
export type Settlement = { id: string; kind: 'expense' | 'returned' | 'reimbursed'; review_status: 'pending' | 'accepted' | 'rejected'; review_note: string | null; created_by: string; description: string; amount: number; spent_on: string; by_name: string; attachment_id: string | null; attachment: { url: string; mime: string } | null };
export type LineItem = { description: string; qty: number; amount: number; category_id?: string | null; category_name?: string | null }; // amount = unit price
export type Message = {
  id: string; author_id: string | null; type: 'text' | 'system' | 'image' | 'voice' | 'file'; body: string | null; created_at: string; attachment_id?: string | null;
  author: { full_name: string | null } | null; attachment: { url: string; mime: string } | null;
  reply: { body: string; author: string | null } | null; reactions: Record<string, string[]> | null;
};
export type Channel = {
  my_scope?: 'all' | 'own' | 'selected';
  parent_id?: string | null; subchannels?: { id: string; name: string }[];
  id: string; workspace_id: string; name: string; approval_required: boolean; owner_approval_limit: number | null; receipt_required_above: number | null; block_new_advance: boolean;
  base_currency: string; my_role: Role; ai: { transcribe: boolean; extract: boolean };
};
export type Member = { user_id: string; role: Role; monthly_limit?: number | null; record_scope?: 'all' | 'own' | 'selected'; profile: { full_name: string | null; email: string | null } };

export const errMsg = (e: unknown) => (e instanceof OfflineError ? 'You are offline' : (e as Error)?.message ?? String(e));
