import { z } from 'zod';

/** Entities whose data changed; the renderer refetches queries for these (ADR 020). */
export const changedEntitySchema = z.enum([
  'company',
  'contact',
  'suppression',
  'activity',
  'settings',
  'job',
]);
export type ChangedEntity = z.infer<typeof changedEntitySchema>;

/**
 * Event registry: one-way notifications, never commands. Receivers treat them as hints and re-query
 * for authoritative state (docs/06-API-CONTRACT.md, "Events").
 */
export const events = {
  'data.changed': {
    channel: 'app',
    payload: z.object({ entities: z.array(changedEntitySchema).min(1) }),
  },
} as const;

export type EventType = keyof typeof events;
export type EventPayloadOf<T extends EventType> = z.output<(typeof events)[T]['payload']>;
export type EventsOn<C extends string> = {
  [K in EventType]: (typeof events)[K]['channel'] extends C ? K : never;
}[EventType];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(events, type);
}
