import type { Http } from '../email/gmail.js';
import { AiError, type AiProvider, type StructuredRequest, type Usage } from './provider.js';

/** Keywords strict structured output may reject; the gateway validates them with Zod anyway. */
const UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

/**
 * The schema without keywords strict mode may reject. What they said is kept as words in the
 * field's description ("maxItems: 20"), so the model still knows the limits.
 */
function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const entries = Object.entries(schema as Record<string, unknown>);
  const limits = entries.filter(([k]) => UNSUPPORTED.has(k)).map(([k, v]) => `${k}: ${String(v)}`);
  const kept = Object.fromEntries(
    entries.filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, strictSchema(v)]),
  );
  if (limits.length === 0) return kept;
  const description = typeof kept.description === 'string' ? `${kept.description} ` : '';
  return { ...kept, description: `${description}(${limits.join(', ')})` };
}

/** A JSON answer, possibly wrapped in a Markdown code fence by some models. */
function parseJson(content: string): unknown {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(text);
}

/**
 * OpenAI Chat Completions, also spoken by OpenRouter (docs/15 "Provider abstraction"). Structured
 * output: `response_format` with the template's JSON Schema (strict, minus keywords strict mode
 * does not take — Zod checks them after).
 */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    readonly name: 'openrouter' | 'openai',
    private readonly baseUrl: string,
    private readonly http: Http,
    private readonly apiKey: () => Promise<string | null>,
  ) {}

  async structured(req: StructuredRequest): Promise<{ json: unknown; usage: Usage }> {
    const key = await this.apiKey();
    if (!key) throw new AiError('no_key');
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: strictSchema(req.schema) },
      },
    };
    if (this.name === 'openrouter') {
      // Route only to providers that honour the schema, and report the cost of each call.
      body.provider = { require_parameters: true };
      body.usage = { include: true };
    }
    let res: Response;
    try {
      res = await this.http(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...(this.name === 'openrouter' ? { 'x-title': 'TabReach' } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch {
      throw new AiError('unavailable', `${this.name} unreachable`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      error?: { code?: number | string; type?: string };
    };
    if (!res.ok) {
      // Only status and error type are kept: messages can echo the request.
      const type = String(json.error?.type ?? json.error?.code ?? res.status);
      if (res.status === 401 || res.status === 403) throw new AiError('auth', `${this.name}: ${type}`);
      if (res.status === 402) throw new AiError('payment', `${this.name}: ${type}`);
      if (res.status === 429 || res.status >= 500) throw new AiError('rate_limited', `${this.name}: ${type}`);
      throw new AiError('rejected', `${this.name}: ${type}`);
    }
    const usage: Usage = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      ...(typeof json.usage?.cost === 'number' ? { costUsd: json.usage.cost } : {}),
      ...(typeof json.usage?.completion_tokens_details?.reasoning_tokens === 'number'
        ? { reasoningTokens: json.usage.completion_tokens_details.reasoning_tokens }
        : {}),
    };
    const content = json.choices?.[0]?.message?.content;
    if (json.choices?.[0]?.finish_reason === 'length')
      throw Object.assign(new AiError('invalid_output', 'Answer cut off at the token limit'), { usage });
    if (!content) throw Object.assign(new AiError('invalid_output', 'No answer'), { usage });
    try {
      return { json: parseJson(content), usage };
    } catch {
      throw Object.assign(new AiError('invalid_output', 'Answer is not JSON'), { usage });
    }
  }
}
