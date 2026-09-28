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
