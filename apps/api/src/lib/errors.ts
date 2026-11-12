export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'يجب تسجيل الدخول') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'لا تملك صلاحية لهذا الإجراء') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'العنصر غير موجود') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, 'unprocessable', msg, details);
export const tooMany = (msg = 'محاولات كثيرة، حاول لاحقًا') => new AppError(429, 'rate_limited', msg);
