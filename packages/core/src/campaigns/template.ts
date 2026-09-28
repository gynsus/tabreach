import { templateFields, type TemplateField } from '@tabreach/protocol';

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*(?:\|([^}]*))?\}\}/g;
const KNOWN = new Set<string>(templateFields);

/** Placeholders that are not in the template field list (a launch validation error). */
export function unknownPlaceholders(template: string): string[] {
  const unknown = new Set<string>();
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (name && !KNOWN.has(name)) unknown.add(name);
  }
  return [...unknown];
}

/**
 * Fills `{{field}}` and `{{field|default}}`. A field with no value and no default is reported as
 * missing rather than rendered empty ("Hi ,").
 */
export function renderTemplate(
  template: string,
  values: Partial<Record<TemplateField, string | null>>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
    const value = KNOWN.has(name) ? values[name as TemplateField]?.trim() : undefined;
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return '';
  });
  return { text, missing: [...missing] };
}
