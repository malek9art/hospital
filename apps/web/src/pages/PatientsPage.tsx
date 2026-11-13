import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  PrintHeader,
  SearchInput,
  Select,
  useToast,
} from '../components';
import { useDebounce } from '../hooks/useDebounce';
import { navigate } from '../hooks/useHashRoute';
import { formatDateTime, formatMoney } from '../lib/format';

export default function PatientsPage({ auth, routeId }: { auth: Me; routeId: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [chartLoading, setChartLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ack, setAck] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    fullNameAr: '',
    dateOfBirth: '',
    sex: 'male',
    nationalId: '',
    phone: '',
  });

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setErr(null);
      api<{ items: any[] }>(`/api/patients?search=${encodeURIComponent(debouncedSearch)}`, { signal })
        .then((r) => setItems(r.items ?? []))
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setErr(e.message);
        })
        .finally(() => setLoading(false));
    },
    [debouncedSearch],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Deep-link support: #/patients/:id
  useEffect(() => {
    if (!routeId) {
      setSelected(null);
      return;
    }
    const ctrl = new AbortController();
    setChartLoading(true);
    api(`/api/patients/${routeId}`, { signal: ctrl.signal })
      .then((res) => setSelected(res))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') toast.error(e.message);
      })
      .finally(() => setChartLoading(false));
    return () => ctrl.abort();
  }, [routeId, toast]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    if (form.nationalId && !/^\d{10}$/.test(form.nationalId.trim())) {
      setFormErr('رقم الهوية أو الإقامة يجب أن يتكون من 10 أرقام.');
      return;
    }
    setSaving(true);
    try {
      const created = await api<{ id: string; mrn: string }>('/api/patients', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          nationalId: form.nationalId.trim() || null,
          phone: form.phone.trim() || null,
          acknowledgeDuplicate: ack,
        }),
      });
      toast.success(`تم تسجيل المريض بنجاح (${created.mrn})`);
      setShowForm(false);
      setAck(false);
      setForm({ fullNameAr: '', dateOfBirth: '', sex: 'male', nationalId: '', phone: '' });
      load();
    } catch (ex) {
      const ae = ex as ApiError;
      const cands = (ae.details as { candidates?: Array<{ mrn: string }> })?.candidates;
      setFormErr(ae.message + (cands?.length ? ` — مرشحون مشابهون: ${cands.map((c) => c.mrn).join('، ')}` : ''));
    } finally {
      setSaving(false);
    }
  }

  const activeFacility = auth.facilities.find((f) => f.id === auth.activeFacilityId);

  if (err && items.length === 0) return <ErrorState message={err} onRetry={() => load()} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={6} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجل المرضى الموحّد (EMPI)"
        subtitle="بحث وتسجيل المرضى مع إخفاء الهوية والجوال حسب الدور وفحص التشابه تلقائيًا."
        actions={
          has(auth, 'patient.create') && (
            <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
              {showForm ? 'إغلاق نموذج التسجيل' : '+ تسجيل مريض جديد'}
            </Button>
          )
        }
      />

      {showForm && (
        <Card title="تسجيل مريض جديد" className="no-print">
          {formErr && (
            <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800 mb-3">
              {formErr}
            </div>
          )}
          <form onSubmit={create} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Input
              label="الاسم الكامل بالعربية"
              required
              value={form.fullNameAr}
              onChange={(e) => setForm({ ...form, fullNameAr: e.target.value })}
            />
            <Input
              label="تاريخ الميلاد"
              type="date"
              required
              value={form.dateOfBirth}
              onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
            />
            <Select
              label="الجنس"
              value={form.sex}
              onChange={(e) => setForm({ ...form, sex: e.target.value })}
            >
              <option value="male">ذكر</option>
              <option value="female">أنثى</option>
            </Select>
            <Input
              label="رقم الهوية / الإقامة (10 أرقام)"
              value={form.nationalId}
              onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
              dir="ltr"
              placeholder="10xxxxxxxx"
            />
            <Input
              label="رقم الجوال"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              dir="ltr"
              placeholder="05xxxxxxxx"
            />
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 self-end pb-2.5">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              تأكيد مراجعة التشابه المحتمل (EMPI)
            </label>
            <div className="sm:col-span-2 flex items-end justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                إلغاء
              </Button>
              <Button type="submit" variant="primary" busy={saving}>
                حفظ ملف المريض
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card className="no-print">
        <div className="mb-3 max-w-md">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="ابحث بالاسم أو رقم الملف الطبي (MRN)…"
            label="بحث في سجل المرضى"
          />
        </div>

        <DataTable
          caption="قائمة المرضى المسجلين"
          rows={items}
          rowKey={(p) => p.id}
          emptyTitle="لا يوجد مرضى مطابقون لعبارة البحث"
          cardTitle={(p) => p.fullNameAr}
          cardSubtitle={(p) => `${p.mrn} · ${p.sex === 'male' ? 'ذكر' : 'أنثى'}`}
          cardBadge={(p) => (p.bloodType ? <span className="badge bg-brand-50 text-brand-800">{p.bloodType}</span> : null)}
          cardActions={(p) => (
            <Button variant="ghost" size="sm" onClick={() => navigate(`#/patients/${p.id}`)}>
              فتح الملف الطبي
            </Button>
          )}
          columns={[
            { key: 'mrn', header: 'رقم الملف (MRN)', render: (p) => <span className="font-mono text-xs">{p.mrn}</span> },
            { key: 'name', header: 'الاسم الكامل', render: (p) => <span className="font-semibold">{p.fullNameAr}</span> },
            { key: 'sex', header: 'الجنس', render: (p) => (p.sex === 'male' ? 'ذكر' : 'أنثى') },
            { key: 'nid', header: 'الهوية', render: (p) => <span dir="ltr">{p.nationalIdMasked ?? '—'}</span> },
            { key: 'phone', header: 'الجوال', render: (p) => <span dir="ltr">{p.phoneMasked ?? '—'}</span> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (p) => (
                <Button variant="ghost" size="sm" onClick={() => navigate(`#/patients/${p.id}`)}>
                  فتح الملف
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {chartLoading && <PageSkeleton cards={3} rows={3} />}
      {selected && (
        <PatientChart
          data={selected}
          facilityName={activeFacility?.name_ar}
          onClose={() => navigate('#/patients')}
        />
      )}
    </div>
  );
}

function PatientChart({
  data,
  facilityName,
  onClose,
}: {
  data: any;
  facilityName?: string;
  onClose: () => void;
}) {
  const p = data.patient;
  return (
    <div className="print-sheet space-y-3">
      <PrintHeader
        facilityName={facilityName}
        documentTitle={`ملخص الملف الطبي للمريض — ${p.fullNameAr}`}
        documentNo={p.mrn}
      />
      <Card
        title={`الملف الطبي — ${p.fullNameAr} (${p.mrn})`}
        subtitle={`أساس الوصول المسجل في التدقيق: ${data.access.basis} · النطاق: ${
          data.access.scope === 'clinical' ? 'سريري كامل' : 'إداري فقط'
        }`}
        action={
          <div className="flex gap-2 no-print">
            <Button variant="ghost" size="sm" onClick={() => window.print()}>
              طباعة الملخص
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              إغلاق
            </Button>
          </div>
        }
      >
        <div className="grid md:grid-cols-3 gap-3 mb-4 text-sm">
          <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-1">
            <p>
              <span className="text-slate-500">الجنس:</span> {p.sex === 'male' ? 'ذكر' : 'أنثى'}
            </p>
            <p>
              <span className="text-slate-500">تاريخ الميلاد:</span> {p.dateOfBirth}
            </p>
            <p>
              <span className="text-slate-500">فصيلة الدم:</span> <b>{p.bloodType ?? 'غير مسجلة'}</b>
            </p>
          </div>
          <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-1">
            <p>
              <span className="text-slate-500">الهوية:</span>{' '}
              <span dir="ltr" className="font-mono">
                {p.nationalId ?? p.nationalIdMasked ?? '—'}
              </span>
            </p>
            <p>
              <span className="text-slate-500">الجوال:</span>{' '}
              <span dir="ltr" className="font-mono">
                {p.phone ?? p.phoneMasked ?? '—'}
              </span>
            </p>
          </div>
          <div className="bg-rose-50 border border-rose-200 p-3 rounded-xl">
            <p className="font-bold text-rose-900 text-xs mb-1">الحساسية المسجلة:</p>
            <p className="text-xs text-rose-800">
              {data.allergies.length
                ? data.allergies.map((a: any) => `${a.allergen} (${a.severity})`).join('، ')
                : 'لا توجد حساسية مسجلة'}
            </p>
          </div>
        </div>

        {data.access.scope === 'clinical' ? (
          <div className="grid lg:grid-cols-2 gap-3">
            <Card title="الزيارات السريرية">
              {data.encounters.length === 0 ? (
                <EmptyState title="لا توجد زيارات مسجلة" />
              ) : (
                <ul className="text-sm space-y-1.5">
                  {data.encounters.map((e: any) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
                      <span>
                        {formatDateTime(e.startedAt)} — {e.department} ({e.doctor ?? '—'})
                      </span>
                      <Badge value={e.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="التشخيصات (ICD-10)">
              {data.diagnoses.length === 0 ? (
                <EmptyState title="لا توجد تشخيصات مسجلة" />
              ) : (
                <ul className="text-sm space-y-1.5">
                  {data.diagnoses.map((d: any) => (
                    <li key={d.id}>
                      <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{d.icd10_code}</span> —{' '}
                      {d.description}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="الملاحظات السريرية الموقّعة">
              {data.notes.length === 0 ? (
                <EmptyState title="لا توجد ملاحظات سريرية" />
              ) : (
                <ul className="text-sm space-y-2">
                  {data.notes.map((n: any) => (
                    <li key={n.id} className="border-b border-slate-100 pb-1.5">
                      <span className="text-xs text-slate-500">
                        {n.author} — {formatDateTime(n.created_at)}
                      </span>
                      <p className="mt-0.5">{n.assessment || n.subjective || n.plan}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="طلبات المختبر">
              {data.labs.length === 0 ? (
                <EmptyState title="لا توجد طلبات تحاليل" />
              ) : (
                <ul className="text-sm space-y-1.5">
                  {data.labs.map((l: any) => (
                    <li key={l.id} className="flex items-center justify-between">
                      <span className="font-mono text-xs">{l.order_no}</span>
                      <Badge value={l.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : (
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900">
            الدور الوظيفي الحالي لا يملك صلاحية الاطلاع على السجل السريري؛ يُعرض النطاق الإداري والمالي فقط.
          </div>
        )}

        <div className="mt-3">
          <Card title="الفواتير المرتبطة بالمريض">
            {data.invoices.length === 0 ? (
              <EmptyState title="لا توجد فواتير" />
            ) : (
              <ul className="text-sm space-y-1.5">
                {data.invoices.map((i: any) => (
                  <li key={i.id} className="flex items-center justify-between">
                    <span>
                      <span className="font-mono text-xs">{i.invoice_no}</span> — {formatMoney(i.total)}
                    </span>
                    <Badge value={i.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Card>
    </div>
  );
}
