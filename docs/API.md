# واجهات API

كل المسارات تحت `/api` (عدا FHIR). الاستجابات JSON، والأخطاء موحدة:

```json
{ "error": { "code": "conflict", "message": "…", "details": {...} }, "requestId": "uuid" }
```

## قواعد عامة

| القاعدة | التفصيل |
|---|---|
| المصادقة | Cookie `hms_session` (httpOnly). الجلسات خادمية وقابلة للإبطال. |
| CSRF | كل `POST/PATCH/PUT/DELETE` يتطلب رأس `x-csrf-token` (تُعيده `/api/auth/me`). |
| Origin | إن وُجد `Origin` يجب أن يطابق `Host`. |
| Idempotency | `Idempotency-Key` مطلوب عمليًا لـ `POST /api/billing/invoices/:id/payments` و`POST /api/pharmacy/dispense`. إعادة الإرسال بنفس المفتاح ونفس الجسم تُعيد نفس الاستجابة مع `replayed: true`. |
| HITL | لا قرارات طبية آلية؛ الوصفات والاعتمادات بشر. |
| التصدير/الطباعة | تسجل في سجل التدقيق. |
| الصلاحيات | كل مسار محمي بصلاحية صريحة؛ غيابها = 403 `forbidden`. |

## المصادقة

| Method | Path | الوصف |
|---|---|---|
| POST | `/api/auth/login` | `{email,password}` → `{ok,mfaRequired,csrfToken}` + Cookie. 401 `/invalid_credentials`، 429 عند القفل/التجاوز |
| POST | `/api/auth/logout` | إبطال الجلسة الحالية |
| GET | `/api/auth/me` | المستخدم، الأدوار، الصلاحيات، المنشآت، حالة MFA، `csrfToken` |
| POST | `/api/auth/mfa/setup` \| `/mfa/confirm` \| `/mfa/verify` | تسجيل/تأكيد/تحقق TOTP (200 مع `recoveryCodes` مرة واحدة) |
| POST | `/api/auth/password` | تغيير كلمة المرور (يُبطل الجلسات) |
| GET/POST | `/api/auth/sessions`, `/api/auth/sessions/:id/revoke` | الجلسات النشطة وإبطالها |
| POST | `/api/auth/context` | تبديل المنشأة `{facilityId}` (ضمن عضويات المستخدم) |

## المرضى

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/patients?search=&page=&limit=` | هوية/جوال مُقنّعان للجميع؛ `nationalId` الكامل لا يُعاد في القوائم |
| POST | `/api/patients` | 409 `conflict` مع `details.candidates` عند تشابه الاسم/الميلاد، أو عند تكرار الهوية. `acknowledgeDuplicate=true` للمتابعة بعد المراجعة |
| GET | `/api/patients/:id` | يجمع الملف؛ يتطلب `patient.chart.clinical` أو `administrative`; يسجل في `patient_access_log`؛ 403 عند انعدام العلاقة |
| PATCH | `/api/patients/:id` | يتطلب `version` (Optimistic concurrency) → 409 عند التعارض |
| POST | `/api/patients/:id/allergies` \| `/conditions` | إضافة سجل سريري (بتدقيق) |
| POST | `/api/patients/:id/break-glass` | `{reason}` ≥10 أحرف → منح 15 دقيقة + تنبيه إداري + تدقيق |
| POST | `/api/patients/:id/merge` | `{sourceId, reason}`؛ نقل كل السجلات، تعليم المصدر `merged` |
| GET | `/api/patients/:id/access-log` | يتطلب `audit.read` |

## المواعيد والاستقبال

`GET/POST /api/appointments` (منع تعارض الطبيب بفهرس فريد), `POST /api/appointments/:id/check-in`, `POST /api/appointments/:id/cancel`, `GET /api/reception/queue`.

## الزيارة (العيادة)

| Method | Path | الحالات |
|---|---|---|
| POST | `/api/encounters` | زيارة مفتوحة واحدة/مريض → 409 إن وُجدت |
| GET | `/api/encounters/:id` | يضم الحيوية/الملاحظات/التشخيصات/الطلبات/الوصفات/الفواتير |
| POST | `/api/encounters/:id/vitals` \| `/notes` \| `/diagnoses` | |
| POST | `/api/encounters/:id/lab-orders` | يُنشئ بنود + فاتورة لكل تحليل (ذريًا) |
| POST | `/api/encounters/:id/prescriptions` | 409 مع `warnings` عند حساسية؛ `allergyAcknowledged=true` لتجاوز موثق |
| POST | `/api/encounters/:id/close` | إغلاق + بند استشارة + إرجاع `pendingLabItems` |

## المختبر

`GET /api/lab/worklist?status=`, `POST /api/lab/items/:id/collect` (باركود), `POST /api/lab/items/:id/result` (`flag` يُحسب، قيمة حرجة → تنبيه), `POST /api/lab/items/:id/verify` (**يرفض** نفس مستخدم الإدخال), `POST /api/lab/results/:id/amend` (سجل تصحيح إلزامي), `GET /api/lab/alerts`, `POST /api/lab/alerts/:id/ack`.

## الصيدلية

`GET /api/pharmacy/prescriptions`, `GET /api/pharmacy/prescriptions/:id` (تحذيرات حساسية/تفاعل + مخزون)، `POST /api/pharmacy/dispense` (FEFO، خصم ذري، فاتورة، Idempotency)، `GET/POST /api/pharmacy/stock[/receive]`, `GET /api/pharmacy/movements`.

## الفوترة

`GET /api/billing/invoices[/:id]`, `POST /api/billing/invoices/:id/payments` (يمنع الدفع الزائد → 409)، `POST /api/billing/invoices/:id/void` (يمنع إلغاء مدفوعة)، `POST /api/billing/invoices/:id/claims` (داخلي فقط، لا إرسال)، `GET /api/billing/summary`.

## الإدارة والتدقيق

`GET/POST/PATCH /api/admin/users`, `GET /api/admin/roles`, `GET/POST /api/admin/sessions[/:id/revoke]`, `GET /api/admin/facilities`, `GET /api/audit` (فلاتر), `GET /api/audit/verify` → `{ok,checked}`.

## Meta / Portal / FHIR

- `GET /api/meta/bootstrap` — أقسام/أطباء/تحاليل/أدوية/تسعير (مصدر واحد للواجهة).
- `GET /api/meta/modules` — حالة الوحدات الصادقة.
- `GET /api/portal/summary` — للمريض فقط، عبر دور `hms_portal` + RLS؛ النتائج المعتمدة فقط.
- `GET /fhir/metadata`, `/fhir/Patient`, `/fhir/Observation?patient=` — **تغطية جزئية غير معتمدة**.

## رموز الأخطاء

| الكود | HTTP | المعنى |
|---|---|---|
| `unauthorized` | 401 | لا جلسة صالحة |
| `invalid_credentials` | 401 | بيانات دخول خاطئة |
| `invalid_mfa_code` | 401 | رمز MFA خاطئ |
| `forbidden` | 403 | لا صلاحية / لا علاقة علاجية |
| `csrf_failed` | 403 | رمز CSRF ناقص/خاطئ |
| `origin_rejected` | 403 | Origin لا يطابق Host |
| `mfa_required` | 403 | يجب إكمال MFA |
| `db_permission_denied` | 403 | رفض RLS/صلاحيات قاعدة البيانات |
| `not_found` | 404 | العنصر غير موجود |
| `conflict` / `duplicate` | 409 | تعارض حالة/تكرار |
| `invalid_data` / `validation_error` | 422/400 | انتهاك قيود/مدخلات |
| `rate_limited` | 429 | تجاوز الحد |
| `internal_error` | 500 | خطأ غير متوقع مع `requestId` للمتابعة |
