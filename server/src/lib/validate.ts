import { z } from 'zod';
import { HttpError } from './errors';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg, 'validation');
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
export { z };

/**
 * Wie schema.partial(), aber ohne Vorgabewerte – für PATCH-Anfragen, damit nicht
 * mitgeschickte Felder nicht auf ihre Vorgabe zurückgesetzt werden.
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) {
    let t = v as unknown as z.ZodType & { _zod: { def: { type: string; innerType?: z.ZodType } } };
    while (t._zod.def.type === 'default') t = t._zod.def.innerType as typeof t;
    shape[k] = t.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}
