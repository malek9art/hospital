import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { loadAuthFromToken, type AuthContext } from './auth/context';
import { assertSessionUsable } from './auth/context';
import { csrfMatches } from './auth/service';
import { AppError } from './lib/errors';
import { COOKIE_NAME } from './lib/constants';
import { authRoutes } from './modules/auth/routes';
import { patientRoutes } from './modules/patients/routes';
import { appointmentRoutes } from './modules/appointments/routes';
import { encounterRoutes } from './modules/encounters/routes';
import { labRoutes } from './modules/labs/routes';
import { pharmacyRoutes } from './modules/pharmacy/routes';
import { billingRoutes } from './modules/billing/routes';
import { inpatientRoutes } from './modules/inpatient/routes';
import { emergencyRoutes } from './modules/emergency/routes';
import { reportRoutes } from './modules/reports/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { adminRoutes } from './modules/admin/routes';
import { portalRoutes } from './modules/portal/routes';
import { fhirRoutes } from './modules/fhir/routes';
import { metaRoutes } from './modules/meta/routes';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface BuildOptions {
  logger?: boolean | object;
  serveWeb?: boolean;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = config();
  const app = Fastify({
    logger: opts.logger ?? {
      level: cfg.NODE_ENV === 'production' ? 'info' : 'warn',
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // The app may be embedded by the platform preview (same-origin/HTTPS only).
        frameAncestors: ["'self'", 'https:'],
      },
    },
    frameguard: false,
    hsts: cfg.NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyRateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: [],
    keyGenerator: (req) => req.ip,
  });

  // ---- Origin + CSRF protection -------------------------------------------------
  app.addHook('preHandler', async (req) => {
    const method = req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host;
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = '';
        }
        if (!host || originHost !== host) {
          throw new AppError(403, 'origin_rejected', 'مصدر الطلب غير موثوق');
        }
      }
    }
  });

  app.addHook('preHandler', async (req) => {
    const token = req.cookies?.[COOKIE_NAME];
    req.auth = await loadAuthFromToken(token);
    if (!req.auth) return;
    assertSessionUsable(req.auth, req.url.split('?')[0]);
    const method = req.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const provided = req.headers['x-csrf-token'];
      if (typeof provided !== 'string' || !csrfMatches(req.auth.csrfToken, provided)) {
        throw new AppError(403, 'csrf_failed', 'رمز CSRF غير صالح — أعد تحميل الصفحة');
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      reply.header('Pragma', 'no-cache');
      reply.header('X-Request-Id', req.id);
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
        requestId: req.id,
      });
    }
    const anyErr = err as any;
    if (anyErr?.validation) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'طلب غير صالح', details: anyErr.message },
        requestId: req.id,
      });
    }
    if (anyErr?.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'عدد الطلبات كبير، حاول بعد قليل' },
        requestId: req.id,
      });
    }
    switch (anyErr?.code) {
      case '23505':
        return reply.code(409).send({
          error: { code: 'duplicate', message: 'العنصر موجود مسبقًا (تكرار غير مسموح)', details: null },
          requestId: req.id,
        });
      case '23514':
      case '23502':
      case '23503':
      case '22P02':
        return reply.code(422).send({
          error: { code: 'invalid_data', message: 'بيانات لا تحقق قيود قاعدة البيانات', details: anyErr.detail ?? null },
          requestId: req.id,
        });
      case '42501':
        return reply.code(403).send({
          error: { code: 'db_permission_denied', message: 'تم رفض الوصول على مستوى قاعدة البيانات' },
          requestId: req.id,
        });
      default:
        break;
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'حدث خطأ غير متوقع. تم تسجيله للمراجعة.' },
      requestId: req.id,
    });
  });

  // ---- Health -------------------------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, mode: cfg.DB_MODE, time: new Date().toISOString() }));

  // ---- Routes -------------------------------------------------------------------
  await app.register(authRoutes);
  await app.register(patientRoutes);
  await app.register(appointmentRoutes);
  await app.register(encounterRoutes);
  await app.register(labRoutes);
  await app.register(pharmacyRoutes);
  await app.register(billingRoutes);
  await app.register(inpatientRoutes);
  await app.register(emergencyRoutes);
  await app.register(reportRoutes);
  await app.register(dashboardRoutes);
  await app.register(adminRoutes);
  await app.register(portalRoutes);
  await app.register(fhirRoutes);
  await app.register(metaRoutes);

  // ---- Static SPA ---------------------------------------------------------------
  const webDir = cfg.WEB_DIR;
  if (opts.serveWeb !== false && fs.existsSync(path.join(webDir, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (res: any, filePath: string) => {
        if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/fhir/')) {
        return reply.type('text/html').send(fs.createReadStream(path.join(webDir, 'index.html')));
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'المسار غير موجود' } });
    });
  }

  return app;
}
