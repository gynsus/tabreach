import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { events } from './events.js';
import { requests } from './messages.js';

/** docs/21 "protocol contract tests": every message type is declared completely, with Zod schemas. */
describe('message registries', () => {
  it('every request has a channel, a kind, and Zod request and response schemas', () => {
    const entries = Object.entries(requests);
    expect(entries.length).toBeGreaterThan(50);
    for (const [type, def] of entries) {
      expect(['app', 'browser', 'host'], type).toContain(def.channel);
      expect(['query', 'command'], type).toContain(def.kind);
      expect(def.request, type).toBeInstanceOf(z.ZodType);
      expect(def.response, type).toBeInstanceOf(z.ZodType);
      expect(type, type).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/);
    }
  });

  it('every event has a Zod payload schema', () => {
    for (const [type, def] of Object.entries(events)) {
      expect(def.payload, type).toBeInstanceOf(z.ZodType);
    }
  });
});
