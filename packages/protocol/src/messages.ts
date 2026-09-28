import { z } from 'zod';

export const componentStatusSchema = z.enum(['ok', 'degraded', 'down', 'unknown']);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const chromeInfoSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
});
export type ChromeInfo = z.infer<typeof chromeInfoSchema>;

export const workerHealthSchema = z.object({
  status: componentStatusSchema,
  node: z.string(),
  playwright: z.string(),
  chrome: chromeInfoSchema,
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

export const databaseHealthSchema = z.object({
  status: componentStatusSchema,
  sqliteVersion: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
export type DatabaseHealth = z.infer<typeof databaseHealthSchema>;

export const healthReportSchema = z.object({
  checkedAt: z.iso.datetime(),
  app: z.object({ version: z.string(), electron: z.string().nullable(), node: z.string() }),
  core: z.object({ status: componentStatusSchema }),
  database: databaseHealthSchema,
  /** Result of the startup safeStorage round trip through main. */
  secrets: z.object({ status: componentStatusSchema, detail: z.string().optional() }),
  worker: z.union([workerHealthSchema, z.object({ status: componentStatusSchema, detail: z.string() })]),
});
export type HealthReport = z.infer<typeof healthReportSchema>;

export const launchCheckRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
});
export const launchCheckResultSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  httpStatus: z.number().int().nullable(),
  title: z.string().nullable(),
  chromeVersion: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type LaunchCheckResult = z.infer<typeof launchCheckResultSchema>;

export const secretCipherTextSchema = z.object({ ciphertext: z.base64() });

/**
 * Request/response registry. `channel` names the process pair:
 * - app:     renderer -> core
 * - browser: core -> browser worker
 * - host:    core -> main (Electron-only capabilities)
 */
export const requests = {
  'app.health': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: healthReportSchema,
  },
  'browser.launchCheck': {
    channel: 'app',
    kind: 'command',
    request: launchCheckRequestSchema,
    response: launchCheckResultSchema,
  },
  'worker.health': {
    channel: 'browser',
    kind: 'query',
    request: z.object({}),
    response: workerHealthSchema,
  },
  'worker.launchCheck': {
    channel: 'browser',
    kind: 'command',
    request: launchCheckRequestSchema,
    response: launchCheckResultSchema,
  },
  'secret.encrypt': {
    channel: 'host',
    kind: 'command',
    request: z.object({ plaintext: z.string().min(1) }),
    response: secretCipherTextSchema,
  },
  'secret.decrypt': {
    channel: 'host',
    kind: 'command',
    request: secretCipherTextSchema,
    response: z.object({ plaintext: z.string() }),
  },
} as const;

export type RequestType = keyof typeof requests;
export type Channel = (typeof requests)[RequestType]['channel'];
export type RequestsOn<C extends Channel> = {
  [K in RequestType]: (typeof requests)[K]['channel'] extends C ? K : never;
}[RequestType];
export type RequestOf<T extends RequestType> = z.input<(typeof requests)[T]['request']>;
export type ResponseOf<T extends RequestType> = z.output<(typeof requests)[T]['response']>;

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(requests, type);
}
