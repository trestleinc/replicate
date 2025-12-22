import { z } from 'zod';
import type { ProseValue } from '$/shared/types';

const PROSE_MARKER = Symbol.for('replicate:prose');

export function prose(): z.ZodType<ProseValue> {
  const schema = z.custom<ProseValue>(
    (val) => {
      if (val == null) return true;
      if (typeof val !== 'object') return false;
      return (val as { type?: string }).type === 'doc';
    },
    { message: 'Expected prose document with type "doc"' }
  );

  Object.defineProperty(schema, PROSE_MARKER, { value: true, writable: false });

  return schema;
}

export function isProseSchema(schema: unknown): boolean {
  return (
    schema != null &&
    typeof schema === 'object' &&
    PROSE_MARKER in schema &&
    (schema as Record<symbol, unknown>)[PROSE_MARKER] === true
  );
}

export function extractProseFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const fields: string[] = [];

  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    let unwrapped = fieldSchema;
    while (unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodNullable) {
      unwrapped = unwrapped.unwrap();
    }

    if (isProseSchema(unwrapped)) {
      fields.push(key);
    }
  }

  return fields;
}
