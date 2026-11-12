import { z, type ZodType } from 'zod';
import { badRequest } from './errors';

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('بيانات غير صالحة', result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })));
  }
  return result.data;
}

export const zId = z.string().uuid('معرّف غير صالح');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD');
export const zDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
