# دليل التشغيل والنشر

## 1) المتطلبات

- Node.js 22+، PostgreSQL 16+ (موصى به 18) للإنتاج.
- مفاتيح: `SESSION_SECRET`, `ENCRYPTION_KEY`, `SEARCH_HASH_KEY` (32 بايت base64 لكل منها).
- TLS terminal (nginx/ALB) و`COOKIE_SECURE=true`.

## 2) النشر على Docker Compose

```bash
cp .env.example .env.production      # ثم عدّل القيم
# ملف ops/.env يحتاج POSTGRES_OWNER_PASSWORD و AGE_RECIPIENT (مفتاح عام للتشفير)
docker compose -f ops/docker-compose.yml --env-file ops/.env up -d db
docker run --rm --network host -e PGPASSWORD=... postgres:18-alpine \
  psql -h 127.0.0.1 -U hms_owner -d hms -f /ops/postgres-init.sql   # أدوار قاعدة البيانات
npm ci && npm run db:migrate          # بصلاحية hms_owner (المترجم فقط)
npm run build && docker compose -f ops/docker-compose.yml --env-file ops/.env up -d api
```

- الترحيلات تُطبق تلقائيًا عند تشغيل التطوير، وتُدار صراحة في الإنتاج (`npm run db:migrate`).
- في الإنتاج يرفض الخادم البدء إن لم تكن الترحيلات مطبقة أو المفاتيح غير مضبوطة.

## 3) بعد النشر (Checklist)

- [ ] `/api/health` = 200
- [ ] `/api/audit/verify` → `ok:true`
- [ ] تسجيل دخول لكل دور وتأكيد أن `permissions` كما هو متوقع
- [ ] تفعيل MFA إجباريًا للحسابات الإدارية (`mfa_enforced`)
- [ ] تغيير كل كلمات مرور الحسابات التجريبية أو إيقافها (`SEED_DEMO=false` في الإنتاج)
- [ ] تفعيل WAL archiving + جدولة `backup.sh`
- [ ] ربط تنبيهات خارجية على: فشل تحقق السلسلة، `break_glass`، تكرار 429، أخطاء 5xx

## 4) المراقبة

| المؤشر | المصدر | عتبة التنبيه |
|---|---|---|
| 5xx rate | سجلات Pino (`req.log.error`) | > 0.5% لمدة 5 دقائق |
| محاولات دخول فاشلة | `audit_log.action='auth.login' AND outcome='denied'` | > 20/5 دقائق لكل IP |
| break-glass | `audit_log.action='patient.break_glass'` | أي حالة → مراجعة إدارية |
| تحقق السلسلة | `/api/audit/verify` مجدولًا | `ok:false` |
| الحذف/التعديل على السجلات المعتمدة | أخطاء `append-only` في السجلات | أي محاولة |
| مساحة القرص/الأسرّة | مؤشرات مخصصة | حسب سياسة المنشأة |

## 5) النسخ الاحتياطي والاستعادة

```bash
# نسخة مشفرة يومية (age)
/bin/sh ops/backup.sh
# تجربة استعادة شهرية إلى قاعدة مؤقتة
/bin/sh ops/restore.sh /backups/hms-2026-10-27T02:00:00Z.dump.age ~/age.key
```
- فحص الاستعادة يتضمن عدد المرضى وعدد سجلات التدقيق وصحة السلسلة.
- **لا تُعلن جاهزية التعافي حتى تنجح تجربة كاملة مسجلة.**

## 6) تدوير المفاتيح

| المفتاح | الأثر | الخطوات |
|---|---|---|
| `SESSION_SECRET` | إبطال كل الجلسات | تحديث env → إعادة تشغيل → إبلاغ المستخدمين |
| `SEARCH_HASH_KEY` | تعطّل البحث بالهوية حتى إعادة الفهرسة | تحديث env → إعادة حساب `national_id_hash` بترحيل مخصص |
| `ENCRYPTION_KEY` | لا يمكن فك الحقول القديمة | استخدم تشفيرًا مغلّفًا (KMS) وأعد التشفير تدريجيًا |

## 7) استكشاف الأخطاء

| العَرَض | الاحتمال | الحل |
|---|---|---|
| 403 `db_permission_denied` | RLS: سياق منشأة/مريض مفقود | تحقق من `withTenant` ووجود `user_facilities` |
| 500 مع `requestId` | خطأ SQL/منطق | ابحث بـ `requestId` في السجلات (تُنقّح الأسرار) |
| `Migration … was modified` | تعديل ملف ترحيل مطبّق | أنشئ ترحيلًا جديدًا بدلًا من التعديل |
| 429 عند الدخول | قفل حساب/تجاوز الحد | انتظر مدة القفل أو أعد ضبط `locked_until` إداريًا |
