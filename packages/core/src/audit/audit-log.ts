import type { DatabaseSync } from 'node:sqlite';
import { uuidv7, type ActionEvent } from '@tabreach/protocol';

export type ActorType = ActionEvent['actorType'];
export type AuditObjectType = 'company' | 'contact' | 'suppression' | 'import' | 'export';

export interface AuditEntry {
  actorType: ActorType;
  actionType: string;
  objectType?: AuditObjectType;
  objectId?: string;
  status?: 'completed' | 'failed' | 'planned' | 'started' | 'unknown';
  payload?: Record<string, unknown>;
  correlationId: string;
  causationId?: string;
}

/** Keys whose values never enter the audit trail (FR-AUD-004). */
const SENSITIVE = new Set([
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'plaintext',
  'ciphertext',
  'cookie',
  'authorization',
]);

export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? '[REDACTED]' : redactPayload(v, depth + 1);
  }
  return out;
}

interface Row {
  id: string;
  correlation_id: string;
  causation_id: string | null;
  actor_type: ActorType;
  action_type: string;
  object_type: string | null;
  object_id: string | null;
  status: string;
  payload_redacted: string;
  created_at: string;
}

/** Append-only audit trail backed by `action_events` (docs/20-OBSERVABILITY.md). */
export class AuditLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: AuditEntry): string {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO action_events
           (id, correlation_id, causation_id, actor_type, action_type, object_type, object_id, status,
            payload_redacted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.correlationId,
        entry.causationId ?? null,
        entry.actorType,
        entry.actionType,
        entry.objectType ?? null,
        entry.objectId ?? null,
        entry.status ?? 'completed',
        JSON.stringify(redactPayload(entry.payload ?? {})),
        this.now().toISOString(),
      );
    return id;
  }

  list(filter: {
    objectType?: string | undefined;
    objectId?: string | undefined;
    limit: number;
  }): ActionEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.objectType) {
      where.push('object_type = ?');
      params.push(filter.objectType);
    }
    if (filter.objectId) {
      where.push('object_id = ?');
      params.push(filter.objectId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM action_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, filter.limit) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      actorType: r.actor_type,
      actionType: r.action_type,
      objectType: r.object_type,
      objectId: r.object_id,
      status: r.status,
      payload: JSON.parse(r.payload_redacted) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }
}
