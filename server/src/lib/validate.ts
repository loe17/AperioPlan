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
