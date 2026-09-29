import type { Http } from '../email/gmail.js';
import { AiError, type AiProvider, type StructuredRequest, type Usage } from './provider.js';

const URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const TOOL = 'answer';

/**
 * Anthropic Messages API over HTTPS. Structured output is a forced tool call whose input schema
 * is the template's schema: the model answers with JSON, never with free text to parse.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly http: Http,
    private readonly apiKey: () => Promise<string | null>,
  ) {}

  async structured(req: StructuredRequest): Promise<{ json: unknown; usage: Usage }> {
    const key = await this.apiKey();
    if (!key) throw new AiError('no_key');
    let res: Response;
    try {
      res = await this.http(URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          tools: [
            {
              name: TOOL,
              description: 'Return the answer in this exact structure.',
              input_schema: req.schema,
            },
          ],
          tool_choice: { type: 'tool', name: TOOL },
        }),
        signal: req.signal,
      });
    } catch {
      throw new AiError('unavailable', 'Anthropic API unreachable');
    }
    const body = (await res.json().catch(() => ({}))) as {
      content?: { type: string; name?: string; input?: unknown }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { type?: string };
    };
    if (!res.ok) {
      // Only the error type is kept: messages can echo the request.
      const type = body.error?.type ?? String(res.status);
      if (res.status === 401 || res.status === 403) throw new AiError('auth', `Anthropic: ${type}`);
      if (res.status === 429 || res.status === 529 || res.status >= 500)
        throw new AiError('rate_limited', `Anthropic: ${type}`);
      throw new AiError('rejected', `Anthropic: ${type}`);
    }
    const call = body.content?.find((c) => c.type === 'tool_use' && c.name === TOOL);
    const usage = {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
    if (!call) throw Object.assign(new AiError('invalid_output', 'No structured answer'), { usage });
    return { json: call.input, usage };
  }
}
