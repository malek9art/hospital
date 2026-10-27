/**
 * Vercel Node function entry point. Every /api/* request is rewritten here and
 * forwarded to the same Fastify instance used by the long-running server, so
 * routing, auth, RBAC, CSRF and RLS behave identically in both environments.
 */
export { handler as default } from '../apps/api/src/serverless';

export const config = { maxDuration: 60 };
