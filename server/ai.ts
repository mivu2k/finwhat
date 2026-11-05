// Speech-to-text (Whisper-compatible API) + receipt/voice field extraction (Claude, structured output).
// Both are optional: without keys the app still works, threads just stay "Draft / Needs form".
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

/** Which AI to use. Comes from the workspace's AI settings, else from .env. provider: 'none' | 'anthropic' | 'openai' (any OpenAI-compatible server, local or cloud). */
export type AiConfig = {
  extract: { provider: string; url?: string | null; model?: string | null; key?: string | null };
  transcribe: { provider: string; url?: string | null; model?: string | null; key?: string | null };
};
export const envAiConfig = (): AiConfig => ({
  extract: { provider: process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none', model: process.env.EXTRACT_MODEL, key: process.env.ANTHROPIC_API_KEY },
  transcribe: { provider: process.env.OPENAI_API_KEY ? 'openai' : 'none', url: process.env.TRANSCRIBE_URL, model: process.env.TRANSCRIBE_MODEL, key: process.env.OPENAI_API_KEY },
});
const bearer = (key?: string | null): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});
const unslash = (u: string) => u.replace(/\/+$/, '');

export async function transcribe(cfg: AiConfig['transcribe'], path: string, mime: string, fileName: string): Promise<{ text: string; language?: string }> {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)], { type: mime }), fileName);
  form.append('model', cfg.model || 'whisper-1');
  form.append('response_format', 'verbose_json'); // returns detected language (en / ur)
  form.append('prompt', 'Expense note. May be English, Urdu, or mixed. Amounts in rupees.');
  const res = await fetch(cfg.url || 'https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: bearer(cfg.key), body: form, signal: AbortSignal.timeout(300e3),
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  const j = await res.json() as { text: string; language?: string };
  return { text: j.text.trim(), language: j.language };
}

const FIELD_NAMES = ['title', 'amount', 'tax', 'currency', 'expense_date', 'vendor', 'category', 'payment_method', 'notes'] as const;
const field = (type: string | string[]) => ({
  type: 'object', additionalProperties: false, required: ['value', 'confidence'],
  properties: { value: { type: Array.isArray(type) ? type : [type, 'null'] }, confidence: { type: 'number' } },
});
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fields', 'line_items'],
  properties: {
    fields: {
      type: 'object', additionalProperties: false, required: [...FIELD_NAMES],
      properties: {
        title: field('string'), amount: field('number'), tax: field('number'), currency: field('string'),
        expense_date: field('string'), vendor: field('string'), category: field('string'),
        payment_method: field('string'), notes: field('string'),
      },
    },
    line_items: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['description', 'amount'],
        properties: { description: { type: 'string' }, amount: { type: ['number', 'null'] } } },
    },
  },
};

export type Extraction = {
  fields: Record<(typeof FIELD_NAMES)[number], { value: string | number | null; confidence: number }>;
  line_items: { description: string; amount: number | null }[];
};

/** Local models often return loose JSON: pull the object out of the reply and fill any gaps, so the form always gets the same shape. */
export function normalizeExtraction(text: string): Extraction {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('the AI did not return usable data');
  const j = JSON.parse(text.slice(start, end + 1));
  const src = j.fields ?? j;
  const fields = {} as Extraction['fields'];
  for (const k of FIELD_NAMES) {
    const v = src[k];
    fields[k] = v && typeof v === 'object' && 'value' in v ? { value: v.value ?? null, confidence: Number(v.confidence) || 0 }
      : { value: v ?? null, confidence: v == null ? 0 : 0.5 }; // no confidence given: low enough that the form flags it for checking
  }
  const items = Array.isArray(j.line_items) ? j.line_items : [];
  return { fields, line_items: items.filter((i: any) => i?.description).map((i: any) => ({ description: String(i.description), amount: i.amount == null ? null : Number(i.amount) })) };
}

/** Any OpenAI-compatible server: OpenAI, Ollama, LM Studio, vLLM, Groq... */
async function chat(cfg: AiConfig['extract'], messages: unknown[], schema?: object, timeoutMs = 300e3) {
  const post = (extra: object) => fetch(`${unslash(cfg.url || 'https://api.openai.com/v1')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(cfg.key) }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0, ...extra }),
  });
  let res = await post(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'expense', schema } } } : {});
  if (schema && res.status === 400) res = await post({}); // not every server supports schemas; the prompt still asks for JSON
  if (!res.ok) throw new Error(`the AI server answered ${res.status}`);
  const j = await res.json() as { choices?: { message?: { content?: string } }[] };
  const out = j.choices?.[0]?.message?.content;
  if (!out) throw new Error('the AI server sent an empty reply');
  return out;
}

/** A tiny request, to prove the settings work. */
export async function testExtract(cfg: AiConfig['extract']) {
  if (cfg.provider === 'openai') { await chat(cfg, [{ role: 'user', content: 'Reply with the word OK.' }], undefined, 60e3); return; }
  const client = new Anthropic({ apiKey: cfg.key ?? undefined, baseURL: cfg.url || undefined, timeout: 60e3 });
  await client.messages.create({ model: cfg.model || 'claude-opus-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'Reply with the word OK.' }] });
}

export async function extract(cfg: AiConfig['extract'], input: {
  texts: string[]; files: { path: string; mime: string }[]; categories: string[]; defaultCurrency: string; today: string;
}): Promise<Extraction> {
  const prompt = [
    'Extract one expense record from the receipt/invoice images and/or voice-note transcripts below.',
    `Today is ${input.today}. Default currency if none is stated: ${input.defaultCurrency}.`,
    `category must be one of: ${input.categories.join(', ')} (or null).`,
    'payment_method must be one of: cash, bank_transfer, card, wallet (or null).',
    'expense_date as YYYY-MM-DD; resolve relative dates ("yesterday", "kal") against today.',
    'amount is the grand total actually paid, including tax. currency is an ISO 4217 code.',
    'Urdu or Roman-Urdu input is normal; write title and notes in the input language.',
    'confidence: 0-1, how sure you are of each value. Use null + low confidence when absent; never guess silently.',
    ...input.texts.map((t, i) => `Transcript ${i + 1}:\n${t}`),
  ].join('\n');

  if (cfg.provider === 'openai') {
    // PDFs aren't part of the OpenAI-compatible format, so they're left out here; images and transcripts are sent
    const images = input.files.filter(f => f.mime.startsWith('image/'));
    if (!images.length && !input.texts.length) throw new Error('this AI can read photos and text, not PDFs: attach a photo of the receipt, or use Claude');
    const parts = [{ type: 'text', text: `${prompt}\nReply with JSON only: { "fields": { ${FIELD_NAMES.map(n => `"${n}": { "value": ..., "confidence": 0-1 }`).join(', ')} }, "line_items": [{ "description": ..., "amount": ... }] }` },
      ...images.map(f => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${readFileSync(f.path).toString('base64')}` } }))];
    return normalizeExtraction(await chat(cfg, [{ role: 'user', content: parts }], SCHEMA));
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of input.files) {
    const data = readFileSync(f.path).toString('base64');
    if (f.mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/jpeg', data } });
  }
  content.push({ type: 'text', text: prompt });

  const client = new Anthropic({ apiKey: cfg.key ?? undefined, baseURL: cfg.url || undefined });
  const res = await client.beta.messages.create({
    model: cfg.model || 'claude-opus-5-5', max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (res.stop_reason === 'refusal') throw new Error('extraction declined by the model');
  const text = res.content.find(b => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('extraction returned no data');
  return JSON.parse(text.text) as Extraction;
}
