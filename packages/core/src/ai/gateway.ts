import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  aiSettingsInputSchema,
  DEFAULT_AI_SETTINGS,
  uuidv7,
  type AiSettings,
  type AiSettingsInput,
  type AiUsage,
  type AiUseCase,
  type Logger,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import type { Http } from '../email/gmail.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SecretStore } from '../secrets/secrets.js';
import type { SettingsRepository } from '../settings/settings.js';
import { AnthropicProvider } from './anthropic.js';
import type { PromptTemplate } from './prompts.js';
import { AiError, type AiProvider, type Usage } from './provider.js';

const SETTINGS_KEY = 'ai';
const KEY_REF = 'ai.key';
const keyRefSchema = z.object({ secretId: z.string() });
const CALL_TIMEOUT_MS = 120_000;

export interface AiCallContext {
  correlationId: string;
  signal: AbortSignal;
}

/**
 * The only component that calls AI providers (docs/15 "AI gateway"): it picks the model for the
 * use case, enforces the monthly budget, validates answers against the template's schema (one
 * repair attempt), and records every call's tokens and cost — never the prompt or the content.
 */
export class AiGateway {
  private readonly provider: AiProvider;

  constructor(
    private readonly db: DatabaseSync,
    private readonly settingsRepo: SettingsRepository,
    private readonly secrets: SecretStore,
    private readonly audit: AuditLog,
    http: Http,
    private readonly now: () => Date,
    private readonly logger: Logger,
  ) {
    this.provider = new AnthropicProvider(http, () => this.apiKey());
  }

  settings(): AiSettings {
    return { ...this.config(), keySet: this.keyRef() !== undefined };
  }

  update(input: AiSettingsInput, ctx: CommandContext): AiSettings {
    this.settingsRepo.set(SETTINGS_KEY, input);
    this.audit.record({
      actorType: 'user',
      actionType: 'ai.settings_updated',
      objectType: 'settings',
      correlationId: ctx.correlationId,
    });
    return this.settings();
  }

  async setKey(apiKey: string, ctx: CommandContext): Promise<void> {
    const secretId = await this.secrets.put('ai_api_key', apiKey);
    const previous = this.keyRef();
    this.settingsRepo.set(KEY_REF, { secretId });
    if (previous) this.secrets.delete(previous.secretId);
    this.audit.record({
      actorType: 'user',
      actionType: 'ai.key_set',
      objectType: 'settings',
      correlationId: ctx.correlationId,
    });
  }

  removeKey(ctx: CommandContext): void {
    const ref = this.keyRef();
    if (ref) this.secrets.delete(ref.secretId);
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY_REF);
    this.audit.record({
      actorType: 'user',
      actionType: 'ai.key_removed',
      objectType: 'settings',
      correlationId: ctx.correlationId,
    });
  }

  /** A minimal real call with the classification model: proves the key, the model name and the network. */
  async testKey(correlationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.run(keyCheck, {}, { correlationId, signal: AbortSignal.timeout(60_000) });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof AiError ? error.kind : 'unavailable' };
    }
  }

  usage(month: string = this.now().toISOString().slice(0, 7)): AiUsage {
    const rows = this.db
      .prepare(
        `SELECT use_case, status, input_tokens, output_tokens, cost_usd FROM ai_calls WHERE substr(created_at, 1, 7) = ?`,
      )
      .all(month) as {
      use_case: AiUseCase;
      status: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
    }[];
    const byUseCase = new Map<AiUseCase, { calls: number; inputTokens: number; outputTokens: number }>();
    let cost: number | null = 0;
    for (const r of rows) {
      const u = byUseCase.get(r.use_case) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
      u.calls++;
      u.inputTokens += r.input_tokens;
      u.outputTokens += r.output_tokens;
      byUseCase.set(r.use_case, u);
      if (r.status !== 'refused' && (r.input_tokens > 0 || r.output_tokens > 0)) {
        cost = r.cost_usd === null || cost === null ? null : cost + r.cost_usd;
      }
    }
    return {
      month,
      calls: rows.filter((r) => r.status !== 'refused').length,
      failed: rows.filter((r) => r.status === 'error' || r.status === 'invalid_output').length,
      inputTokens: rows.reduce((n, r) => n + r.input_tokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.output_tokens, 0),
      costUsd: cost,
      budgetUsd: this.config().monthlyBudgetUsd,
      byUseCase: [...byUseCase].map(([useCase, u]) => ({ useCase, ...u })),
    };
  }

  /**
   * Runs a template. Throws AiError; the answer is validated (and once repaired) before it is
   * returned, so callers get typed data or nothing.
   */
  async run<I, O>(template: PromptTemplate<I, O>, rawInput: I, ctx: AiCallContext): Promise<O> {
    const input = template.input.parse(rawInput);
    const config = this.config();
    const model = config.models[template.useCase];
    const record = (status: string, usage: Usage, started: number, errorClass: string | null = null) =>
      this.record({
        template,
        model,
        status,
        usage,
        latencyMs: Date.now() - started,
        errorClass,
        correlationId: ctx.correlationId,
      });

    const spent = this.usage().costUsd;
    if (config.monthlyBudgetUsd !== null && spent !== null && spent >= config.monthlyBudgetUsd) {
      record('refused', { inputTokens: 0, outputTokens: 0 }, Date.now(), 'budget');
      throw new AiError('budget', 'Monthly AI budget reached');
    }
    const { system, user } = template.build(input);
    const schema = jsonSchema(template.output);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
    let prompt = user;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      let answer;
      try {
        answer = await this.provider.structured({
          model,
          system,
          user: prompt,
          schema,
          maxTokens: template.maxTokens,
          signal,
        });
      } catch (error) {
        const kind = error instanceof AiError ? error.kind : 'unavailable';
        const usage = (error as { usage?: Usage }).usage ?? { inputTokens: 0, outputTokens: 0 };
        record(kind === 'invalid_output' ? 'invalid_output' : 'error', usage, started, kind);
        this.logger.warn({ event: 'ai.call_failed', template: template.key, model, kind }, 'AI call failed');
        if (kind === 'invalid_output' && attempt === 1) continue;
        throw error instanceof AiError ? error : new AiError('unavailable');
      }
      const parsed = template.output.safeParse(answer.json);
      if (parsed.success) {
        record('ok', answer.usage, started);
        return parsed.data;
      }
      record('invalid_output', answer.usage, started, 'schema');
      // One bounded repair attempt (docs/15 "Structured output"): say what was wrong, ask again.
      prompt = `${user}\n\nYour previous answer did not match the required structure (${z.prettifyError(parsed.error).slice(0, 500)}). Answer again with the exact structure.`;
    }
    throw new AiError('invalid_output', `${template.key} returned an invalid answer twice`);
  }

  /** A fresh random value for delimiting untrusted material in one prompt. */
  static nonce(): string {
    return randomBytes(6).toString('hex');
  }

  private record(r: {
    template: PromptTemplate<unknown, unknown> | PromptTemplate<never, unknown>;
    model: string;
    status: string;
    usage: Usage;
    latencyMs: number;
    errorClass: string | null;
    correlationId: string;
  }): void {
    const price = this.config().prices[r.model];
    const cost = price
      ? (r.usage.inputTokens / 1e6) * price.inputPerMTok + (r.usage.outputTokens / 1e6) * price.outputPerMTok
      : null;
    this.db
      .prepare(
        `INSERT INTO ai_calls (id, use_case, provider, model, template_key, template_version, status, input_tokens,
                               output_tokens, cost_usd, latency_ms, error_class, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        r.template.useCase,
        this.provider.name,
        r.model,
        r.template.key,
        r.template.version,
        r.status,
        r.usage.inputTokens,
        r.usage.outputTokens,
        cost,
        r.latencyMs,
        r.errorClass,
        r.correlationId,
        this.now().toISOString(),
      );
    this.logger.info(
      {
        event: 'ai.call',
        provider: this.provider.name,
        model: r.model,
        template: `${r.template.key}@${r.template.version}`,
        status: r.status,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        latencyMs: r.latencyMs,
      },
      'AI call',
    );
  }

  private config(): AiSettingsInput {
    return this.settingsRepo.get(SETTINGS_KEY, aiSettingsInputSchema) ?? DEFAULT_AI_SETTINGS;
  }

  private keyRef(): { secretId: string } | undefined {
    return this.settingsRepo.get(KEY_REF, keyRefSchema);
  }

  private async apiKey(): Promise<string | null> {
    const ref = this.keyRef();
    return ref ? this.secrets.reveal(ref.secretId) : null;
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void _ignored;
  return rest;
}

/** The smallest useful call, for "Test key". */
const keyCheck: PromptTemplate<Record<string, never>, { ok: boolean }> = {
  key: 'system.key_check',
  version: 1,
  purpose: 'Verify that the API key, model and network work.',
  useCase: 'classification',
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  output: z.object({ ok: z.boolean() }),
  maxTokens: 20,
  build: () => ({ system: 'Answer with ok = true.', user: 'Check.' }),
};
