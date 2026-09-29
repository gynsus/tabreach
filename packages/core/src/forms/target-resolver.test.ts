import { uuidv7 } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

describe('bounded semantic resolution (ADR 013, Phase 6c)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());
  const signal = () => new AbortController().signal;
  const fields = {
    kind: 'form_fields' as const,
    taskId: uuidv7(),
    fields: [
      { ref: 0, label: 'Where can we write back?', placeholder: '', name: 'f2', type: 'text' },
      { ref: 1, label: 'Order reference', placeholder: '', name: 'f3', type: 'text' },
    ],
  };

  it('without an AI key nothing is asked and nothing leaves the Mac', async () => {
    expect(await h.services.targets.resolve(fields, uuidv7(), signal())).toEqual({
      available: false,
      meanings: [],
      link: null,
    });
    expect(h.anthropic.requests).toHaveLength(0);
  });

  it('keeps only choices for the fields it was given; page text is fenced as untrusted', async () => {
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
    h.anthropic.answer({
      input: {
        fields: [
          { ref: 0, meaning: 'email' },
          { ref: 1, meaning: null },
          { ref: 7, meaning: 'name' },
        ],
      },
    });
    const r = await h.services.targets.resolve(fields, uuidv7(), signal());
    expect(r).toEqual({
      available: true,
      link: null,
      meanings: [
        { ref: 0, meaning: 'email' },
        { ref: 1, meaning: null },
      ],
    });
    const request = h.anthropic.requests.at(-1)!;
    expect(request.user).toMatch(/<untrusted source="form-fields"/);
    expect(request.user).toContain('Where can we write back?');
    expect(request.system).toMatch(/Never invent fields or values/);
    const recorded = h.db
      .prepare(`SELECT payload_redacted AS p FROM action_events WHERE action_type = 'ai.target_resolved'`)
      .get() as { p: string };
    // Counts only: no page text in the audit trail (ADR 022).
    expect(JSON.parse(recorded.p)).toEqual({ kind: 'form_fields', candidates: 2, chosen: 1 });
  });

  it('a consent is never AI’s choice; an answer outside the list is not used', async () => {
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
    const consent = { input: { fields: [{ ref: 0, meaning: 'consent' }] } };
    h.anthropic.answer(consent, consent); // the gateway asks once more for a valid answer
    expect(await h.services.targets.resolve(fields, uuidv7(), signal())).toMatchObject({ available: false });

    h.anthropic.answer({ input: { ref: 9 } });
    const link = await h.services.targets.resolve(
      { kind: 'contact_link', taskId: uuidv7(), links: [{ ref: 0, text: 'Talk to sales', path: '/talk' }] },
      uuidv7(),
      signal(),
    );
    expect(link).toEqual({ available: true, meanings: [], link: null });
  });
});
