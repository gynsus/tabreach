import type { Http } from '../email/gmail.js';

export interface SeenRequest {
  apiKey: string | null;
  model: string;
  system: string;
  user: string;
  schema: unknown;
}

type Answer =
  { status: number; body: unknown } | { input: unknown; inputTokens?: number; outputTokens?: number };

/** The Anthropic Messages API in memory: records what was asked, answers what the test queued. */
export class FakeAnthropic {
  readonly requests: SeenRequest[] = [];
  private readonly answers: Answer[] = [];
  /** Answer used when nothing is queued. */
  fallback: Answer = { input: { ok: true } };

  answer(...a: Answer[]): void {
    this.answers.push(...a);
  }

  readonly http: Http = async (url, init) => {
    if (url !== 'https://api.anthropic.com/v1/messages') return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init.body)) as {
      model: string;
      system: string;
      messages: { content: string }[];
      tools: { input_schema: unknown }[];
    };
    this.requests.push({
      apiKey: new Headers(init.headers).get('x-api-key'),
      model: body.model,
      system: body.system,
      user: body.messages[0]?.content ?? '',
      schema: body.tools[0]?.input_schema,
    });
    const a = this.answers.shift() ?? this.fallback;
    if ('status' in a) return new Response(JSON.stringify(a.body), { status: a.status });
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'answer', input: a.input }],
        usage: { input_tokens: a.inputTokens ?? 1000, output_tokens: a.outputTokens ?? 100 },
      }),
      { status: 200 },
    );
  };
}
