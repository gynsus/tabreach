export { CoreService, type CoreOptions } from './core.js';
export { openDatabase, sqliteVersion, transaction } from './db/database.js';
export { migrate, currentSchemaVersion, MigrationError, type MigrationReport } from './db/migrate.js';
export { migrations, type Migration } from './db/migrations.js';
export { SettingsRepository } from './settings/settings.js';
export {
  SecretStore,
  SecretNotFoundError,
  type SecretCipher,
  type SecretPurpose,
} from './secrets/secrets.js';
export { AppServices } from './app-handlers.js';
export { AuditLog } from './audit/audit-log.js';
export * from './prospects/normalize.js';
export { JobQueue, type JobRow, type JobStatus } from './jobs/queue.js';
export {
  Dispatcher,
  RetryableError,
  PermanentError,
  backoffMs,
  type JobType,
  type JobContext,
} from './jobs/dispatcher.js';
export { SideEffectLedger, intentKey, type IntentParts, type SideEffectRow } from './ledger/side-effects.js';
export { executeSideEffect, type ExecutionOutcome } from './ledger/execute.js';
export type { MessageChannel, OutgoingMessage, SendResult, ReconcileResult } from './channels/channel.js';
export { TestChannel, type TestOutcome } from './channels/test-channel.js';
