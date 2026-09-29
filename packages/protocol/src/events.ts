import { z } from 'zod';
import { sessionChangedSchema, sessionModeChangedSchema, workerHeartbeatSchema } from './browser.js';

/** Entities whose data changed; the renderer refetches queries for these (ADR 020). */
export const changedEntitySchema = z.enum([
  'company',
  'contact',
  'suppression',
  'activity',
  'settings',
  'job',
  'campaign',
  'enrollment',
  'approval',
  'account',
  'conversation',
  'research',
  'browser',
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
  'session.changed': { channel: 'browser', payload: sessionChangedSchema },
  'worker.heartbeat': { channel: 'browser', payload: workerHeartbeatSchema },
  'session.modeChanged': { channel: 'browser', payload: sessionModeChangedSchema },
} as const;

export type EventType = keyof typeof events;
export type EventPayloadOf<T extends EventType> = z.output<(typeof events)[T]['payload']>;
export type EventsOn<C extends string> = {
  [K in EventType]: (typeof events)[K]['channel'] extends C ? K : never;
}[EventType];

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(events, type);
}
