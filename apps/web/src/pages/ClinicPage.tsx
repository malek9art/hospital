import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  PollingControl,
  Select,
  useToast,
} from '../components';
import { useBootstrap } from '../hooks/useBootstrap';
import { usePolling } from '../hooks/usePolling';
import { navigate } from '../hooks/useHashRoute';
import { formatDateTime } from '../lib/format';

export default function ClinicPage({ auth, routeId }: { auth: Me; routeId: string | null }) {
  const toast = useToast();
  const { data: boot } = useBootstrap();
  const canReadAppts = has(auth, 'appointment.read');

  const [appts, setAppts] = useState<any[]>([]);
  const [openEncounters, setOpenEncounters] = useState<any[]>([]);
  const [enc, setEnc] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const [vitals, setVitals] = useState({ temperatureC: '', heartRate: '', systolicBp: '', diastolicBp: '', spo2: '' });
  const [soap, setSoap] = useState({ subjective: '', objective: '', assessment: '', plan: '' });
  const [dx, setDx] = useState({ icd10Code: '', description: '' });
  const [tests, setTests] = useState<string[]>([]);
  const [priority, setPriority] = useState('routine');
  const [rx, setRx] = useState({ drugId: '', dose: '', route: 'فموي', frequency: '', durationDays: '5', quantity: '10', ackAllergy: false });
  const [img, setImg] = useState({ modality: 'xray', bodyPart: '', indication: '', priority: 'routine' });

  const loadQueue = useCallback(async () => {
    setErr(null);
    try {
      if (canReadAppts) {
        const a = await api<{ items: any[] }>('/api/appointments?limit=50');
        setAppts(a.items ?? []);
      } else {
        const list = await api<{ items: any[] }>('/api/encounters?status=open&limit=50');
        setOpenEncounters(list.items ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل قائمة العيادة');
    } finally {
      setLoading(false);
    }
  }, [canReadAppts]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const polling = usePolling(loadQueue, { intervalMs: 25_000, enabled: !enc });

  // Deep-link support: #/clinic/:encounterId
  useEffect(() => {
    if (!routeId) {
      setEnc(null);
      return;
    }
    api(`/api/encounters/${routeId}`)
      .then(setEnc)
      .catch((e: Error) => toast.error(e.message));
  }, [routeId, toast]);

  async function refreshEncounter() {
    if (enc?.encounter?.id) {
      setEnc(await api(`/api/encounters/${enc.encounter.id}`));
    }
  }

  async function start(a: any) {
    try {
      const r = await api<{ id: string; encounterNo: string }>('/api/encounters', {
        method: 'POST',
        body: JSON.stringify({
          patientId: a.patientId,
          appointmentId: a.id,
          encounterType: 'outpatient',
          departmentId: a.departmentId ?? boot?.departments[0]?.id,
        }),
      });
      toast.success(`بدأت الزيارة السريرية ${r.encounterNo}`);
      navigate(`#/clinic/${r.id}`);
    } catch (ex) {
      const ae = ex as ApiError;
      const existingId = (ae.details as { encounterId?: string })?.encounterId;
      if (existingId) {
        toast.info('تم فتح الزيارة النشطة المرتبطة بالموعد');
        navigate(`#/clinic/${existingId}`);
      } else {
        toast.error(ae.message);
      }
    }
  }

  async function post(path: string, body: unknown, msg: string) {
    if (!enc) return;
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      toast.success(msg);
      await refreshEncounter();
    } catch (ex) {
      const ae = ex as ApiError;
      const warns = (ae.details as { warnings?: Array<{ message: string }> })?.warnings;
      toast.error(ae.message + (warns?.length ? ` — ${warns.map((w) => w.message).join(' | ')}` : ''));
      throw ex;
    }
  }

  if (err && !enc && appts.length === 0 && openEncounters.length === 0) {
    return <ErrorState message={err} onRetry={loadQueue} />;
  }
  if (loading && !enc) return <PageSkeleton cards={2} rows={6} />;

  const e = enc?.encounter;

  return (
    <div className="space-y-4">
      <PageHeader
        title="عيادة الطبيب والزيارات السريرية"
        subtitle="توثيق العلامات الحيوية، التشخيص، ملاحظات SOAP، وطلبات المختبر والأشعة والوصفات."
        actions={
          !e ? (
            <PollingControl
              enabled={polling.enabled}
              onToggle={polling.setEnabled}
              lastUpdatedAt={polling.lastUpdatedAt}
              busy={polling.busy}
              onRefresh={polling.refreshNow}
            />
          ) : (
            <Button variant="ghost" onClick={() => navigate('#/clinic')}>
              ← العودة إلى القائمة
            </Button>
          )
        }
      />

      {!e && canReadAppts && (
        <Card title="قائمة مواعيد العيادة">
          <DataTable
            caption="قائمة انتظار العيادة"
            rows={appts}
            rowKey={(a) => a.id}
            emptyTitle="لا توجد مواعيد مسجلة حاليًا"
            cardTitle={(a) => a.patientName}
            cardSubtitle={(a) => `${a.appointmentNo} · ${formatDateTime(a.scheduledAt)}`}
            cardBadge={(a) => <Badge value={a.status} />}
            cardActions={(a) =>
              ['booked', 'checked_in'].includes(a.status) && has(auth, 'clinical.encounter.create') ? (
                <Button variant="primary" size="sm" onClick={() => start(a)}>
                  بدء الاستشارة
                </Button>
              ) : null
            }
            columns={[
              { key: 'no', header: 'رقم الموعد', render: (a) => <span className="font-mono text-xs">{a.appointmentNo}</span> },
              { key: 'pt', header: 'المريض', render: (a) => <span className="font-semibold">{a.patientName}</span> },
              { key: 'time', header: 'الوقت', render: (a) => formatDateTime(a.scheduledAt) },
              { key: 'st', header: 'الحالة', render: (a) => <Badge value={a.status} /> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (a) =>
                  ['booked', 'checked_in'].includes(a.status) && has(auth, 'clinical.encounter.create') ? (
                    <Button variant="primary" size="sm" onClick={() => start(a)}>
                      بدء الاستشارة
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {!e && !canReadAppts && (
        <Card title="الزيارات السريرية المفتوحة">
          <DataTable
            caption="الزيارات المفتوحة"
            rows={openEncounters}
            rowKey={(x) => x.id}
            emptyTitle="لا توجد زيارات مفتوحة حاليًا"
            cardTitle={(x) => x.patient_name ?? x.encounter_no}
            cardSubtitle={(x) => `${x.encounter_no} · ${x.department_name ?? ''}`}
            cardBadge={(x) => <Badge value={x.status} />}
            cardActions={(x) => (
              <Button variant="ghost" size="sm" onClick={() => navigate(`#/clinic/${x.id}`)}>
                فتح الزيارة
              </Button>
            )}
            columns={[
              { key: 'no', header: 'رقم الزيارة', render: (x) => <span className="font-mono text-xs">{x.encounter_no}</span> },
              { key: 'pt', header: 'المريض', render: (x) => x.patient_name ?? '—' },
              { key: 'dept', header: 'القسم', render: (x) => x.department_name ?? '—' },
              { key: 'time', header: 'بدأت', render: (x) => formatDateTime(x.started_at) },
              { key: 'st', header: 'الحالة', render: (x) => <Badge value={x.status} /> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (x) => (
                  <Button variant="ghost" size="sm" onClick={() => navigate(`#/clinic/${x.id}`)}>
                    استعراض
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      {e && (
        <>
          <Card
            title={`زيارة ${e.encounterNo} — ${e.patient.nameAr}`}
            subtitle={`بدأت ${formatDateTime(e.startedAt)} · أساس الوصول: ${enc.accessBasis}`}
            action={<Badge value={e.status} />}
          >
            {e.status === 'open' && (
              <div className="grid lg:grid-cols-2 gap-3">
                {has(auth, 'clinical.vitals.write') && (
                  <Card title="العلامات الحيوية">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {(
                        [
                          ['temperatureC', 'الحرارة (°C)'],
                          ['heartRate', 'النبض (/د)'],
                          ['systolicBp', 'الضغط الانقباضي'],
                          ['diastolicBp', 'الضغط الانبساطي'],
                          ['spo2', 'الأكسجين SpO₂%'],
                        ] as const
                      ).map(([k, label]) => (
                        <Input
                          key={k}
                          label={label}
                          type="number"
                          step="0.1"
                          value={vitals[k]}
                          onChange={(ev) => setVitals({ ...vitals, [k]: ev.target.value })}
                        />
                      ))}
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        post(
                          `/api/encounters/${e.id}/vitals`,
                          Object.fromEntries(
                            Object.entries(vitals)
                              .filter(([, v]) => v !== '')
                              .map(([k, v]) => [k, Number(v)]),
                          ),
                          'تم تسجيل العلامات الحيوية',
                        ).catch(() => {})
                      }
                    >
                      تسجيل العلامات
                    </Button>
                  </Card>
                )}

                {has(auth, 'clinical.diagnosis.write') && (
                  <Card title="التشخيص الطبي (ICD-10)">
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        label="رمز ICD-10"
                        placeholder="I10"
                        dir="ltr"
                        value={dx.icd10Code}
                        onChange={(ev) => setDx({ ...dx, icd10Code: ev.target.value })}
                      />
                      <div className="col-span-2">
                        <Input
                          label="الوصف التشخيصي"
                          placeholder="ارتفاع ضغط الدم الأساسي"
                          value={dx.description}
                          onChange={(ev) => setDx({ ...dx, description: ev.target.value })}
                        />
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3"
                      disabled={!dx.icd10Code || !dx.description}
                      onClick={() =>
                        post(`/api/encounters/${e.id}/diagnoses`, { ...dx, type: 'primary' }, 'تم تسجيل التشخيص')
                          .then(() => setDx({ icd10Code: '', description: '' }))
                          .catch(() => {})
                      }
                    >
                      حفظ التشخيص
                    </Button>
                  </Card>
                )}

                {has(auth, 'clinical.note.write') && (
                  <Card title="الملاحظة السريرية (SOAP)">
                    <div className="space-y-2">
                      {(
                        [
                          ['subjective', 'الشكوى الذاتية (Subjective)'],
                          ['objective', 'الفحص الموضوعي (Objective)'],
                          ['assessment', 'التقييم السريري (Assessment)'],
                          ['plan', 'الخطة العلاجية (Plan)'],
                        ] as const
                      ).map(([k, label]) => (
                        <Input
                          key={k}
                          label={label}
                          value={soap[k]}
                          onChange={(ev) => setSoap({ ...soap, [k]: ev.target.value })}
                        />
                      ))}
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        post(`/api/encounters/${e.id}/notes`, { ...soap, sign: true }, 'تم حفظ الملاحظة السريرية وتوقيعها')
                          .then(() => setSoap({ subjective: '', objective: '', assessment: '', plan: '' }))
                          .catch(() => {})
                      }
                    >
                      حفظ وتوقيع إلكتروني
                    </Button>
                  </Card>
                )}

                {has(auth, 'lab.order.create') && (
                  <Card title="طلب تحاليل مخبرية">
                    <div className="space-y-1.5 max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2">
                      {(boot?.labTests ?? []).map((t) => (
                        <label key={t.code} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={tests.includes(t.code)}
                            onChange={(ev) =>
                              setTests(ev.target.checked ? [...tests, t.code] : tests.filter((x) => x !== t.code))
                            }
                          />
                          <span>{t.name_ar}</span>
                          <span className="text-xs text-slate-400 font-mono">{t.code}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-3 items-end">
                      <Select
                        label="الأولوية"
                        value={priority}
                        onChange={(ev) => setPriority(ev.target.value)}
                      >
                        <option value="routine">روتيني</option>
                        <option value="urgent">عاجل</option>
                        <option value="stat">فوري (STAT)</option>
                      </Select>
                      <Button
                        variant="primary"
                        disabled={!tests.length}
                        onClick={() =>
                          post(`/api/encounters/${e.id}/lab-orders`, { tests, priority }, 'تم إرسال طلب التحاليل')
                            .then(() => setTests([]))
                            .catch(() => {})
                        }
                      >
                        إرسال الطلب
                      </Button>
                    </div>
                  </Card>
                )}

                {has(auth, 'radiology.order') && (
                  <Card title="طلب تصوير إشعاعي">
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="نوع الفحص"
                        value={img.modality}
                        onChange={(ev) => setImg({ ...img, modality: ev.target.value })}
                      >
                        <option value="xray">أشعة سينية</option>
                        <option value="ct">أشعة مقطعية (CT)</option>
                        <option value="mri">رنين مغناطيسي (MRI)</option>
                        <option value="us">موجات فوق صوتية</option>
                        <option value="mammography">ماموغرام</option>
                        <option value="fluoroscopy">فلوروسكوبي</option>
                        <option value="panoramic">بانوراما الأسنان (OPG)</option>
                      </Select>
                      <Input
                        label="المنطقة التشريحية"
                        value={img.bodyPart}
                        onChange={(ev) => setImg({ ...img, bodyPart: ev.target.value })}
                        placeholder="الصدر"
                      />
                      <div className="col-span-2">
                        <Input
                          label="المبرر السريري"
                          value={img.indication}
                          onChange={(ev) => setImg({ ...img, indication: ev.target.value })}
                          placeholder="سعال حاد وحمى لاستبعاد التهاب رئوي"
                        />
                      </div>
                      <Select
                        label="الأولوية"
                        value={img.priority}
                        onChange={(ev) => setImg({ ...img, priority: ev.target.value })}
                      >
                        <option value="routine">روتيني</option>
                        <option value="urgent">عاجل</option>
                        <option value="stat">فوري (STAT)</option>
                      </Select>
                      <div className="flex items-end">
                        <Button
                          variant="primary"
                          className="w-full"
                          disabled={img.bodyPart.length < 2 || img.indication.length < 5}
                          onClick={() =>
                            post(`/api/encounters/${e.id}/imaging-orders`, img, 'تم إرسال طلب الأشعة')
                              .then(() => setImg({ ...img, bodyPart: '', indication: '' }))
                              .catch(() => {})
                          }
                        >
                          إرسال طلب الأشعة
                        </Button>
                      </div>
                    </div>
                  </Card>
                )}

                {has(auth, 'clinical.prescription.create') && (
                  <Card title="وصفة طبية إلكترونية">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <Select
                          label="الدواء"
                          value={rx.drugId}
                          onChange={(ev) => setRx({ ...rx, drugId: ev.target.value })}
                        >
                          <option value="">— اختر الدواء —</option>
                          {(boot?.drugs ?? []).map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name_ar} ({d.strength})
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Input
                        label="الجرعة"
                        value={rx.dose}
                        onChange={(ev) => setRx({ ...rx, dose: ev.target.value })}
                        placeholder="500mg"
                      />
                      <Input
                        label="التكرار"
                        value={rx.frequency}
                        onChange={(ev) => setRx({ ...rx, frequency: ev.target.value })}
                        placeholder="كل 8 ساعات"
                      />
                      <Input
                        label="المدة (أيام)"
                        type="number"
                        value={rx.durationDays}
                        onChange={(ev) => setRx({ ...rx, durationDays: ev.target.value })}
                      />
                      <Input
                        label="الكمية"
                        type="number"
                        value={rx.quantity}
                        onChange={(ev) => setRx({ ...rx, quantity: ev.target.value })}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600 mt-2">
                      <input
                        type="checkbox"
                        checked={rx.ackAllergy}
                        onChange={(ev) => setRx({ ...rx, ackAllergy: ev.target.checked })}
                      />
                      مراجعة وتأكيد تنبيه الحساسية عند الضرورة السريرية
                    </label>
                    <Button
                      variant="primary"
                      size="sm"
                      className="mt-3"
                      disabled={!rx.drugId}
                      onClick={() =>
                        post(
                          `/api/encounters/${e.id}/prescriptions`,
                          {
                            items: [
                              {
                                drugId: rx.drugId,
                                dose: rx.dose || '1',
                                route: rx.route,
                                frequency: rx.frequency || 'يوميًا',
                                durationDays: Number(rx.durationDays),
                                quantity: Number(rx.quantity),
                              },
                            ],
                            allergyAcknowledged: rx.ackAllergy,
                          },
                          'تم إصدار الوصفة الطبية',
                        ).catch(() => {})
                      }
                    >
                      إصدار الوصفة
                    </Button>
                  </Card>
                )}

                {has(auth, 'clinical.encounter.close') && (
                  <Card title="إغلاق الزيارة السريرية">
                    <p className="text-xs text-slate-600 mb-3">
                      يؤدي الإغلاق إلى قفل الزيارة وتوليد فاتورة الخدمات تلقائيًا (رسوم الاستشارة والفحوص المسجلة).
                    </p>
                    <Button variant="danger" onClick={() => setCloseConfirmOpen(true)}>
                      إغلاق الزيارة وإنشاء الفاتورة
                    </Button>
                  </Card>
                )}
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-3 gap-3">
            <Card title="آخر العلامات الحيوية">
              {enc.vitals.length === 0 ? (
                <EmptyState title="لا علامات مسجلة" />
              ) : (
                <ul className="text-sm space-y-1">
                  {enc.vitals.slice(0, 4).map((v: any) => (
                    <li key={v.id}>
                      {formatDateTime(v.recorded_at)} — {v.heart_rate ?? '—'} نبضة، {v.temperature_c ?? '—'}°
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="طلبات المختبر في الزيارة">
              {enc.labOrders.length === 0 ? (
                <EmptyState title="لا طلبات تحاليل" />
              ) : (
                <ul className="text-sm space-y-1">
                  {enc.labOrders.map((l: any) => (
                    <li key={l.id} className="flex items-center justify-between">
                      <span className="font-mono text-xs">{l.order_no}</span>
                      <Badge value={l.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="الوصفات الصادرة">
              {enc.prescriptions.length === 0 ? (
                <EmptyState title="لا وصفات مسجلة" />
              ) : (
                <ul className="text-sm space-y-1">
                  {enc.prescriptions.map((p: any) => (
                    <li key={p.id} className="flex items-center justify-between">
                      <span className="font-mono text-xs">{p.prescription_no}</span>
                      <Badge value={p.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <ConfirmDialog
        open={closeConfirmOpen}
        onClose={() => setCloseConfirmOpen(false)}
        title="تأكيد إغلاق الزيارة السريرية"
        description="بعد إغلاق الزيارة لا يمكن إضافة أوامر جديدة عليها، وستُنشأ فاتورة بالخدمات المسجلة."
        confirmLabel="تأكيد الإغلاق"
        variant="danger"
        onConfirm={async () => {
          if (!e) return;
          await post(`/api/encounters/${e.id}/close`, { disposition: 'متابعة في العيادة' }, 'تم إغلاق الزيارة وإنشاء الفاتورة');
        }}
      />
    </div>
  );
}
