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
| GET | `/api/encounters?patientId=&status=open\|closed\|all` | `clinical.encounter.read` + علاقة علاجية/break-glass — زيارات مريض واحد فقط (تُستخدم لربط طلب الدم بزيارة مفتوحة) |
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

## الطوارئ والفرز

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/emergency/board` | الحالات النشطة مرتبة حسب الخطورة ثم الوصول + دقائق الانتظار + آخر علامات |
| POST | `/api/emergency/arrivals` | مريض معروف أو `unidentified` (رقم مؤقت `ER-…`)؛ مستوى 1–5؛ علامات أولية؛ مستوى ≤2 ينشئ تنبيهًا |
| POST | `/api/emergency/visits/:id/retriage` | `{level, reason}` — سبب إلزامي، يُسجَّل في التدقيق |
| POST | `/api/emergency/visits/:id/status` | `in_treatment` / `observation` |
| POST | `/api/emergency/visits/:id/disposition` | `admit` (يعيد استخدام نفس الزيارة) / `discharge` (ملخص + رسم زيارة) / `transfer` / `left_without_being_seen` |
| POST | `/api/emergency/patients/:id/identify` | مطابقة مجهول الهوية بسجل حقيقي بعد إغلاق الزيارة + دليل موثق |
| POST | `/api/emergency/encounters/:id/payment` | تحصيل على فاتورة الزيارة |

## التقارير والتصدير

`GET /api/reports` (قائمة) · `GET /api/reports/:key?from=&to=&format=json|csv` حيث key ∈ `visits|lab-results|revenue|occupancy`.
- `format=csv` يتطلب صلاحية إضافية `report.export`، ويُسجَّل `report.export` في التدقيق مع عدد الصفوف والفترة.
- CSV يبدأ بـ BOM (Excel عربي) وتُحايد الخلايا التي تبدأ بـ `= + - @` لمنع حقن الصيغ.
- تقرير الإيرادات يتطلب `report.finance` (فصل الأدوار السريرية عن المالية).

## العناية المركزة

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/icu/board` | إقامات نشطة: السرير، آخر علامات، وضع التنفس وFiO₂/PEEP، آخر SOFA، حالة حزمة اليوم |
| POST | `/api/icu/stays` | `icu.manage` — يتطلب تنويمًا نشطًا على سرير `ward_type='icu'` ويمنع إقامتين لنفس التنويم |
| GET | `/api/icu/stays/:id` | الملف: القياسات، إصدارات التنفس، الحزم اليومية، الدرجات |
| POST | `/api/icu/stays/:id/observations` | `icu.chart` — قياس واحد على الأقل؛ السجل ملحق (trigger يمنع التعديل والحذف) |
| POST | `/api/icu/stays/:id/ventilator` | `icu.ventilator` — وضع/ FiO₂/ PEEP/ حجم مد/ معدل، كل تغيير إصدار جديد |
| POST | `/api/icu/stays/:id/goals` | `icu.chart` — حزمة الرعاية اليومية (سجل واحد لكل يوم، التحديث مدقق) |
| POST | `/api/icu/stays/:id/sofa` | `icu.chart` — SOFA محسوب على الخادم من الفسيولوجيا؛ يتطلب علامات حيوية خلال ٦ ساعات |
| POST | `/api/icu/stays/:id/discharge` | `icu.discharge` — جهة النقل + ملاحظة ≥ ١٥ حرفًا؛ يجمّد الملف |

**حدود:** لا تكامل مع أجهزة المراقبة أو أجهزة التنفس، ولا حساب APACHE/SAPS؛ SOFA فقط وهو محسوب من مدخلات مسجلة يدويًا.

## العمليات والتخدير

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/surgery/theatres` | غرف العمليات المفعّلة |
| GET | `/api/surgery/board` | جدول العمليات النشطة + إحصاءات (قيد العملية/الإفاقة/مجدولة/مكتملة اليوم) + تعريف بنود قوائم التحقق |
| POST | `/api/surgery/cases` | جدولة `{patientId, encounterId, theatreId, procedureName, scheduledAt, estimatedMinutes, surgeonId?, anesthesiologistId?, priority, anesthesiaType}` — تُرفض عند تقاطع الأوقات |
| GET | `/api/surgery/cases/:id` | الملف الكامل: القوائم، قياسات التخدير، الإفاقة |
| POST | `/api/surgery/cases/:id/checklists` | `{phase:'sign_in'|'time_out', items}` — كل البنود الإلزامية مطلوبة، والمرة الواحدة فقط |
| POST | `/api/surgery/cases/:id/start` | يتطلب قائمتي التحقق وزيارة مفتوحة |
| POST | `/api/surgery/cases/:id/anesthesia` | `anesthesia.perform` فقط؛ سجل ملحق |
| POST | `/api/surgery/cases/:id/close` | `{signOut, counts:{instruments,sponges,needles:{expected,actual}}, discrepancyNote?}` — تُحتسب رسوم العملية والتخدير |
| POST | `/api/surgery/cases/:id/recovery` | ألدريتي ≥ ٨، وجهة النقل؛ تُكمل العملية |
| POST | `/api/surgery/cases/:id/cancel` | مسموح قبل الشق فقط وبسبب موثق |

**حدود:** لا تكامل مع أجهزة التخدير أو PACS أو نظام تعقيم؛ الجدولة والسجلات والرسوم فقط.

## التمريض

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/nursing/board` | لوحة الجناح: الأسرّة، آخر علامات حيوية، الجرعة القادمة/المتأخرة، مهام الرعاية المستحقة |
| GET | `/api/nursing/witnesses` | الممرضون الذين يملكون `nursing.witness` في المنشأة |
| GET | `/api/nursing/patients/:id/mar` | الجرعات المستحقة (محسوبة من `interval_hours`) وسجل الإعطاء |
| POST | `/api/nursing/mar` | `{prescriptionItemId, status, doseGiven, route, identityVerified, allergyChecked, witnessUserId?, reason?}` |
| POST | `/api/nursing/mar/:id/correct` | إلحاق تصحيح مرتبط بالسجل الأصلي (لا تعديل ولا حذف) |
| GET/POST | `/api/nursing/care-plans` · `POST /api/nursing/care-plan-tasks/:id/complete` · `POST /api/nursing/care-plans/:id/close` | خطة رعاية بمهام مجدولة؛ التخطي يتطلب سببًا |
| GET/POST | `/api/nursing/handovers` · `POST /api/nursing/handovers/:id/acknowledge` | تسليم مناوبة SBAR ثابت لا يُعدّل؛ الاستلام يسجّل باسم المستلم |

**ضوابط سريرية مفروضة في الخادم:**
- لا إعطاء قبل صرف الصيدلي (`prescription_items.status = 'dispensed'`)، ولا على زيارة مغلقة.
- الإعطاء يتطلب التحقق من هوية المريض ومن الحساسية، وتسجيل الجرعة والمسار.
- سجل واحد لكل فترة (`scheduled_for`) + حد أدنى للفاصل بين جرعتين = نصف الفترة الموصوفة.
- الأدوية عالية الخطورة (`drugs.is_high_alert` أو المقيدة) تتطلب شاهدًا ثانيًا يملك `nursing.witness` ولا يكون منفّذ الإعطاء.
- `medication_administrations` ملحق فقط (trigger يرفض UPDATE/DELETE)؛ التصحيح سجل جديد عبر `corrects_id`.

## الأشعة

| Method | Path | ملاحظات |
|---|---|---|
| POST | `/api/encounters/:id/imaging-orders` | `{modality, bodyPart, indication, priority}` — يتطلب `radiology.order` وزيارة مفتوحة |
| GET | `/api/radiology/worklist?status=` | طابور مرتب بالأولوية (stat ثم urgent ثم routine) ثم وقت الطلب |
| GET | `/api/radiology/orders/:id` | تفاصيل الطلب وكل إصدارات التقرير |
| POST | `/api/radiology/orders/:id/start` | فني الأشعة — ordered → in_progress |
| POST | `/api/radiology/orders/:id/perform` | فني الأشعة — إنهاء التصوير |
| POST | `/api/radiology/orders/:id/reports` | أخصائي الأشعة — مسودة (إصدار جديد عند وجود تقرير معتمد) |
| POST | `/api/radiology/reports/:id/finalize` | اعتماد نهائي: يقفل التقرير، يحوّل الطلب إلى verified، وينشئ رسم الفحص حسب `pricing.imaging_<modality>` |
| POST | `/api/radiology/reports/:id/acknowledge` | استلام نتيجة حرجة (يتطلب `radiology.critical.ack`) |
| POST | `/api/radiology/orders/:id/cancel` | سبب إلزامي، وقبل إتمام التصوير فقط |

التقرير المعتمد غير قابل للتعديل أو الحذف على مستوى قاعدة البيانات (trigger)؛ التصحيح يكون بإصدار جديد مرتبط بالأصل عبر `amended_from`.
**حدود معلنة:** لا يوجد تكامل DICOM/PACS ولا أرشفة صور — النظام يغطي الطلب والتنفيذ والتقرير والرسوم فقط.

## بنك الدم

| Method | Path | ملاحظات |
|---|---|---|
| GET | `/api/bloodbank/stock` | `bloodbank.read` — شبكة المكوّن×الفصيلة، الوحدات المتاحة/المحجوزة/المصروفة مع الصلاحية والأيام المتبقية، وإجماليات (متاح/منتهي/محجوز/مصروف/نُقل اليوم) |
| GET | `/api/bloodbank/second-checkers` | `bloodbank.transfuse` — الموظفون الحاملون لصلاحية النقل في المنشأة (لتغذية اختيار المدقق الثاني فقط) |
| POST | `/api/bloodbank/donors` | `bloodbank.stock` — `{bloodType, hemoglobin?, hbvNegative, hcvNegative, hivNegative, syphilisNegative, units:[{component, volumeMl?, expiresInDays?}]}`؛ أي فحص إيجابي ⇒ تبرع غير مؤهل ووحداته `discarded` تلقائيًا. صلاحية افتراضية: rbc ٤٢ · ffp ٣٦٥ · platelets ٥ · cryo ٣٦٥ يومًا |
| POST | `/api/bloodbank/requests` | `bloodbank.request` — `{patientId, encounterId, component, unitsRequested, urgency, indication, hbValue?, plateletsValue?}`؛ يتطلب فصيلة دم مسجلة وزيارة مفتوحة وطلبًا مفتوحًا واحدًا لكل مريض |
| GET | `/api/bloodbank/requests?status=active\|all\|<status>` | قائمة الطلبات مرتبة بالخطورة مع عدد الوحدات المنقولة والمطابقات |
| GET | `/api/bloodbank/requests/:id/compatible-units` | `bloodbank.crossmatch` — كل وحدات المكوّن المتاحة مع حكم التوافق وسببه |
| GET | `/api/bloodbank/requests/:id/reserved-units` | `bloodbank.issue` — الوحدات المحجوزة لهذا الطلب ونتيجة فحصها |
| POST | `/api/bloodbank/requests/:id/crossmatch` | `bloodbank.crossmatch` — `{unitId, method:'gel'\|'tube'\|'electronic', forceIncompatible?, note?}`؛ الوحدة غير المتوافقة تُرفض إلا بتجاوز موثق بملاحظة، والتجاوز **لا يسمح بالصرف** |
| POST | `/api/bloodbank/requests/:id/issue` | `bloodbank.issue` — يتطلب حجزًا لهذا المريض وفحص توافق ناجحًا ووحدة غير منتهية |
| POST | `/api/bloodbank/units/:id/transfuse` | `bloodbank.transfuse` — `{requestId, secondCheckerId, consentConfirmed:true, preHeartRate?, preSystolicBp?, preTemperatureC?, preSpo2?}`؛ المدقق الثاني يجب أن يختلف عن المنفّذ ويحمل الصلاحية |
| POST | `/api/bloodbank/transfusions/:id/complete` | `{outcome:'completed'\|'stopped_reaction'\|'stopped_other', volumeTransfusedMl, notes?}`؛ يكمل الطلب عند اكتمال عدد الوحدات |
| POST | `/api/bloodbank/transfusions/:id/reactions` | `bloodbank.reaction` — تفاعل واحد لكل نقل؛ المتوسط/الشديد يتطلب إغلاق النقل أولًا؛ الوحدة تُستبعد تلقائيًا |
| GET | `/api/bloodbank/units/:id` | تفاصيل الوحدة: المتبرع والفحوص، فحوص التوافق، سجلات النقل والتفاعل |
| POST | `/api/bloodbank/units/:id/discard` | `bloodbank.stock` — سبب ≥ ٥ أحرف؛ الوحدات المصروفة/المنقولة لا تُستبعد |

**قواعد التوافق (خادم):** كريات حمراء O→O · A→A,O · B→B,O · AB→الكل؛ البلازما والراسب القري معكوسة (O→الكل · A→A,AB · B→B,AB · AB→AB)؛ Rh سالب لا يستقبل موجبًا في الكريات والصفائح. **الحدود:** لا فحص أجسام مضادة أو معايرة عيار، لا مطابقة إلكترونية تتجاوز قرارًا سريريًا، لا ترميز ISBT 128، لا تكامل مع مورّد أو بنك دم وطني.

**فصل المهام:** طلب الدم (`bloodbank.request`) ≠ فحص التوافق والصرف (`bloodbank.crossmatch`/`bloodbank.issue`، تقني بنك الدم) ≠ النقل (`bloodbank.transfuse`، تمريض) مع مدقق ثانٍ مختلف. كل خطوة تُسجَّل في التدقيق، وسجلات المطابقة والنقل والتفاعل ملحقة (لا تُعدّل).

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
