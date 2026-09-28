import type { TFunction } from 'i18next';
import type { Problem, RequestOf, RequestsOn, ResponseOf } from '@tabreach/protocol';
import { translateKey } from '../i18n';

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title);
    this.name = 'ApiError';
  }
}

/** Calls core over the preload bridge; failures become ApiError with the core's problem. */
export async function call<T extends RequestsOn<'app'>>(
  type: T,
  payload: RequestOf<T>,
): Promise<ResponseOf<T>> {
  const result = await window.tabreach.invoke(type, payload);
  if (!result.ok) throw new ApiError(result.error);
  return result.data;
}

/** Per-field error keys from a validation failure (translated by the form). */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? (error.problem.fields ?? {}) : {};
}

/** One human-readable message for any failure, in the current language. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    const fields = Object.values(error.problem.fields ?? {});
    if (fields.length > 0)
      return fields.map((k) => translateKey(t, `errors.${k}`, t('errors.generic'))).join(' ');
    if (error.problem.code === 'UNAVAILABLE' || error.problem.code === 'TIMEOUT')
      return t('errors.unavailable');
  }
  return t('errors.generic');
}

export const PAGE_SIZE = 100;
