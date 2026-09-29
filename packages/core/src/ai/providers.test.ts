import { DEFAULT_AI_MODELS } from '@tabreach/protocol';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';
import type { PromptTemplate } from './prompts.js';

const t: PromptTemplate<{ text: string }, { label: string; score: number }> = {
  key: 'test.label',
  version: 1,
  purpose: 'test',
  useCase: 'classification',
  input: z.object({ text: z.string() }),
  output: z.object({ label: z.string().max(20), score: z.number().min(0).max(1) }),
  maxTokens: 50,
  build: ({ text }) => ({ system: 'Label it.', user: text }),
};

describe('OpenRouter and OpenAI providers', () => {
  let h: Harness;
  const call = () =>
    h.services.ai.run(t, { text: 'x' }, { correlationId: 'c', signal: new AbortController().signal });
  const useProvider = (provider: 'openrouter' | 'openai') =>
    h.services.ai.update(
      { ...h.services.ai.settings(), provider, models: DEFAULT_AI_MODELS[provider] },
      ctx(),
    );
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  it('OpenRouter: bearer key, DeepSeek model, strict JSON schema, provider-reported cost', async () => {
    useProvider('openrouter');
    await h.services.ai.setKey('openrouter', 'sk-or-v1-test-0123456789', ctx());
    h.chat.answer({ content: '```json\n{"label":"interested","score":0.8}\n```', cost: 0.00042 });
    expect(await call()).toEqual({ label: 'interested', score: 0.8 });
    const [req] = h.chat.requests;
    expect(req?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req?.authorization).toBe('Bearer sk-or-v1-test-0123456789');
    expect(req?.body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(req?.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(req?.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    // Keywords strict mode may reject are left out; Zod still enforces them.
    expect(JSON.stringify(req?.body.response_format.json_schema.schema)).not.toMatch(/maxLength|maximum/);
    expect(req?.body.provider).toEqual({ require_parameters: true });
    expect(h.services.ai.usage()).toMatchObject({ calls: 1, costUsd: 0.00042 });
    expect(h.anthropic.requests).toHaveLength(0);
  });

  it('OpenAI uses its own endpoint and key; keys of different providers are kept apart', async () => {
    await h.services.ai.setKey('openrouter', 'sk-or-v1-test-0123456789', ctx());
    await h.services.ai.setKey('openai', 'sk-proj-test-0123456789', ctx());
    useProvider('openai');
    h.chat.answer({ content: '{"label":"a","score":0.1}' });
    await call();
    expect(h.chat.requests[0]).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      authorization: 'Bearer sk-proj-test-0123456789',
    });
    expect(h.chat.requests[0]?.body.provider).toBeUndefined();
    expect(h.services.ai.settings()).toMatchObject({
      provider: 'openai',
      keySet: true,
      keys: { anthropic: false, openrouter: true, openai: true },
    });
    h.services.ai.removeKey('openai', ctx());
    expect(h.services.ai.settings().keys).toEqual({ anthropic: false, openrouter: true, openai: false });
  });

  it('maps no credits (402) and refused keys, and repairs invalid JSON once', async () => {
    useProvider('openrouter');
    await h.services.ai.setKey('openrouter', 'sk-or-v1-test-0123456789', ctx());
    h.chat.answer(
      { status: 402, body: { error: { code: 402 } } },
      { status: 401, body: { error: { code: 401 } } },
    );
    await expect(call()).rejects.toMatchObject({ kind: 'payment' });
    await expect(call()).rejects.toMatchObject({ kind: 'auth' });
    h.chat.answer({ content: 'not json' }, { content: '{"label":"ok","score":1}' });
    expect(await call()).toEqual({ label: 'ok', score: 1 });
  });

  it('a key saved before providers existed still counts as the Anthropic key', async () => {
    const secretId = await h.services.secrets.put('ai_api_key', 'sk-ant-legacy-0123456789');
    h.services.settings.set('ai.key', { secretId });
    expect(h.services.ai.settings()).toMatchObject({ provider: 'anthropic', keySet: true });
    h.services.ai.removeKey('anthropic', ctx());
    expect(h.services.ai.settings().keySet).toBe(false);
  });

  it('saving a key again keeps the new key (it used to delete it every second time)', async () => {
    useProvider('openrouter');
    for (const key of [
      'sk-or-v1-first-000000aaaa',
      'sk-or-v1-second-00000bbbb',
      ' sk-or-v1-third-00000cccc\n',
    ]) {
      await h.services.ai.setKey('openrouter', key, ctx());
      expect(h.services.ai.settings()).toMatchObject({ keySet: true, keyHint: `…${key.trim().slice(-4)}` });
    }
    h.chat.answer({ content: '{"label":"a","score":0.1}' });
    await call();
    expect(h.chat.requests[0]?.authorization).toBe('Bearer sk-or-v1-third-00000cccc');
    const stored = h.db.prepare(`SELECT COUNT(*) AS n FROM secrets WHERE purpose = 'ai_api_key'`).get();
    expect(stored).toEqual({ n: 1 });
  });

  it('an answer cut off at the token limit is invalid output, repaired once', async () => {
    useProvider('openrouter');
    await h.services.ai.setKey('openrouter', 'sk-or-v1-test-0123456789', ctx());
    h.chat.answer(
      { content: '{"label":"interes', finishReason: 'length' },
      { content: '{"label":"ok","score":1}' },
    );
    expect(await call()).toEqual({ label: 'ok', score: 1 });
    expect(h.services.ai.usage()).toMatchObject({ calls: 2, failed: 1 });
  });

  it('on start, stored AI keys that no setting points at are deleted', async () => {
    await h.services.ai.setKey('openai', 'sk-proj-test-0123456789', ctx());
    const orphan = await h.services.secrets.put('ai_api_key', 'sk-or-v1-orphan-0123456789');
    h.dispatcher.stop();
    h.boot(); // the app starts again
    const ids = h.db.prepare(`SELECT id FROM secrets WHERE purpose = 'ai_api_key'`).all() as { id: string }[];
    expect(ids.map((r) => r.id)).not.toContain(orphan);
    expect(h.services.ai.settings().keys.openai).toBe(true);
  });
});
