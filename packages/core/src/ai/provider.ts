/** Provider-neutral AI interface (docs/15 "Provider abstraction"). */

export interface StructuredRequest {
  model: string;
  system: string;
  /** The user turn; untrusted material inside it is already delimited by the prompt template. */
  user: string;
  /** JSON Schema the answer must follow (from the template's Zod schema). */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Cost as reported by the provider (OpenRouter does), in USD. */
  costUsd?: number;
  /** Of the output, tokens spent thinking before the answer (reasoning models), when reported. */
  reasoningTokens?: number;
}

export interface AiProvider {
  readonly name: string;
  /** Returns the model's JSON answer (not yet validated) and what it cost in tokens. */
  structured(request: StructuredRequest): Promise<{ json: unknown; usage: Usage }>;
}

export type AiErrorKind =
  /** No API key stored. */
  | 'no_key'
  /** The provider refused the key. */
  | 'auth'
  /** The provider account has no credits or billing. */
  | 'payment'
  /** Monthly budget reached. */
  | 'budget'
  /** Rate limit or overload: try later. */
  | 'rate_limited'
  /** Network or provider error. */
  | 'unavailable'
  /** The answer did not match the schema, even after one repair attempt. */
  | 'invalid_output'
  /** The request itself was refused (too large, bad model name). */
  | 'rejected';

export class AiError extends Error {
  override name = 'AiError';
  constructor(
    readonly kind: AiErrorKind,
    message: string = kind,
  ) {
    super(message);
  }

  /** Worth trying again later without a change by the user. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}
