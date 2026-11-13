import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  ReasonDialog,
  Select,
  StatCard,
  useToast,
} from '../components';
import { formatDateTime, formatIsoDate } from '../lib/format';

const DIET_LABELS: Record<string, string> = {
  regular: 'عادي',
  diabetic: 'سكري',
  renal: 'كلوي',
  low_sodium: 'قليل الصوديوم',
  soft: 'لين',
  liquid: 'سوائل صافية',
  npo: 'صائم (NPO)',
  enteral: 'تغذية أنبوبية',
  parenteral: 'تغذية وريدية',
};
const RISK_LABELS: Record<string, string> = { low: 'منخفض', medium: 'متوسط', high: 'مرتفع' };
const RESTRICTION_LABELS: Record<string, string> = {
  lactose_free: 'خالٍ من اللاكتوز',
  gluten_free: 'خالٍ من الغلوتين',
  nut_free: 'خالٍ من المكسرات',
  egg_free: 'خالٍ من البيض',
  fish_free: 'خالٍ من السمك',
  soy_free: 'خالٍ من الصويا',
  diabetic: 'سكري',
  low_sodium: 'قليل الصوديوم',
  renal: 'كلوي',
  low_fat: 'قليل الدهون',
};
const TOLERANCE_LABELS: Record<string, string> = { good: 'جيد', partial: 'جزئي', poor: 'ضعيف' };
const TUBE_LABELS: Record<string, string> = {
  ng: 'أنفي معدي (NG)',
  og: 'فموي معدي (OG)',
  peg: 'فغر معدة (PEG)',
  pej: 'فغر صائم (PEJ)',
  tpn: 'وريدي كلي (TPN)',
  ppn: 'وريدي جزئي (PPN)',
};

export default function NutritionPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const canReadBoard = has(auth, 'nutrition.read');
  const canKitchen = has(auth, 'nutrition.kitchen');
  const isDietitian = has(auth, 'nutrition.assess');

  const [board, setBoard] = useState<any>(null);
  const [kitchen, setKitchen] = useState<any>(null);
  const [file, setFile] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [screen, setScreen] = useState<Record<string, string>>({
    admissionId: '',
    weightKg: '',
    heightCm: '',
    weightLossPct: '0',
    intakeReduction: 'none',
    diseaseSeverity: 'none',
    actionTaken: '',
  });
  const [assess, setAssess] = useState<Record<string, string>>({
    admissionId: '',
    weightKg: '',
    heightCm: '',
    energyTargetKcal: '',
    proteinTargetG: '',
    fluidLimitMl: '',
    nutritionDiagnosis: '',
    plan: '',
    varianceReason: '',
  });
  const [order, setOrder] = useState({
    admissionId: '',
    dietType: 'diabetic',
    texture: '',
    restrictions: [] as string[],
    notes: '',
  });
  const [tube, setTube] = useState<Record<string, string>>({
    admissionId: '',
    route: 'ng',
    formulaName: '',
    kcalPerMl: '1',
    proteinGPerL: '40',
    rateMlHr: '40',
    hoursPerDay: '16',
    notes: '',
  });
  const [intake, setIntake] = useState({ pct: '60', refused: false, notes: '' });
  const [follow, setFollow] = useState({ weightKg: '', intakePctAvg: '', tolerance: 'good', note: '' });

  // Replaces window.prompt #4: Stop Tube Nutrition Order!
  const [stopTubeTarget, setStopTubeTarget] = useState<{ id: string; orderNo: string } | null>(null);

  const loadBoardOnly = useCallback(async () => {
    if (!canReadBoard) return;
    const b = await api<any>('/api/nutrition/board');
    setBoard(b);
  }, [canReadBoard]);

  const loadKitchenOnly = useCallback(async () => {
    if (!canKitchen) return;
    setKitchen(await api<any>('/api/nutrition/kitchen'));
  }, [canKitchen]);

  const loadPatientFile = useCallback(async (patientId: string) => {
    const f = await api<any>(`/api/nutrition/patients/${patientId}`);
    setFile(f);
  }, []);

  const initialLoad = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      await Promise.all([loadBoardOnly(), loadKitchenOnly()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات التغذية');
    } finally {
      setLoading(false);
    }
  }, [loadBoardOnly, loadKitchenOnly]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  // Targeted action runner: kitchen actions do NOT refetch open patient chart unless same patient!
  async function actChart(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await Promise.all([
        loadBoardOnly(),
        loadKitchenOnly(),
        file?.patient?.id ? loadPatientFile(file.patient.id) : Promise.resolve(),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function actKitchen(trayPatientId: string | undefined, fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await Promise.all([
        loadKitchenOnly(),
        canReadBoard ? loadBoardOnly() : Promise.resolve(),
        file?.patient?.id && file.patient.id === trayPatientId ? loadPatientFile(file.patient.id) : Promise.resolve(),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تحديث الصينية');
    } finally {
      setBusy(false);
    }
  }

  async function openPatient(row: any) {
    try {
      await loadPatientFile(row.patient_id);
      setScreen((s) => ({ ...s, admissionId: row.admission_id, weightKg: String(row.weight_kg ?? ''), heightCm: '' }));
      setAssess((a) => ({ ...a, admissionId: row.admission_id, weightKg: String(row.weight_kg ?? '') }));
      setOrder((o) => ({ ...o, admissionId: row.admission_id }));
      setTube((t) => ({ ...t, admissionId: row.admission_id }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح ملف التغذية');
    }
  }

  if (err && !board && !kitchen) return <ErrorState message={err} onRetry={initialLoad} />;
  if (loading && !board && !kitchen) return <PageSkeleton cards={5} rows={6} />;

  const admissions = board?.items ?? [];
  const selectedAdmission = admissions.find((a: any) => a.admission_id === screen.admissionId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="التغذية السريرية وخدمات المطبخ"
        subtitle="فحص خطر سوء التغذية (NRS)، تقييم الاحتياج، مطابقة قيود الحساسية، وتتبع صواني الوجبات."
      />

      {board && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="مرضى منوّمون" value={board.totals.inpatients} />
          <StatCard
            label="خطر تغذوي مرتفع"
            value={board.totals.high_risk}
            tone={board.totals.high_risk > 0 ? 'danger' : 'default'}
          />
          <StatCard label="صائمون (NPO)" value={board.totals.npo} tone="warning" />
          <StatCard label="بحاجة لفحص تغذوي" value={board.totals.needs_screening} />
          <StatCard label="بلا أمر تغذية" value={board.totals.without_diet} />
        </div>
      )}

      {board && (
        <Card title="لوحة التغذية العلاجية للمنوّمين">
          <DataTable
            caption="لوحة التغذية العلاجية"
            rows={admissions}
            rowKey={(a) => a.admission_id}
            rowClassName={(a) =>
              a.risk_level === 'high' ? 'bg-rose-50/60' : a.needs_screening ? 'bg-amber-50/50' : ''
            }
            emptyTitle="لا يوجد مرضى منوّمون حاليًا"
            cardTitle={(a) => a.patient_name}
            cardSubtitle={(a) => `${a.mrn} · ${a.ward_name ?? '—'} · ${a.diet_ar ?? 'بلا أمر تغذية'}`}
            cardBadge={(a) =>
              a.risk_level ? (
                <Badge
                  value={a.risk_level === 'high' ? 'critical_high' : a.risk_level === 'medium' ? 'suspected' : 'verified'}
                  label={`خطر ${RISK_LABELS[a.risk_level]}`}
                />
              ) : null
            }
            cardActions={(a) => (
              <Button variant="primary" size="sm" onClick={() => openPatient(a)}>
                فتح ملف التغذية
              </Button>
            )}
            columns={[
              {
                key: 'pt',
                header: 'المريض',
                render: (a) => (
                  <div>
                    <span className="font-semibold">{a.patient_name}</span>
                    <span className="block text-xs text-slate-400">
                      {a.mrn} · {a.age_years} سنة
                    </span>
                  </div>
                ),
              },
              {
                key: 'ward',
                header: 'الجناح',
                render: (a) => `${a.ward_name ?? '—'} ${a.room_no ? `${a.room_no}/${a.bed_no}` : ''}`,
              },
              {
                key: 'scr',
                header: 'آخر فحص',
                render: (a) =>
                  a.screening_date ? (
                    <div className="text-xs">
                      {formatIsoDate(a.screening_date)}
                      <span className="block text-slate-400">
                        BMI {Number(a.bmi)} · نقاط {a.screening_score}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-amber-700 font-semibold">لم يُفحص</span>
                  ),
              },
              {
                key: 'risk',
                header: 'الخطر',
                render: (a) =>
                  a.risk_level ? (
                    <Badge
                      value={a.risk_level === 'high' ? 'critical_high' : a.risk_level === 'medium' ? 'suspected' : 'verified'}
                      label={RISK_LABELS[a.risk_level]}
                    />
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'diet',
                header: 'أمر التغذية',
                render: (a) =>
                  a.diet_type ? (
                    <div className="text-xs">
                      <span className="font-semibold">{a.diet_ar}</span>
                      <span className="block text-slate-400">
                        {(a.restriction_labels ?? []).join(' · ') || 'بلا قيود'}
                      </span>
                    </div>
                  ) : (
                    <span className="text-slate-400 text-xs">لا يوجد</span>
                  ),
              },
              {
                key: 'trays',
                header: 'وجبات اليوم',
                render: (a) => (a.trays_total ? `${a.trays_done}/${a.trays_total} منجز` : '—'),
              },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (a) => (
                  <Button variant="ghost" size="sm" onClick={() => openPatient(a)}>
                    فتح الملف
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}

      {kitchen && (
        <Card
          title="خط تحضير وتسليم صواني المطبخ اليوم"
          subtitle={`مطلوبة: ${kitchen.totals.ordered} · محضّرة: ${kitchen.totals.prepared} · مُسلَّمة: ${kitchen.totals.delivered}`}
        >
          <DataTable
            caption="صواني الوجبات اليومية"
            rows={kitchen.items ?? []}
            rowKey={(t) => t.id}
            emptyTitle="لا توجد صواني وجبات مسجلة لليوم"
            cardTitle={(t) => `${t.tray_no} — ${t.meal_ar}`}
            cardSubtitle={(t) => `${t.patient_name} · ${t.diet_ar} (${t.kcal_planned} سعرة)`}
            cardBadge={(t) => <Badge value={t.status} />}
            cardActions={(t) => (
              <div className="flex gap-1.5">
                {canKitchen && t.status === 'ordered' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => actKitchen(t.patient_id, () => api(`/api/nutrition/trays/${t.id}/prepare`, { method: 'POST' }), 'حُضّرت الصينية')}
                  >
                    تحضير
                  </Button>
                )}
                {canKitchen && t.status === 'prepared' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => actKitchen(t.patient_id, () => api(`/api/nutrition/trays/${t.id}/deliver`, { method: 'POST' }), 'سُلّمت الصينية للجناح')}
                  >
                    تسليم
                  </Button>
                )}
                {has(auth, 'nutrition.intake') && t.status === 'delivered' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      actKitchen(
                        t.patient_id,
                        () =>
                          api(`/api/nutrition/trays/${t.id}/intake`, {
                            method: 'POST',
                            body: JSON.stringify({
                              consumedPct: Number(intake.pct),
                              refused: intake.refused,
                              notes: intake.notes || undefined,
                            }),
                          }),
                        'سُجّل استهلاك الوجبة',
                      )
                    }
                  >
                    استهلاك ({intake.pct}%)
                  </Button>
                )}
              </div>
            )}
            columns={[
              { key: 'no', header: 'الصينية', render: (t) => <span className="font-mono text-xs">{t.tray_no}</span> },
              { key: 'meal', header: 'الوجبة', render: (t) => t.meal_ar },
              {
                key: 'pt',
                header: 'المريض',
                render: (t) => (
                  <div>
                    <span className="font-semibold">{t.patient_name}</span>
                    <span className="block text-xs text-slate-400">
                      {t.mrn} · {t.ward_name ?? ''} {t.room_no ?? ''}
                    </span>
                  </div>
                ),
              },
              {
                key: 'diet',
                header: 'الحمية والقيود',
                render: (t) => (
                  <div className="text-xs">
                    {t.diet_ar}
                    <span className="block text-slate-400">{(t.restriction_labels ?? []).join(' · ') || '—'}</span>
                  </div>
                ),
              },
              { key: 'kcal', header: 'الطاقة', render: (t) => `${t.kcal_planned} سعرة` },
              { key: 'st', header: 'الحالة', render: (t) => <Badge value={t.status} /> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (t) => (
                  <div className="flex gap-1">
                    {canKitchen && t.status === 'ordered' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => actKitchen(t.patient_id, () => api(`/api/nutrition/trays/${t.id}/prepare`, { method: 'POST' }), 'حُضّرت الصينية')}
                      >
                        تحضير
                      </Button>
                    )}
                    {canKitchen && t.status === 'prepared' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => actKitchen(t.patient_id, () => api(`/api/nutrition/trays/${t.id}/deliver`, { method: 'POST' }), 'سُلّمت الصينية')}
                      >
                        تسليم
                      </Button>
                    )}
                    {has(auth, 'nutrition.intake') && t.status === 'delivered' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() =>
                          actKitchen(
                            t.patient_id,
                            () =>
                              api(`/api/nutrition/trays/${t.id}/intake`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  consumedPct: Number(intake.pct),
                                  refused: intake.refused,
                                  notes: intake.notes || undefined,
                                }),
                              }),
                            'سُجّل الاستهلاك',
                          )
                        }
                      >
                        استهلاك ({intake.pct}%)
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />

          {has(auth, 'nutrition.intake') && (
            <div className="flex flex-wrap items-end gap-3 mt-3 pt-3 border-t border-slate-100">
              <div className="w-32">
                <Input
                  label="نسبة الاستهلاك %"
                  type="number"
                  min={0}
                  max={100}
                  value={intake.pct}
                  onChange={(e) => setIntake({ ...intake, pct: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-xs pb-2.5">
                <input
                  type="checkbox"
                  checked={intake.refused}
                  onChange={(e) => setIntake({ ...intake, refused: e.target.checked })}
                />
                رفض الوجبة
              </label>
              <div className="flex-1 min-w-[200px]">
                <Input
                  label="ملاحظة استهلاك (اختياري)"
                  value={intake.notes}
                  onChange={(e) => setIntake({ ...intake, notes: e.target.value })}
                />
              </div>
            </div>
          )}
        </Card>
      )}

      {file && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card
            title={`ملف التغذية — ${file.patient.name} (${file.patient.mrn})`}
            action={
              <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                إغلاق
              </Button>
            }
          >
            <div className="text-xs space-y-1 text-slate-700">
              <p>
                الطاقة المستهلكة اليوم: <b>{file.today.kcalConsumed}</b> / {file.today.targetKcal} سعرة
              </p>
              <p>
                أمر التغذية النشط:{' '}
                {file.activeDiet
                  ? `${file.activeDiet.order_no} · ${file.activeDiet.dietAr}`
                  : 'لا يوجد أمر نشط'}
              </p>
              {file.requiredRestrictions.length > 0 && (
                <p className="text-rose-700 font-semibold">
                  قيود إلزامية من سجل الحساسية:{' '}
                  {file.requiredRestrictions
                    .map((r: any) => `${RESTRICTION_LABELS[r.code] ?? r.code} (${r.name})`)
                    .join(' · ')}
                </p>
              )}
              <p className="text-slate-500">{file.limits}</p>
            </div>

            <div className="mt-3 border-t border-slate-100 pt-2 text-xs space-y-1">
              <p className="font-bold">الفحوص والتقييمات المسجلة</p>
              {file.screenings.map((s: any) => (
                <p key={s.id}>
                  فحص {formatIsoDate(s.screening_date)}: نقاط {s.score} · {RISK_LABELS[s.risk_level]} · BMI {Number(s.bmi)}
                </p>
              ))}
              {file.assessments.map((a: any) => (
                <p key={a.id}>
                  تقييم {formatIsoDate(a.assessed_at)}: {a.energy_target_kcal} سعرة · {Number(a.protein_target_g)} غ بروتين
                </p>
              ))}
              {file.tubeOrders.map((t: any) => (
                <p key={t.id}>
                  {t.order_no}: {t.routeAr} · {t.formula_name} · {t.kcal_day} سعرة/يوم ({t.status})
                </p>
              ))}
              {file.followups.map((f: any) => (
                <p key={f.id}>
                  متابعة {formatDateTime(f.recorded_at)}: تحمل {TOLERANCE_LABELS[f.tolerance]} — {f.note}
                </p>
              ))}
            </div>
          </Card>

          <div className="space-y-3">
            {has(auth, 'nutrition.screen') && (
              <Card title="فحص خطر سوء التغذية (تمريض)">
                <div className="grid grid-cols-2 gap-2">
                  <Input label="الوزن (كغ)" value={screen.weightKg} onChange={(e) => setScreen({ ...screen, weightKg: e.target.value })} />
                  <Input label="الطول (سم)" value={screen.heightCm} onChange={(e) => setScreen({ ...screen, heightCm: e.target.value })} />
                  <Input label="فقد الوزن %" value={screen.weightLossPct} onChange={(e) => setScreen({ ...screen, weightLossPct: e.target.value })} />
                  <Input label="الإجراء المتخذ" value={screen.actionTaken} onChange={(e) => setScreen({ ...screen, actionTaken: e.target.value })} />
                  <Select label="تراجع الشهية" value={screen.intakeReduction} onChange={(e) => setScreen({ ...screen, intakeReduction: e.target.value })}>
                    <option value="none">طبيعي</option>
                    <option value="mild">خفيف</option>
                    <option value="moderate">متوسط</option>
                    <option value="severe">شديد</option>
                  </Select>
                  <Select label="شدة المرض" value={screen.diseaseSeverity} onChange={(e) => setScreen({ ...screen, diseaseSeverity: e.target.value })}>
                    <option value="none">بلا مرض حاد</option>
                    <option value="mild">خفيف</option>
                    <option value="moderate">متوسط</option>
                    <option value="severe">شديد</option>
                  </Select>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  busy={busy}
                  disabled={!selectedAdmission || !screen.weightKg || !screen.heightCm}
                  onClick={() =>
                    actChart(
                      () =>
                        api('/api/nutrition/screenings', {
                          method: 'POST',
                          body: JSON.stringify({
                            admissionId: screen.admissionId,
                            weightKg: Number(screen.weightKg),
                            heightCm: Number(screen.heightCm),
                            weightLossPct: Number(screen.weightLossPct || 0),
                            intakeReduction: screen.intakeReduction,
                            diseaseSeverity: screen.diseaseSeverity,
                            actionTaken: screen.actionTaken || undefined,
                          }),
                        }),
                      'سُجّل فحص التغذية',
                    ).catch(() => {})
                  }
                >
                  حفظ الفحص
                </Button>
              </Card>
            )}

            {isDietitian && (
              <Card title="تقييم أخصائي التغذية العلاجية">
                <div className="grid grid-cols-2 gap-2">
                  <Input label="الوزن (كغ)" value={assess.weightKg} onChange={(e) => setAssess({ ...assess, weightKg: e.target.value })} />
                  <Input label="الطول (سم)" value={assess.heightCm} onChange={(e) => setAssess({ ...assess, heightCm: e.target.value })} />
                  <Input label="هدف الطاقة (سعرة)" value={assess.energyTargetKcal} onChange={(e) => setAssess({ ...assess, energyTargetKcal: e.target.value })} />
                  <Input label="هدف البروتين (غ)" value={assess.proteinTargetG} onChange={(e) => setAssess({ ...assess, proteinTargetG: e.target.value })} />
                </div>
                <div className="space-y-2 mt-2">
                  <Input label="التشخيص التغذوي" value={assess.nutritionDiagnosis} onChange={(e) => setAssess({ ...assess, nutritionDiagnosis: e.target.value })} />
                  <Input label="الخطة الغذائية (10 أحرف على الأقل)" value={assess.plan} onChange={(e) => setAssess({ ...assess, plan: e.target.value })} />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  busy={busy}
                  disabled={!assess.admissionId || !assess.weightKg || !assess.heightCm || assess.nutritionDiagnosis.length < 5 || assess.plan.length < 10}
                  onClick={() =>
                    actChart(
                      () =>
                        api('/api/nutrition/assessments', {
                          method: 'POST',
                          body: JSON.stringify({
                            admissionId: assess.admissionId,
                            weightKg: Number(assess.weightKg),
                            heightCm: Number(assess.heightCm),
                            energyTargetKcal: assess.energyTargetKcal ? Number(assess.energyTargetKcal) : undefined,
                            proteinTargetG: assess.proteinTargetG ? Number(assess.proteinTargetG) : undefined,
                            nutritionDiagnosis: assess.nutritionDiagnosis,
                            plan: assess.plan,
                          }),
                        }),
                      'حُفظ التقييم التغذوي',
                    ).catch(() => {})
                  }
                >
                  حفظ التقييم
                </Button>
              </Card>
            )}

            {has(auth, 'nutrition.order') && (
              <Card title="أمر الحمية الغذائية وتوليد الوجبات">
                <div className="grid grid-cols-2 gap-2">
                  <Select label="نوع الحمية" value={order.dietType} onChange={(e) => setOrder({ ...order, dietType: e.target.value })}>
                    {Object.entries(DIET_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <Select label="القوام" value={order.texture} onChange={(e) => setOrder({ ...order, texture: e.target.value })}>
                    <option value="">عادي</option>
                    <option value="soft">لين</option>
                    <option value="minced">مفروم</option>
                    <option value="pureed">مهروس</option>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-2 mt-2 text-xs">
                  {Object.entries(RESTRICTION_LABELS).map(([k, v]) => (
                    <label key={k} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={order.restrictions.includes(k)}
                        onChange={(e) =>
                          setOrder({
                            ...order,
                            restrictions: e.target.checked
                              ? [...order.restrictions, k]
                              : order.restrictions.filter((x) => x !== k),
                          })
                        }
                      />
                      {v}
                    </label>
                  ))}
                </div>
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!order.admissionId}
                    onClick={() =>
                      actChart(
                        () =>
                          api('/api/nutrition/diet-orders', {
                            method: 'POST',
                            body: JSON.stringify({
                              admissionId: order.admissionId,
                              dietType: order.dietType,
                              texture: order.texture || undefined,
                              restrictions: order.restrictions,
                              notes: order.notes || undefined,
                            }),
                          }),
                        'صدر أمر التغذية',
                      ).catch(() => {})
                    }
                  >
                    إصدار الأمر
                  </Button>
                  {file.activeDiet && (
                    <Button
                      variant="ghost"
                      size="sm"
                      busy={busy}
                      onClick={() =>
                        actChart(
                          () =>
                            api(`/api/nutrition/diet-orders/${file.activeDiet.id}/trays`, {
                              method: 'POST',
                              body: JSON.stringify({}),
                            }),
                          'وُلّدت صواني وجبات اليوم',
                        ).catch(() => {})
                      }
                    >
                      توليد وجبات اليوم
                    </Button>
                  )}
                </div>
              </Card>
            )}

            {has(auth, 'nutrition.tube') && (
              <Card title="التغذية الأنبوبية / الوريدية">
                <div className="grid grid-cols-2 gap-2">
                  <Select label="المسار" value={tube.route} onChange={(e) => setTube({ ...tube, route: e.target.value })}>
                    {Object.entries(TUBE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <Input label="اسم التركيبة" value={tube.formulaName} onChange={(e) => setTube({ ...tube, formulaName: e.target.value })} />
                  <Input label="سعرة/مل" type="number" step="0.1" value={tube.kcalPerMl} onChange={(e) => setTube({ ...tube, kcalPerMl: e.target.value })} />
                  <Input label="بروتين غ/ل" type="number" value={tube.proteinGPerL} onChange={(e) => setTube({ ...tube, proteinGPerL: e.target.value })} />
                  <Input label="معدل مل/ساعة" type="number" value={tube.rateMlHr} onChange={(e) => setTube({ ...tube, rateMlHr: e.target.value })} />
                  <Input label="ساعات/يوم" type="number" value={tube.hoursPerDay} onChange={(e) => setTube({ ...tube, hoursPerDay: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!tube.admissionId || tube.formulaName.trim().length < 2}
                    onClick={() =>
                      actChart(
                        () =>
                          api('/api/nutrition/tube-orders', {
                            method: 'POST',
                            body: JSON.stringify({
                              admissionId: tube.admissionId,
                              route: tube.route,
                              formulaName: tube.formulaName,
                              kcalPerMl: Number(tube.kcalPerMl),
                              proteinGPerL: Number(tube.proteinGPerL),
                              rateMlHr: Number(tube.rateMlHr),
                              hoursPerDay: Number(tube.hoursPerDay),
                            }),
                          }),
                        'صدر أمر التغذية الأنبوبية',
                      ).catch(() => {})
                    }
                  >
                    بدء التغذية الأنبوبية
                  </Button>
                  {file.tubeOrders
                    .filter((t: any) => t.status === 'active')
                    .map((t: any) => (
                      <Button
                        key={t.id}
                        variant="danger"
                        size="sm"
                        onClick={() => setStopTubeTarget({ id: t.id, orderNo: t.order_no })}
                      >
                        إيقاف {t.order_no}
                      </Button>
                    ))}
                </div>
              </Card>
            )}

            {isDietitian && (
              <Card title="متابعة أخصائي التغذية">
                <div className="grid grid-cols-3 gap-2">
                  <Input label="الوزن (كغ)" value={follow.weightKg} onChange={(e) => setFollow({ ...follow, weightKg: e.target.value })} />
                  <Input label="الاستهلاك %" type="number" value={follow.intakePctAvg} onChange={(e) => setFollow({ ...follow, intakePctAvg: e.target.value })} />
                  <Select label="التحمل" value={follow.tolerance} onChange={(e) => setFollow({ ...follow, tolerance: e.target.value })}>
                    {Object.entries(TOLERANCE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="mt-2">
                  <Input
                    label="ملاحظة المتابعة (10 أحرف على الأقل)"
                    value={follow.note}
                    onChange={(e) => setFollow({ ...follow, note: e.target.value })}
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-3"
                  busy={busy}
                  disabled={follow.note.trim().length < 10}
                  onClick={() =>
                    actChart(
                      () => {
                        const admId =
                          screen.admissionId ||
                          admissions.find((a: any) => a.patient_id === file.patient.id)?.admission_id;
                        return api(`/api/nutrition/patients/${file.patient.id}/followups`, {
                          method: 'POST',
                          body: JSON.stringify({
                            admissionId: admId,
                            weightKg: follow.weightKg ? Number(follow.weightKg) : undefined,
                            intakePctAvg: follow.intakePctAvg ? Number(follow.intakePctAvg) : undefined,
                            tolerance: follow.tolerance,
                            note: follow.note,
                          }),
                        });
                      },
                      'سُجّلت ملاحظة المتابعة',
                    ).catch(() => {})
                  }
                >
                  حفظ المتابعة
                </Button>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ReasonDialog #4: Stop Tube Nutrition Order */}
      <ReasonDialog
        open={!!stopTubeTarget}
        onClose={() => setStopTubeTarget(null)}
        title={`إيقاف أمر التغذية الأنبوبية (${stopTubeTarget?.orderNo ?? ''})`}
        consequenceNote="سيتم إيقاف أمر التغذية الأنبوبية نهائيًا مع توثيق السبب السريري في ملف المريض وسجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد الإيقاف"
        variant="danger"
        onConfirm={async (reason) => {
          if (!stopTubeTarget) return;
          await actChart(
            () =>
              api(`/api/nutrition/tube-orders/${stopTubeTarget.id}/stop`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'أُوقف أمر التغذية الأنبوبية بسبب موثّق',
          );
        }}
      />
    </div>
  );
}
