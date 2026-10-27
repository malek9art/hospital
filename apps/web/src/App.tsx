import { useEffect, useState, type ReactNode } from 'react';
import { api, login, me, resetCsrf, has, setUnauthorizedHandler, type Me } from './api';

type PageKey = 'dashboard' | 'patients' | 'appointments' | 'clinic' | 'emergency' | 'inpatient' | 'lab' | 'pharmacy' | 'billing' | 'reports' | 'audit' | 'modules' | 'portal';

const money = (v: number | string | null | undefined) =>
  new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR', maximumFractionDigits: 2 }).format(Number(v ?? 0));
const dt = (v?: string | null) => (v ? new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short', calendar: 'gregory' }).format(new Date(v)) : '—');
const day = (v?: string | null) => (v ? new Intl.DateTimeFormat('en-CA').format(new Date(v)) : '');

const STATUS: Record<string, string> = {
  booked: 'محجوز', checked_in: 'حضر', in_consultation: 'في الاستشارة', completed: 'مكتمل', cancelled: 'ملغى', no_show: 'لم يحضر',
  open: 'مفتوحة', closed: 'مغلقة', ordered: 'مطلوب', collected: 'تم جمع العينة', resulted: 'نتيجة مسجلة', verified: 'معتمدة',
  issued: 'صادرة', partially_dispensed: 'صرف جزئي', dispensed: 'مصروفة', paid: 'مدفوعة', partially_paid: 'مدفوعة جزئيًا', void: 'ملغاة',
};

function Badge({ value }: { value: string }) {
  const color = ['paid', 'verified', 'completed', 'dispensed', 'closed'].includes(value) ? 'bg-emerald-100 text-emerald-700'
    : ['cancelled', 'void', 'no_show'].includes(value) ? 'bg-rose-100 text-rose-700'
    : ['critical_high', 'critical_low', 'failed'].includes(value) ? 'bg-rose-100 text-rose-700'
    : value === 'ordered' || value === 'issued' || value === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700';
  return <span className={`badge ${color}`}>{STATUS[value] ?? value}</span>;
}
function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return <div className="card p-4"><div className="flex items-center justify-between mb-3">{title && <h2 className="font-bold text-slate-800">{title}</h2>}{action}</div>{children}</div>;
}
function Msg({ text, kind = 'error' }: { text: string | null; kind?: 'error' | 'ok' }) {
  if (!text) return null;
  return <div className={`rounded-lg px-3 py-2 text-sm mb-3 ${kind === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>{text}</div>;
}

// ------------------------------------------------------------------ Login -----
function LoginPage({ onLogin, notice }: { onLogin: (m: Me) => void; notice?: string }) {
  const [email, setEmail] = useState('dr.ahmed@demo.hms');
  const [password, setPassword] = useState('Doctor#Demo2026');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await login(email, password);
      if (res.mfaRequired) { setMfa(true); return; }
      onLogin(await me());
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function submitMfa(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code }) }); onLogin(await me()); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  const accounts = [
    ['طبيب', 'dr.ahmed@demo.hms', 'Doctor#Demo2026'], ['استقبال', 'reception@demo.hms', 'Reception#Demo2026'],
    ['مختبر', 'lab@demo.hms', 'Lab#Demo2026'], ['صيدلي', 'pharmacist@demo.hms', 'Pharma#Demo2026'],
    ['محاسب', 'accountant@demo.hms', 'Account#Demo2026'], ['مدير النظام', 'admin@demo.hms', 'Admin#Demo2026'],
    ['مدقق', 'auditor@demo.hms', 'Auditor#Demo2026'], ['مريض', 'patient@demo.hms', 'Patient#Demo2026'],
  ];
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-brand-800 text-white p-10">
        <div><div className="text-3xl font-bold">نظام إدارة المستشفى</div><p className="text-brand-100 mt-2">منصة موحدة للرعاية والإدارة — العربية أولًا</p></div>
        <div className="space-y-2 text-sm text-brand-100">
          <p>سجل طبي إلكتروني · مواعيد · مختبر · صيدلية · فوترة · تدقيق</p>
          <p>صلاحيات سياقية + عزل بيانات على مستوى الصفوف (RLS)</p>
          <p className="text-xs opacity-80">بيانات تجريبية اصطناعية بالكامل — ليست بيانات مرضى حقيقيين.</p>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-bold mb-1">تسجيل الدخول</h1>
          <p className="text-sm text-slate-500 mb-4">الدخول يتطلب جلسة آمنة وصلاحيات حسب الدور.</p>
          <Msg text={notice ?? null} kind="ok" />
          <Msg text={err} />
          {!mfa ? (
            <form onSubmit={submit} className="card p-5 space-y-3">
              <div><label className="label">البريد الإلكتروني</label><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoComplete="username" /></div>
              <div><label className="label">كلمة المرور</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="current-password" /></div>
              <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول'}</button>
            </form>
          ) : (
            <form onSubmit={submitMfa} className="card p-5 space-y-3">
              <p className="text-sm">أدخل رمز التحقق من تطبيق المصادقة (أو رمز استرداد).</p>
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" inputMode="numeric" />
              <button className="btn-primary w-full justify-center" disabled={busy}>تحقق</button>
            </form>
          )}
          <div className="mt-5">
            <p className="text-xs font-semibold text-slate-500 mb-2">حسابات تجريبية (اضغط للتعبئة)</p>
            <div className="flex flex-wrap gap-2">
              {accounts.map(([label, e, p]) => (
                <button key={e} className="btn-ghost text-xs" onClick={() => { setEmail(e); setPassword(p); }}>{label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Dashboard ---
function Dashboard() {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('/api/dashboard').then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <Card title="لوحة القيادة"><Msg text={`تعذر التحميل: ${err}`} /></Card>;
  if (!data) return <p className="text-slate-500">جارٍ التحميل…</p>;
  const k = data.kpis;
  const items = [
    ['زيارات اليوم', k.encountersToday], ['مواعيد اليوم', k.appointmentsToday], ['زيارات مفتوحة', k.openEncounters],
    ['تحاليل معلّقة', k.pendingLabs], ['تنبيهات حرجة', k.criticalAlerts], ['وصفات معلّقة', k.pendingPrescriptions],
    ['إشغال الأسرّة', `${k.occupancyPct}% (${k.bedsOccupied}/${k.bedsTotal})`], ['المحصّل اليوم', money(k.collectedToday)],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {items.map(([label, value]) => (
          <div key={String(label)} className="card p-4"><p className="text-xs text-slate-500">{label}</p><p className="text-2xl font-bold mt-1">{value}</p></div>
        ))}
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="الزيارات حسب القسم (اليوم)">
          <table className="w-full"><thead><tr><th className="th">القسم</th><th className="th">الزيارات</th></tr></thead>
            <tbody>{(data.byDepartment ?? []).map((d: any) => <tr key={d.name_ar}><td className="td">{d.name_ar}</td><td className="td">{d.visits}</td></tr>)}</tbody></table>
        </Card>
        <Card title="تنبيهات النظام (in-app)">
          {(data.notifications ?? []).length === 0 ? <p className="text-sm text-slate-500">لا تنبيهات.</p> :
            <ul className="space-y-2">{data.notifications.map((n: any) => <li key={n.id} className="text-sm border-b pb-2"><span className="font-semibold">{n.subject}</span><span className="block text-xs text-slate-500">{n.body} — {dt(n.created_at)}</span></li>)}</ul>}
        </Card>
      </div>
      <p className="text-xs text-slate-400">الأرقام محسوبة مباشرة من قاعدة البيانات. لا تُعرض بيانات وهمية كأنها حقيقية.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Patients ---
function Patients({ m }: { m: Me }) {
  const [items, setItems] = useState<any[]>([]); const [search, setSearch] = useState('');
  const [err, setErr] = useState<string | null>(null); const [selected, setSelected] = useState<any>(null);
  const [form, setForm] = useState({ fullNameAr: '', dateOfBirth: '', sex: 'male', nationalId: '', phone: '' });
  const [showForm, setShowForm] = useState(false); const [ack, setAck] = useState(false);

  async function load() { try { const r = await api(`/api/patients?search=${encodeURIComponent(search)}`); setItems(r.items); } catch (e: any) { setErr(e.message); } }
  useEffect(() => { load(); }, []);
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      await api('/api/patients', { method: 'POST', body: JSON.stringify({ ...form, nationalId: form.nationalId || null, phone: form.phone || null, acknowledgeDuplicate: ack }) });
      setShowForm(false); setAck(false); setForm({ fullNameAr: '', dateOfBirth: '', sex: 'male', nationalId: '', phone: '' }); load();
    } catch (e: any) { setErr(e.message + (e.details?.candidates ? ` — مرشحون: ${e.details.candidates.map((c: any) => c.mrn).join(', ')}` : '')); }
  }
  async function open(id: string) { try { setSelected(await api(`/api/patients/${id}`)); } catch (e: any) { setErr(e.message); } }

  return (
    <div className="space-y-4">
      <Msg text={err} />
      <Card title="المرضى" action={has(m, 'patient.create') && <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>تسجيل مريض</button>}>
        <div className="flex gap-2 mb-3"><input className="input" placeholder="بحث بالاسم أو رقم الملف" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} /><button className="btn-ghost" onClick={load}>بحث</button></div>
        {showForm && (
          <form onSubmit={create} className="grid md:grid-cols-4 gap-2 bg-slate-50 p-3 rounded-lg mb-3">
            <div><label className="label">الاسم الكامل *</label><input required className="input" value={form.fullNameAr} onChange={(e) => setForm({ ...form, fullNameAr: e.target.value })} /></div>
            <div><label className="label">تاريخ الميلاد *</label><input required type="date" className="input" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></div>
            <div><label className="label">الجنس</label><select className="input" value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="male">ذكر</option><option value="female">أنثى</option></select></div>
            <div><label className="label">الهوية (10 أرقام)</label><input className="input" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} dir="ltr" /></div>
            <div><label className="label">الجوال</label><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} dir="ltr" /></div>
            <label className="flex items-center gap-2 text-xs mt-5"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> تأكيد مراجعة التشابه</label>
            <div className="md:col-span-2 flex items-end"><button className="btn-primary" type="submit">حفظ</button></div>
          </form>
        )}
        <div className="overflow-x-auto"><table className="w-full min-w-[640px]"><thead><tr><th className="th">رقم الملف</th><th className="th">الاسم</th><th className="th">الجنس</th><th className="th">الهوية</th><th className="th">الجوال</th><th className="th"></th></tr></thead>
          <tbody>{items.map((p) => <tr key={p.id}><td className="td font-mono text-xs">{p.mrn}</td><td className="td">{p.fullNameAr}</td><td className="td">{p.sex === 'male' ? 'ذكر' : 'أنثى'}</td><td className="td" dir="ltr">{p.nationalIdMasked}</td><td className="td" dir="ltr">{p.phoneMasked}</td><td className="td"><button className="btn-ghost text-xs" onClick={() => open(p.id)}>الملف</button></td></tr>)}</tbody></table></div>
      </Card>
      {selected && <PatientChart data={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PatientChart({ data, onClose }: { data: any; onClose: () => void }) {
  const p = data.patient;
  return (
    <Card title={`الملف الطبي — ${p.fullNameAr} (${p.mrn})`} action={<button className="btn-ghost text-xs" onClick={onClose}>إغلاق</button>}>
      <div className="text-xs text-slate-500 mb-2">أساس الوصول: {data.access.basis} · النطاق: {data.access.scope === 'clinical' ? 'سريري' : 'إداري'}</div>
      <div className="grid md:grid-cols-3 gap-3 mb-3 text-sm">
        <div className="bg-slate-50 p-2 rounded">الجنس: {p.sex === 'male' ? 'ذكر' : 'أنثى'}<br />الميلاد: {p.dateOfBirth}<br />فصيلة الدم: {p.bloodType ?? '—'}</div>
        <div className="bg-slate-50 p-2 rounded">الهوية: <span dir="ltr">{p.nationalId ?? p.nationalIdMasked}</span><br />الجوال: <span dir="ltr">{p.phone ?? p.phoneMasked}</span></div>
        <div className="bg-rose-50 p-2 rounded">الحساسية: {data.allergies.length ? data.allergies.map((a: any) => `${a.allergen} (${a.severity})`).join('، ') : 'لا يوجد'}</div>
      </div>
      {data.access.scope === 'clinical' ? (
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="الزيارات"><ul className="text-sm space-y-1">{data.encounters.map((e: any) => <li key={e.id}>{dt(e.startedAt)} — {e.department} — {e.doctor ?? '—'} <Badge value={e.status} /></li>)}{data.encounters.length === 0 && <li className="text-slate-500">لا زيارات</li>}</ul></Card>
          <Card title="التشخيصات"><ul className="text-sm space-y-1">{data.diagnoses.map((d: any) => <li key={d.id}>{d.icd10_code} — {d.description}</li>)}{data.diagnoses.length === 0 && <li className="text-slate-500">لا تشخيصات</li>}</ul></Card>
          <Card title="الملاحظات السريرية"><ul className="text-sm space-y-2">{data.notes.map((n: any) => <li key={n.id} className="border-b pb-1"><span className="text-xs text-slate-500">{n.author} — {dt(n.created_at)}</span><p>{n.assessment || n.subjective || n.plan}</p></li>)}{data.notes.length === 0 && <li className="text-slate-500">لا ملاحظات</li>}</ul></Card>
          <Card title="المختبر"><ul className="text-sm space-y-1">{data.labs.map((l: any) => <li key={l.id}>{l.order_no} <Badge value={l.status} /></li>)}{data.labs.length === 0 && <li className="text-slate-500">لا طلبات</li>}</ul></Card>
        </div>
      ) : <p className="text-sm text-slate-500">الدور الحالي لا يملك صلاحية العرض السريري — يُعرض النطاق الإداري فقط.</p>}
      <div className="mt-3"><Card title="الفواتير"><ul className="text-sm space-y-1">{data.invoices.map((i: any) => <li key={i.id}>{i.invoice_no} — {money(i.total)} <Badge value={i.status} /></li>)}{data.invoices.length === 0 && <li className="text-slate-500">لا فواتير</li>}</ul></Card></div>
    </Card>
  );
}

// ------------------------------------------------------------ Appointments ---
function Appointments({ m }: { m: Me }) {
  const [items, setItems] = useState<any[]>([]); const [boot, setBoot] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [form, setForm] = useState({ patientId: '', departmentId: '', doctorId: '', scheduledAt: '' });
  async function load() {
    try {
      const [a, b, c] = await Promise.all([api<any>('/api/appointments?limit=50'), api('/api/meta/bootstrap'), api<any>('/api/patients?limit=100')]);
      setItems(a.items); setBoot(b); setPatients(c.items);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function book(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { const r = await api<any>('/api/appointments', { method: 'POST', body: JSON.stringify({ ...form, scheduledAt: new Date(form.scheduledAt).toISOString() }) }); setOk(`تم الحجز ${r.appointmentNo}`); load(); }
    catch (e: any) { setErr(e.message); }
  }
  async function checkin(id: string) { try { await api(`/api/appointments/${id}/check-in`, { method: 'POST' }); load(); } catch (e: any) { setErr(e.message); } }
  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      <Card title="المواعيد">
        {has(m, 'appointment.create') && boot && (
          <form onSubmit={book} className="grid md:grid-cols-5 gap-2 bg-slate-50 p-3 rounded-lg mb-3">
            <div><label className="label">المريض</label><select required className="input" value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })}><option value="">—</option>{patients.map((p: any) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.mrn}</option>)}</select></div>
            <div><label className="label">القسم</label><select required className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}><option value="">—</option>{boot.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name_ar}</option>)}</select></div>
            <div><label className="label">الطبيب</label><select required className="input" value={form.doctorId} onChange={(e) => setForm({ ...form, doctorId: e.target.value })}><option value="">—</option>{boot.doctors.map((d: any) => <option key={d.id} value={d.id}>{d.full_name_ar}</option>)}</select></div>
            <div><label className="label">الوقت</label><input required type="datetime-local" className="input" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></div>
            <div className="flex items-end"><button className="btn-primary" type="submit">حجز</button></div>
          </form>
        )}
        <div className="overflow-x-auto"><table className="w-full min-w-[700px]"><thead><tr><th className="th">الرقم</th><th className="th">المريض</th><th className="th">القسم</th><th className="th">الطبيب</th><th className="th">الموعد</th><th className="th">الحالة</th><th className="th"></th></tr></thead>
          <tbody>{items.map((a) => <tr key={a.id}><td className="td font-mono text-xs">{a.appointmentNo}</td><td className="td">{a.patientName}<span className="block text-xs text-slate-400">{a.mrn}</span></td><td className="td">{a.department}</td><td className="td">{a.doctor}</td><td className="td">{dt(a.scheduledAt)}</td><td className="td"><Badge value={a.status} /></td>
            <td className="td">{a.status === 'booked' && has(m, 'appointment.checkin') && <button className="btn-ghost text-xs" onClick={() => checkin(a.id)}>تسجيل حضور</button>}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- Clinic ----
function Clinic({ m }: { m: Me }) {
  const [appts, setAppts] = useState<any[]>([]); const [boot, setBoot] = useState<any>(null);
  const [enc, setEnc] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [vitals, setVitals] = useState({ temperatureC: '', heartRate: '', systolicBp: '', diastolicBp: '', spo2: '' });
  const [soap, setSoap] = useState({ subjective: '', objective: '', assessment: '', plan: '' });
  const [dx, setDx] = useState({ icd10Code: '', description: '' });
  const [tests, setTests] = useState<string[]>([]); const [priority, setPriority] = useState('routine');
  const [rx, setRx] = useState({ drugId: '', dose: '', route: 'فموي', frequency: '', durationDays: '5', quantity: '10' });
  const refresh = async () => { if (enc) setEnc(await api(`/api/encounters/${enc.encounter.id}`)); };
  useEffect(() => { Promise.all([api<any>('/api/appointments?limit=50'), api('/api/meta/bootstrap')]).then(([a, b]) => { setAppts(a.items); setBoot(b); }).catch((e) => setErr(e.message)); }, []);
  async function start(a: any) {
    setErr(null);
    try {
      const r = await api<any>('/api/encounters', { method: 'POST', body: JSON.stringify({ patientId: a.patientId, appointmentId: a.id, encounterType: 'outpatient', departmentId: a.departmentId ?? boot.departments[0].id }) });
      setEnc(await api(`/api/encounters/${r.id}`)); setOk(`بدأت الزيارة ${r.encounterNo}`);
    } catch (e: any) {
      if (e.details?.encounterId) { setEnc(await api(`/api/encounters/${e.details.encounterId}`)); setErr(e.message); } else setErr(e.message);
    }
  }
  async function post(path: string, body: any, msg: string) {
    if (!enc) return; setErr(null);
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setOk(msg); await refresh(); } catch (e: any) { setErr(e.message + (e.details?.warnings ? ` — ${e.details.warnings.map((w: any) => w.message).join(' | ')}` : '')); }
  }
  const e = enc?.encounter;
  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {!e && <Card title="قائمة عيادة الطبيب">
        <div className="overflow-x-auto"><table className="w-full min-w-[600px]"><thead><tr><th className="th">الموعد</th><th className="th">المريض</th><th className="th">الوقت</th><th className="th">الحالة</th><th className="th"></th></tr></thead>
          <tbody>{appts.map((a) => <tr key={a.id}><td className="td text-xs font-mono">{a.appointmentNo}</td><td className="td">{a.patientName}</td><td className="td">{dt(a.scheduledAt)}</td><td className="td"><Badge value={a.status} /></td>
            <td className="td">{['booked', 'checked_in'].includes(a.status) && has(m, 'clinical.encounter.create') && <button className="btn-primary text-xs" onClick={() => start(a)}>بدء الاستشارة</button>}</td></tr>)}</tbody></table></div>
      </Card>}
      {e && <>
        <Card title={`زيارة ${e.encounterNo} — ${e.patient.nameAr}`} action={<button className="btn-ghost text-xs" onClick={() => setEnc(null)}>رجوع</button>}>
          <div className="text-xs text-slate-500 mb-2">بدأت {dt(e.startedAt)} · الحالة <Badge value={e.status} /> · أساس الوصول {enc.accessBasis}</div>
          {e.status === 'open' && <div className="grid lg:grid-cols-2 gap-3">
            <Card title="العلامات الحيوية">
              <div className="grid grid-cols-3 gap-2">
                {[['temperatureC', 'الحرارة'], ['heartRate', 'النبض'], ['systolicBp', 'الانقباضي'], ['diastolicBp', 'الانبساطي'], ['spo2', 'الأكسجين']].map(([k, label]) => (
                  <div key={k}><label className="label">{label}</label><input className="input" type="number" value={(vitals as any)[k]} onChange={(ev) => setVitals({ ...vitals, [k]: ev.target.value })} /></div>
                ))}
              </div>
              <button className="btn-primary mt-2" onClick={() => post(`/api/encounters/${e.id}/vitals`, Object.fromEntries(Object.entries(vitals).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])), 'تم تسجيل العلامات الحيوية')}>تسجيل</button>
            </Card>
            <Card title="التشخيص (ICD-10)">
              <div className="grid grid-cols-3 gap-2"><input className="input" placeholder="الرمز" value={dx.icd10Code} onChange={(ev) => setDx({ ...dx, icd10Code: ev.target.value })} /><input className="input col-span-2" placeholder="الوصف" value={dx.description} onChange={(ev) => setDx({ ...dx, description: ev.target.value })} /></div>
              <button className="btn-primary mt-2" onClick={() => post(`/api/encounters/${e.id}/diagnoses`, { ...dx, type: 'primary' }, 'تم تسجيل التشخيص')}>حفظ التشخيص</button>
            </Card>
            <Card title="ملاحظة SOAP">
              {(['subjective', 'objective', 'assessment', 'plan'] as const).map((k) => (
                <div key={k} className="mb-2"><label className="label">{k}</label><input className="input" value={(soap as any)[k]} onChange={(ev) => setSoap({ ...soap, [k]: ev.target.value })} /></div>
              ))}
              <button className="btn-primary" onClick={() => post(`/api/encounters/${e.id}/notes`, { ...soap, sign: true }, 'تم حفظ الملاحظة وتوقيعها')}>حفظ وتوقيع</button>
            </Card>
            <Card title="طلب تحاليل">
              <div className="space-y-1 max-h-40 overflow-auto">{(boot?.labTests ?? []).map((t: any) => (
                <label key={t.code} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={tests.includes(t.code)} onChange={(ev) => setTests(ev.target.checked ? [...tests, t.code] : tests.filter((x) => x !== t.code))} /> {t.name_ar} <span className="text-xs text-slate-400">{t.code}</span></label>
              ))}</div>
              <div className="flex gap-2 mt-2"><select className="input" value={priority} onChange={(ev) => setPriority(ev.target.value)}><option value="routine">روتيني</option><option value="urgent">عاجل</option><option value="stat">فوري</option></select>
                <button className="btn-primary" disabled={!tests.length} onClick={() => post(`/api/encounters/${e.id}/lab-orders`, { tests, priority }, 'تم إرسال طلب التحاليل')}>إرسال</button></div>
            </Card>
            <Card title="وصفة طبية">
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2"><label className="label">الدواء</label><select className="input" value={rx.drugId} onChange={(ev) => setRx({ ...rx, drugId: ev.target.value })}><option value="">—</option>{(boot?.drugs ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name_ar}</option>)}</select></div>
                <div><label className="label">الجرعة</label><input className="input" value={rx.dose} onChange={(ev) => setRx({ ...rx, dose: ev.target.value })} placeholder="500mg" /></div>
                <div><label className="label">التكرار</label><input className="input" value={rx.frequency} onChange={(ev) => setRx({ ...rx, frequency: ev.target.value })} placeholder="كل 8 ساعات" /></div>
                <div><label className="label">المدة (أيام)</label><input className="input" type="number" value={rx.durationDays} onChange={(ev) => setRx({ ...rx, durationDays: ev.target.value })} /></div>
                <div><label className="label">الكمية</label><input className="input" type="number" value={rx.quantity} onChange={(ev) => setRx({ ...rx, quantity: ev.target.value })} /></div>
              </div>
              <button className="btn-primary mt-2" disabled={!rx.drugId} onClick={() => post(`/api/encounters/${e.id}/prescriptions`, { items: [{ drugId: rx.drugId, dose: rx.dose || '1', route: rx.route, frequency: rx.frequency || 'يوميًا', durationDays: Number(rx.durationDays), quantity: Number(rx.quantity) }], allergyAcknowledged: false }, 'تم إصدار الوصفة')}>إصدار الوصفة</button>
            </Card>
            <Card title="إغلاق الزيارة">
              <button className="btn-danger" onClick={() => post(`/api/encounters/${e.id}/close`, { disposition: 'متابعة في العيادة' }, 'تم إغلاق الزيارة وإنشاء الفاتورة')}>إغلاق وإنشاء فاتورة</button>
              <p className="text-xs text-slate-500 mt-2">الإغلاق يُنشئ فاتورة بالخدمات المسجلة (استشارة + تحاليل).</p>
            </Card>
          </div>}
        </Card>
        <div className="grid lg:grid-cols-3 gap-3">
          <Card title="العلامات الأخيرة"><ul className="text-sm">{enc.vitals.slice(0, 3).map((v: any) => <li key={v.id}>{dt(v.recorded_at)} — {v.heart_rate ?? '—'} نبضة، {v.temperature_c ?? '—'}°</li>)}</ul></Card>
          <Card title="التحاليل"><ul className="text-sm">{enc.labOrders.map((l: any) => <li key={l.id}>{l.order_no} <Badge value={l.status} /></li>)}</ul></Card>
          <Card title="الوصفات"><ul className="text-sm">{enc.prescriptions.map((p: any) => <li key={p.id}>{p.prescription_no} <Badge value={p.status} /></li>)}</ul></Card>
        </div>
      </>}
    </div>
  );
}


// --------------------------------------------------------------- Inpatient ---
function Inpatient({ m }: { m: Me }) {
  const [beds, setBeds] = useState<any[]>([]); const [wards, setWards] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null); const [admissions, setAdmissions] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [admit, setAdmit] = useState({ patientId: '', bedId: '', reason: '' });
  const [transfer, setTransfer] = useState<{ id: string; toBedId: string; reason: string } | null>(null);
  const [discharge, setDischarge] = useState<{ id: string; dischargeType: string; summary: string } | null>(null);

  async function load() {
    try {
      const [b, a, p] = await Promise.all([
        api<any>('/api/inpatient/beds'),
        has(m, 'inpatient.admit') ? api<any>('/api/inpatient/admissions') : Promise.resolve({ items: [] }),
        api<any>('/api/patients?limit=100'),
      ]);
      setBeds(b.beds); setWards(b.wards); setSummary(b.summary); setAdmissions(a.items); setPatients(p.items);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await load(); } catch (e: any) { setErr(e.message + (e.details?.admissionId ? ` (${e.details.admissionId})` : '')); }
  }
  const statusColor: Record<string, string> = { available: 'bg-emerald-50 border-emerald-200', occupied: 'bg-rose-50 border-rose-200', cleaning: 'bg-amber-50 border-amber-200', maintenance: 'bg-slate-100 border-slate-300' };
  const statusLabel: Record<string, string> = { available: 'متاح', occupied: 'مشغول', cleaning: 'تنظيف', maintenance: 'صيانة' };
  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {summary && <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[['الإجمالي', summary.total], ['مشغول', summary.occupied], ['متاح', summary.available], ['تنظيف', summary.cleaning], ['صيانة', summary.maintenance]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v}</p></div>
        ))}
      </div>}
      {has(m, 'inpatient.admit') && (
        <Card title="تنويم مريض (أمر طبيب)">
          <div className="grid md:grid-cols-4 gap-2">
            <div><label className="label">المريض</label>
              <select className="input" value={admit.patientId} onChange={(e) => setAdmit({ ...admit, patientId: e.target.value })}>
                <option value="">—</option>{patients.map((p: any) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.mrn}</option>)}
              </select></div>
            <div><label className="label">السرير المتاح</label>
              <select className="input" value={admit.bedId} onChange={(e) => setAdmit({ ...admit, bedId: e.target.value })}>
                <option value="">—</option>{beds.filter((b) => b.bed_status === 'available').map((b: any) => <option key={b.id} value={b.id}>{b.ward_name} · {b.room_no}/{b.bed_no}</option>)}
              </select></div>
            <div className="md:col-span-2"><label className="label">سبب التنويم</label>
              <input className="input" value={admit.reason} onChange={(e) => setAdmit({ ...admit, reason: e.target.value })} placeholder="مثال: مراقبة ضغط غير مستقر" /></div>
          </div>
          <button className="btn-primary mt-2" disabled={!admit.patientId || !admit.reason}
            onClick={() => act(async () => {
              await api('/api/inpatient/admissions', { method: 'POST', body: JSON.stringify({ patientId: admit.patientId, bedId: admit.bedId || undefined, reason: admit.reason }) });
              setAdmit({ patientId: '', bedId: '', reason: '' });
            }, 'تم تنويم المريض وتخصيص السرير')}>تنويم</button>
          <p className="text-xs text-slate-500 mt-1">يُحوَّل المريض إلى زيارة تنويم مستقلة؛ الأيام تُحتسب عند الخروج.</p>
        </Card>
      )}
      <Card title="خريطة الأسرّة">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {beds.map((b) => (
            <div key={b.id} className={`border rounded-lg p-2 text-sm ${statusColor[b.bed_status]}`}>
              <div className="flex justify-between"><span className="font-semibold">{b.ward_name} · {b.room_no}/{b.bed_no}</span><span className="badge bg-white/70">{statusLabel[b.bed_status]}</span></div>
              {b.patient_name && <p className="text-xs mt-1">{b.patient_name} <span className="text-slate-500">{b.mrn}</span></p>}
              {b.bed_status === 'cleaning' && has(m, 'inpatient.bed.manage') && (
                <button className="btn-ghost text-xs mt-1" onClick={() => act(() => api(`/api/inpatient/beds/${b.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'available' }) }), 'السرير متاح الآن')}>تم التنظيف</button>
              )}
            </div>
          ))}
        </div>
      </Card>
      {has(m, 'inpatient.admit') && (
        <Card title="التنويمات">
          <div className="overflow-x-auto"><table className="w-full min-w-[800px]"><thead><tr><th className="th">رقم التنويم</th><th className="th">المريض</th><th className="th">السرير</th><th className="th">الطبيب</th><th className="th">الدخول</th><th className="th">الحالة</th><th className="th"></th></tr></thead>
            <tbody>{admissions.map((a) => <tr key={a.id}>
              <td className="td font-mono text-xs">{a.admission_no}</td><td className="td">{a.patient_name}<span className="block text-xs text-slate-400">{a.mrn}</span></td>
              <td className="td">{a.ward_name ? `${a.ward_name} · ${a.room_no}/${a.bed_no}` : '—'}</td><td className="td">{a.doctor_name}</td><td className="td">{dt(a.admitted_at)}</td>
              <td className="td"><Badge value={a.status === 'active' ? 'open' : 'completed'} /></td>
              <td className="td space-x-1 space-x-reverse">
                {a.status === 'active' && <>
                  <button className="btn-ghost text-xs" onClick={() => setTransfer({ id: a.id, toBedId: '', reason: '' })}>نقل</button>
                  <button className="btn-primary text-xs" onClick={() => setDischarge({ id: a.id, dischargeType: 'home', summary: '' })}>خروج</button>
                </>}
              </td></tr>)}</tbody></table></div>
        </Card>
      )}
      {transfer && <Card title="نقل المريض" action={<button className="btn-ghost text-xs" onClick={() => setTransfer(null)}>إغلاق</button>}>
        <select className="input mb-2" value={transfer.toBedId} onChange={(e) => setTransfer({ ...transfer, toBedId: e.target.value })}>
          <option value="">اختر السرير الهدف</option>
          {beds.filter((b) => b.bed_status === 'available').map((b: any) => <option key={b.id} value={b.id}>{b.ward_name} · {b.room_no}/{b.bed_no}</option>)}
        </select>
        <input className="input mb-2" placeholder="سبب النقل" value={transfer.reason} onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })} />
        <button className="btn-primary" disabled={!transfer.toBedId || transfer.reason.length < 3}
          onClick={() => act(() => api(`/api/inpatient/admissions/${transfer.id}/transfer`, { method: 'POST', body: JSON.stringify({ toBedId: transfer.toBedId, reason: transfer.reason }) }), 'تم نقل المريض').then(() => setTransfer(null))}>تأكيد النقل</button>
      </Card>}
      {discharge && <Card title="خروج المريض" action={<button className="btn-ghost text-xs" onClick={() => setDischarge(null)}>إغلاق</button>}>
        <select className="input mb-2" value={discharge.dischargeType} onChange={(e) => setDischarge({ ...discharge, dischargeType: e.target.value })}>
          <option value="home">إلى المنزل</option><option value="transfer">تحويل لمنشأة أخرى</option>
          <option value="deceased">وفاة</option><option value="against_advice">خروج ضد النصيحة الطبية</option>
        </select>
        <textarea className="input mb-2" rows={4} placeholder="ملخص الخروج (20 حرفًا على الأقل)" value={discharge.summary} onChange={(e) => setDischarge({ ...discharge, summary: e.target.value })} />
        <button className="btn-primary" disabled={discharge.summary.length < 20}
          onClick={() => act(() => api(`/api/inpatient/admissions/${discharge.id}/discharge`, { method: 'POST', body: JSON.stringify({ dischargeType: discharge.dischargeType, summary: discharge.summary }) }), 'تم تسجيل الخروج واحتساب أيام الإقامة').then(() => setDischarge(null))}>
          تأكيد الخروج
        </button>
      </Card>}
    </div>
  );
}


// --------------------------------------------------------------- Emergency ---
const LEVELS: Record<number, { ar: string; cls: string }> = {
  1: { ar: '١ إنعاش', cls: 'bg-rose-600 text-white' },
  2: { ar: '٢ حرج', cls: 'bg-orange-500 text-white' },
  3: { ar: '٣ عاجل', cls: 'bg-amber-400 text-slate-900' },
  4: { ar: '٤ أقل إلحاحًا', cls: 'bg-sky-200 text-slate-800' },
  5: { ar: '٥ غير عاجل', cls: 'bg-slate-200 text-slate-700' },
};

function Emergency({ m }: { m: Me }) {
  const [board, setBoard] = useState<any>(null); const [patients, setPatients] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({ patientId: '', unidentified: false, sex: 'male', age: '', chiefComplaint: '', level: '3', notes: '', hr: '', sbp: '', spo2: '', temp: '' });
  const [action, setAction] = useState<{ kind: 'retriage' | 'discharge' | 'admit'; encounterId: string; level?: string; reason?: string; summary?: string; bedId?: string } | null>(null);
  const [freeBeds, setFreeBeds] = useState<any[]>([]);

  async function load() {
    try {
      const [b, p] = await Promise.all([api<any>('/api/emergency/board'), api<any>('/api/patients?limit=100')]);
      setBoard(b); setPatients(p.items);
      if (has(m, 'inpatient.admit')) {
        const beds = await api<any>('/api/inpatient/beds');
        setFreeBeds(beds.beds.filter((x: any) => x.bed_status === 'available'));
      }
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); setAction(null); await load(); } catch (e: any) { setErr(e.message); }
  }
  async function register(e: React.FormEvent) {
    e.preventDefault();
    const vitals: any = {};
    if (form.hr) vitals.heartRate = Number(form.hr);
    if (form.sbp) vitals.systolicBp = Number(form.sbp);
    if (form.spo2) vitals.spo2 = Number(form.spo2);
    if (form.temp) vitals.temperatureC = Number(form.temp);
    const payload: any = { chiefComplaint: form.chiefComplaint, level: Number(form.level), notes: form.notes || undefined, vitals: Object.keys(vitals).length ? vitals : undefined };
    if (form.unidentified) payload.unidentified = { sex: form.sex, estimatedAge: form.age ? Number(form.age) : undefined };
    else payload.patientId = form.patientId;
    await act(async () => {
      const r: any = await api('/api/emergency/arrivals', { method: 'POST', body: JSON.stringify(payload) });
      if (r.temporaryIdentity) setOk('تم تسجيل وصول مجهول الهوية برقم مؤقت — يمكن مطابقته لاحقًا من السجلات الطبية');
      setForm({ ...form, patientId: '', chiefComplaint: '', notes: '', hr: '', sbp: '', spo2: '', temp: '' });
    }, 'تم تسجيل الوصول والفرز');
  }
  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {board && <div className="grid grid-cols-5 gap-2">
        {[1, 2, 3, 4, 5].map((l) => (
          <div key={l} className={`rounded-lg p-2 text-center ${LEVELS[l].cls}`}>
            <p className="text-xs">{LEVELS[l].ar}</p>
            <p className="text-xl font-bold">{board.byLevel[l] ?? 0}</p>
          </div>
        ))}
      </div>}
      <Card title="تسجيل وصول للطوارئ">
        <form onSubmit={register} className="grid md:grid-cols-4 gap-2">
          <div className="md:col-span-2">
            <label className="label">المريض</label>
            <div className="flex gap-2">
              <select className="input" disabled={form.unidentified} value={form.patientId} onChange={(e) => setForm({ ...form, patientId: e.target.value })}>
                <option value="">—</option>{patients.map((p: any) => <option key={p.id} value={p.id}>{p.fullNameAr} · {p.mrn}</option>)}
              </select>
              <label className="flex items-center gap-1 text-xs whitespace-nowrap"><input type="checkbox" checked={form.unidentified} onChange={(e) => setForm({ ...form, unidentified: e.target.checked, patientId: '' })} /> مجهول الهوية</label>
            </div>
          </div>
          {form.unidentified && <>
            <div><label className="label">الجنس</label><select className="input" value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="male">ذكر</option><option value="female">أنثى</option><option value="other">غير محدد</option></select></div>
            <div><label className="label">العمر التقريبي</label><input className="input" type="number" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} /></div>
          </>}
          <div className="md:col-span-2"><label className="label">الشكوى الرئيسية *</label><input required className="input" value={form.chiefComplaint} onChange={(e) => setForm({ ...form, chiefComplaint: e.target.value })} /></div>
          <div><label className="label">مستوى الفرز *</label>
            <select className="input" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
              {[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{LEVELS[l].ar}</option>)}
            </select></div>
          <div className="grid grid-cols-4 gap-1 md:col-span-2">
            <div><label className="label">نبض</label><input className="input" type="number" value={form.hr} onChange={(e) => setForm({ ...form, hr: e.target.value })} /></div>
            <div><label className="label">انقباضي</label><input className="input" type="number" value={form.sbp} onChange={(e) => setForm({ ...form, sbp: e.target.value })} /></div>
            <div><label className="label">SpO₂</label><input className="input" type="number" value={form.spo2} onChange={(e) => setForm({ ...form, spo2: e.target.value })} /></div>
            <div><label className="label">حرارة</label><input className="input" type="number" step="0.1" value={form.temp} onChange={(e) => setForm({ ...form, temp: e.target.value })} /></div>
          </div>
          <div className="flex items-end"><button className="btn-primary" type="submit" disabled={!form.chiefComplaint || (!form.patientId && !form.unidentified)}>تسجيل وفرز</button></div>
        </form>
        <p className="text-xs text-slate-500 mt-1">الأولوية 1–2 تُنشئ تنبيهًا فوريًا. الترتيب في اللوحة حسب الخطورة ثم وقت الوصول، لا حسب ترتيب الوصول.</p>
      </Card>
      <Card title="لوحة الطوارئ">
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
          <th className="th">الفرز</th><th className="th">المريض</th><th className="th">الشكوى</th><th className="th">الانتظار</th><th className="th">آخر علامات</th><th className="th">الحالة</th><th className="th">إجراءات</th></tr></thead>
          <tbody>{(board?.items ?? []).map((i: any) => (
            <tr key={i.id} className={i.level <= 2 ? 'bg-rose-50/60' : ''}>
              <td className="td"><span className={`badge ${LEVELS[i.level].cls}`}>{LEVELS[i.level].ar}</span>{i.previous_level && <span className="block text-[10px] text-slate-500">سابقًا {i.previous_level}</span>}</td>
              <td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn}{i.identity_status === 'unverified_temporary' && ' · مجهول الهوية'}</span></td>
              <td className="td max-w-[220px] truncate">{i.chief_complaint}</td>
              <td className={`td font-semibold ${i.waiting_minutes > 30 && i.level >= 3 ? 'text-rose-600' : ''}`}>{i.waiting_minutes} د</td>
              <td className="td text-xs">{i.last_hr ? `نبض ${i.last_hr}` : '—'} {i.last_sbp ? `· ضغط ${i.last_sbp}` : ''} {i.last_spo2 ? `· SpO₂ ${i.last_spo2}` : ''}</td>
              <td className="td"><Badge value={i.status === 'in_treatment' ? 'in_consultation' : 'open'} /></td>
              <td className="td space-x-1 space-x-reverse whitespace-nowrap">
                <button className="btn-ghost text-xs" onClick={() => setAction({ kind: 'retriage', encounterId: i.encounter_id, level: String(i.level), reason: '' })}>إعادة فرز</button>
                <button className="btn-ghost text-xs" onClick={() => setAction({ kind: 'discharge', encounterId: i.encounter_id, summary: '' })}>خروج</button>
                {has(m, 'inpatient.admit') && <button className="btn-primary text-xs" onClick={() => setAction({ kind: 'admit', encounterId: i.encounter_id })}>تنويم</button>}
              </td></tr>))}
            {(board?.items ?? []).length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا حالات نشطة.</td></tr>}
          </tbody></table></div>
      </Card>
      {action && <Card title={action.kind === 'retriage' ? 'إعادة فرز' : action.kind === 'discharge' ? 'خروج من الطوارئ' : 'تنويم من الطوارئ'}
        action={<button className="btn-ghost text-xs" onClick={() => setAction(null)}>إغلاق</button>}>
        {action.kind === 'retriage' && <>
          <select className="input mb-2" value={action.level} onChange={(e) => setAction({ ...action, level: e.target.value })}>
            {[1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{LEVELS[l].ar}</option>)}
          </select>
          <input className="input mb-2" placeholder="سبب تغيير المستوى (إلزامي)" value={action.reason} onChange={(e) => setAction({ ...action, reason: e.target.value })} />
          <button className="btn-primary" disabled={(action.reason ?? '').length < 5}
            onClick={() => act(() => api(`/api/emergency/visits/${action.encounterId}/retriage`, { method: 'POST', body: JSON.stringify({ level: Number(action.level), reason: action.reason }) }), 'تم تحديث مستوى الفرز')}>تأكيد</button>
        </>}
        {action.kind === 'discharge' && <>
          <textarea className="input mb-2" rows={4} placeholder="ملخص الخروج وتعليمات المتابعة (10 أحرف على الأقل)" value={action.summary} onChange={(e) => setAction({ ...action, summary: e.target.value })} />
          <button className="btn-primary" disabled={(action.summary ?? '').length < 10}
            onClick={() => act(() => api(`/api/emergency/visits/${action.encounterId}/disposition`, { method: 'POST', body: JSON.stringify({ decision: 'discharge', dischargeType: 'home', summary: action.summary }) }), 'تم إنهاء زيارة الطوارئ وإضافة رسم الزيارة')}>تأكيد الخروج</button>
        </>}
        {action.kind === 'admit' && <>
          <select className="input mb-2" value={action.bedId ?? ''} onChange={(e) => setAction({ ...action, bedId: e.target.value })}>
            <option value="">بدون سرير (بانتظار سرير)</option>
            {freeBeds.map((b: any) => <option key={b.id} value={b.id}>{b.ward_name} · {b.room_no}/{b.bed_no}</option>)}
          </select>
          <button className="btn-primary"
            onClick={() => act(() => api(`/api/emergency/visits/${action.encounterId}/disposition`, { method: 'POST', body: JSON.stringify({ decision: 'admit', bedId: action.bedId || undefined }) }), 'تم تحويل المريض إلى التنويم على نفس الزيارة')}>تأكيد التنويم</button>
        </>}
      </Card>}
    </div>
  );
}

// ----------------------------------------------------------------- Reports ---
function Reports({ m }: { m: Me }) {
  const [reports, setReports] = useState<any[]>([]); const [key, setKey] = useState('visits');
  const [data, setData] = useState<any>(null); const [range, setRange] = useState({ from: '', to: '' });
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { api<any>('/api/reports').then((r) => { setReports(r.reports); }).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [key]);
  async function load() {
    setErr(null); setOk(null);
    try {
      const qs = new URLSearchParams();
      if (range.from) qs.set('from', range.from);
      if (range.to) qs.set('to', range.to);
      setData(await api(`/api/reports/${key}?${qs.toString()}`));
    } catch (e: any) { setErr(e.message); setData(null); }
  }
  async function download() {
    try {
      const qs = new URLSearchParams({ format: 'csv' });
      if (range.from) qs.set('from', range.from);
      if (range.to) qs.set('to', range.to);
      const res = await fetch(`/api/reports/${key}?${qs.toString()}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error?.message ?? 'فشل التصدير'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `hms-${key}.csv`; a.click();
      URL.revokeObjectURL(url);
      setOk('تم تصدير CSV وتسجيل العملية في سجل التدقيق');
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      <Card title="التقارير">
        <div className="flex flex-wrap gap-2 items-end">
          <div><label className="label">التقرير</label>
            <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
              {reports.map((r: any) => <option key={r.key} value={r.key}>{r.ar}</option>)}
            </select></div>
          <div><label className="label">من</label><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
          <div><label className="label">إلى</label><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
          <button className="btn-ghost" onClick={load}>تحديث</button>
          {has(m, 'report.export') && <button className="btn-primary" onClick={download}>تصدير CSV (مدقق)</button>}
        </div>
        {!has(m, 'report.export') && <p className="text-xs text-slate-500 mt-1">عرض فقط — لا تملك صلاحية التصدير.</p>}
      </Card>
      {data && <Card title={`${data.title} · ${data.total} صفًا`}>
        <div className="overflow-x-auto max-h-[520px]"><table className="w-full text-sm"><thead className="sticky top-0 bg-white"><tr>{data.columns.map((c: any) => <th key={c.key} className="th">{c.ar}</th>)}</tr></thead>
          <tbody>{data.rows.map((r: any, idx: number) => <tr key={idx}>{data.columns.map((c: any) => <td key={c.key} className="td whitespace-nowrap">{r[c.key] ?? '—'}</td>)}</tr>)}
            {data.rows.length === 0 && <tr><td className="td text-slate-500" colSpan={data.columns.length}>لا بيانات في الفترة المحددة.</td></tr>}</tbody></table></div>
      </Card>}
    </div>
  );
}

// -------------------------------------------------------------------- Lab ----
function Lab({ m }: { m: Me }) {
  const [status, setStatus] = useState('all'); const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  async function load() { try { setItems((await api<any>(`/api/lab/worklist?status=${status}`)).items); } catch (e: any) { setErr(e.message); } }
  useEffect(() => { load(); }, [status]);
  async function act(path: string, body: any, msg: string) { try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setOk(msg); load(); } catch (e: any) { setErr(e.message); } }
  return (
    <div className="space-y-4"><Msg text={err} /><Msg text={ok} kind="ok" />
      <Card title="قائمة عمل المختبر" action={<select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">الكل</option><option value="ordered">بانتظار العينة</option><option value="collected">بانتظار النتيجة</option><option value="resulted">بانتظار الاعتماد</option><option value="verified">معتمدة</option></select>}>
        <div className="overflow-x-auto"><table className="w-full min-w-[800px]"><thead><tr><th className="th">الطلب</th><th className="th">المريض</th><th className="th">التحليل</th><th className="th">الأولوية</th><th className="th">الحالة</th><th className="th">النتيجة</th><th className="th"></th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.id}>
            <td className="td font-mono text-xs">{i.order_no}</td><td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn}</span></td>
            <td className="td">{i.test_name}<span className="block text-xs text-slate-400">{i.test_code}</span></td><td className="td">{i.priority}</td><td className="td"><Badge value={i.status} /></td>
            <td className="td">{i.value_numeric ?? i.value_text ?? '—'} {i.unit ?? ''} {i.flag && i.flag !== 'normal' && <span className="badge bg-rose-100 text-rose-700">{i.flag}</span>}</td>
            <td className="td space-x-1 space-x-reverse">
              {i.status === 'ordered' && has(m, 'lab.sample.collect') && <button className="btn-ghost text-xs" onClick={() => act(`/api/lab/items/${i.id}/collect`, {}, 'تم جمع العينة')}>جمع عينة</button>}
              {i.status === 'collected' && has(m, 'lab.result.enter') && <span className="flex gap-1"><input className="input w-20" type="number" placeholder="قيمة" value={values[i.id] ?? ''} onChange={(e) => setValues({ ...values, [i.id]: e.target.value })} /><button className="btn-primary text-xs" onClick={() => act(`/api/lab/items/${i.id}/result`, { valueNumeric: Number(values[i.id]) }, 'تم حفظ النتيجة')}>حفظ</button></span>}
              {i.status === 'resulted' && has(m, 'lab.result.verify') && <button className="btn-primary text-xs" onClick={() => act(`/api/lab/items/${i.id}/verify`, {}, 'تم اعتماد النتيجة')}>اعتماد</button>}
            </td></tr>)}</tbody></table></div>
        <p className="text-xs text-slate-500 mt-2">الاعتماد يتطلب مستخدمًا مختلفًا عن مدخل النتيجة (فصل مهام). القيم الحرجة تُنشئ تنبيهًا تلقائيًا.</p>
      </Card>
      {has(m, 'lab.critical.ack') && <Alerts />}
    </div>
  );
}
function Alerts() {
  const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<any>('/api/lab/alerts').then((r) => setItems(r.items)).catch((e) => setErr(e.message)); }, []);
  return <Card title="تنبيهات القيم الحرجة"><Msg text={err} /><ul className="space-y-2 text-sm">{items.map((a) => <li key={a.id} className="flex items-center justify-between border-b pb-1"><span>{a.message} <span className="text-xs text-slate-400">{dt(a.created_at)}</span></span>
    {a.acknowledged_at ? <Badge value="verified" /> : <button className="btn-ghost text-xs" onClick={async () => { await api(`/api/lab/alerts/${a.id}/ack`, { method: 'POST', body: JSON.stringify({ note: 'تم إبلاغ الطبيب المعالج' }) }); location.reload(); }}>إقرار</button>}</li>)}{items.length === 0 && <li className="text-slate-500">لا تنبيهات.</li>}</ul></Card>;
}

// --------------------------------------------------------------- Pharmacy ----
function Pharmacy({ m }: { m: Me }) {
  const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  async function load() { try { setItems((await api<any>('/api/pharmacy/prescriptions')).items); } catch (e: any) { setErr(e.message); } }
  useEffect(() => { load(); }, []);
  async function open(id: string) { try { setDetail(await api(`/api/pharmacy/prescriptions/${id}`)); } catch (e: any) { setErr(e.message); } }
  async function dispense() {
    if (!detail) return;
    try {
      const pending = detail.items.filter((i: any) => i.status === 'pending').map((i: any) => ({ itemId: i.id, quantity: Number(i.quantity) }));
      await api('/api/pharmacy/dispense', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ prescriptionId: detail.prescription.id, items: pending, acknowledgedWarnings: detail.warnings.length > 0, overrideReason: detail.warnings.length ? 'مراجعة الصيدلي واعتماد الطبيب' : undefined }) });
      setOk('تم الصرف وخصم المخزون'); setDetail(null); load();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="space-y-4"><Msg text={err} /><Msg text={ok} kind="ok" />
      <Card title="وصفات بانتظار الصرف"><table className="w-full"><thead><tr><th className="th">الوصفة</th><th className="th">المريض</th><th className="th">الطبيب</th><th className="th">الحالة</th><th className="th"></th></tr></thead>
        <tbody>{items.map((p) => <tr key={p.id}><td className="td font-mono text-xs">{p.prescription_no}</td><td className="td">{p.patient_name}</td><td className="td">{p.prescriber}</td><td className="td"><Badge value={p.status} /></td><td className="td"><button className="btn-ghost text-xs" onClick={() => open(p.id)}>مراجعة وصرف</button></td></tr>)}</tbody></table>
      </Card>
      {detail && <Card title={`صرف ${detail.prescription.prescription_no} — ${detail.prescription.patient_name}`} action={<button className="btn-ghost text-xs" onClick={() => setDetail(null)}>إغلاق</button>}>
        {detail.warnings.length > 0 && <div className="bg-rose-50 border border-rose-200 p-2 rounded mb-2 text-sm">{detail.warnings.map((w: any, i: number) => <p key={i}>⚠ {w.message}</p>)}</div>}
        <table className="w-full"><thead><tr><th className="th">الدواء</th><th className="th">الجرعة</th><th className="th">الكمية</th><th className="th">الحالة</th></tr></thead>
          <tbody>{detail.items.map((i: any) => <tr key={i.id}><td className="td">{i.drug_name}</td><td className="td">{i.dose} — {i.frequency}</td><td className="td">{i.quantity}</td><td className="td"><Badge value={i.status} /></td></tr>)}</tbody></table>
        <button className="btn-primary mt-3" disabled={!has(m, 'pharmacy.dispense')} onClick={dispense}>صرف (FEFO + معاملة واحدة)</button>
      </Card>}
    </div>
  );
}

// ---------------------------------------------------------------- Billing ----
function Billing({ m }: { m: Me }) {
  const [items, setItems] = useState<any[]>([]); const [summary, setSummary] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [pay, setPay] = useState({ amount: '', method: 'cash' });
  async function load() { try { const [a, b] = await Promise.all([api<any>('/api/billing/invoices?limit=50'), api('/api/billing/summary')]); setItems(a.items); setSummary(b); } catch (e: any) { setErr(e.message); } }
  useEffect(() => { load(); }, []);
  async function open(id: string) { try { setDetail(await api(`/api/billing/invoices/${id}`)); } catch (e: any) { setErr(e.message); } }
  async function collect() {
    if (!detail) return;
    try {
      await api(`/api/billing/invoices/${detail.invoice.id}/payments`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ amount: Number(pay.amount), method: pay.method }) });
      setOk('تم تسجيل الدفعة'); setDetail(await api(`/api/billing/invoices/${detail.invoice.id}`)); load();
    } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="space-y-4"><Msg text={err} /><Msg text={ok} kind="ok" />
      {summary && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[['فواتير اليوم', money(summary.today_billed)], ['المحصّل اليوم', money(summary.today_collected)], ['مستحقات', money(summary.outstanding)], ['فواتير مفتوحة', summary.open_invoices]].map(([l, v]) => <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v}</p></div>)}
      </div>}
      <Card title="الفواتير"><table className="w-full"><thead><tr><th className="th">الفاتورة</th><th className="th">المريض</th><th className="th">الإجمالي</th><th className="th">المدفوع</th><th className="th">الحالة</th><th className="th"></th></tr></thead>
        <tbody>{items.map((i) => <tr key={i.id}><td className="td font-mono text-xs">{i.invoice_no}</td><td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn}</span></td><td className="td">{money(i.total)}</td><td className="td">{money(i.paid_amount)}</td><td className="td"><Badge value={i.status} /></td><td className="td"><button className="btn-ghost text-xs" onClick={() => open(i.id)}>تفاصيل</button></td></tr>)}</tbody></table>
      </Card>
      {detail && <Card title={`فاتورة ${detail.invoice.invoice_no}`} action={<button className="btn-ghost text-xs" onClick={() => setDetail(null)}>إغلاق</button>}>
        <table className="w-full mb-2"><thead><tr><th className="th">البند</th><th className="th">الفئة</th><th className="th">الكمية</th><th className="th">السعر</th><th className="th">الإجمالي</th></tr></thead>
          <tbody>{detail.items.map((it: any) => <tr key={it.id}><td className="td">{it.description}</td><td className="td">{it.category}</td><td className="td">{it.quantity}</td><td className="td">{money(it.unit_price)}</td><td className="td">{money(it.line_total)}</td></tr>)}</tbody></table>
        <p className="text-sm font-semibold">الإجمالي {money(detail.invoice.total)} · المدفوع {money(detail.invoice.paid_amount)} · المتبقي {money(Number(detail.invoice.total) - Number(detail.invoice.paid_amount))}</p>
        {detail.invoice.status !== 'paid' && detail.invoice.status !== 'void' && has(m, 'billing.payment.record') && <div className="flex gap-2 mt-2">
          <input className="input w-32" type="number" placeholder="المبلغ" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
          <select className="input w-32" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="cash">نقد</option><option value="card">بطاقة</option><option value="transfer">تحويل</option><option value="insurance">تأمين</option></select>
          <button className="btn-primary" onClick={collect}>تحصيل</button>
        </div>}
        <p className="text-xs text-slate-500 mt-2">التحصيل محمي بمفتاح منع تكرار (Idempotency) لمنع الدفعات المزدوجة.</p>
      </Card>}
    </div>
  );
}

// ------------------------------------------------------------------ Audit ----
function Audit() {
  const [items, setItems] = useState<any[]>([]); const [verify, setVerify] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<any>('/api/audit?limit=50').then((r) => setItems(r.items)).catch((e) => setErr(e.message));
    api('/api/audit/verify').then(setVerify).catch(() => {});
  }, []);
  return (
    <div className="space-y-4"><Msg text={err} />
      {verify && <div className={`card p-3 text-sm ${verify.ok ? 'text-emerald-700' : 'text-rose-700'}`}>سلسلة التدقيق: {verify.ok ? `سليمة (${verify.checked} سجلًا)` : `مكسورة عند السجل ${verify.brokenAtId}`}</div>}
      <Card title="سجل التدقيق"><div className="overflow-x-auto"><table className="w-full min-w-[800px]"><thead><tr><th className="th">الوقت</th><th className="th">المستخدم</th><th className="th">الإجراء</th><th className="th">الكيان</th><th className="th">النتيجة</th><th className="th">السبب</th></tr></thead>
        <tbody>{items.map((a) => <tr key={a.id}><td className="td text-xs">{dt(a.created_at)}</td><td className="td">{a.actor_name ?? '—'}</td><td className="td font-mono text-xs">{a.action}</td><td className="td text-xs">{a.entity_type} / {String(a.entity_id ?? '').slice(0, 8)}</td><td className="td"><Badge value={a.outcome === 'success' ? 'verified' : 'cancelled'} /></td><td className="td text-xs">{a.reason ?? '—'}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Modules ----
function Modules() {
  const [mods, setMods] = useState<any[]>([]); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<any>('/api/meta/modules').then((r) => setMods(r.modules)).catch((e) => setErr(e.message)); }, []);
  const label: Record<string, string> = { implemented: 'منفذ', partial: 'جزئي', not_implemented: 'غير منفذ' };
  const color: Record<string, string> = { implemented: 'bg-emerald-100 text-emerald-700', partial: 'bg-amber-100 text-amber-700', not_implemented: 'bg-slate-200 text-slate-600' };
  return (
    <div className="space-y-3"><Msg text={err} />
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{mods.map((m) => <div key={m.key} className="card p-3"><div className="flex justify-between items-center"><h3 className="font-semibold text-sm">{m.ar}</h3><span className={`badge ${color[m.status]}`}>{label[m.status]}</span></div><p className="text-xs text-slate-500 mt-1">{m.note}</p></div>)}</div>
      <p className="text-xs text-slate-400">حالة الوحدات معروضة بصدق من الخادم — لا تُعلن وظائف غير منفذة كمكتملة.</p>
    </div>
  );
}

// ----------------------------------------------------------------- Portal ----
function Portal() {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('/api/portal/summary').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <Msg text={err} />;
  if (!d) return <p className="text-slate-500">جارٍ التحميل…</p>;
  return (
    <div className="space-y-4">
      <Card title={`بوابة المريض — ${d.patient?.full_name_ar ?? ''}`}><p className="text-xs text-slate-500">{d.notice}</p></Card>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="المواعيد"><ul className="text-sm space-y-1">{d.appointments.map((a: any) => <li key={a.id}>{dt(a.scheduled_at)} — {a.department} — {a.doctor} <Badge value={a.status} /></li>)}</ul></Card>
        <Card title="النتائج المعتمدة"><ul className="text-sm space-y-1">{d.results.map((r: any) => <li key={r.id}>{r.test_name}: {r.value_numeric ?? r.value_text} {r.unit} {r.flag !== 'normal' && <span className="badge bg-amber-100 text-amber-700">{r.flag}</span>}</li>)}{d.results.length === 0 && <li className="text-slate-500">لا نتائج معتمدة.</li>}</ul></Card>
        <Card title="الوصفات"><ul className="text-sm space-y-1">{d.prescriptions.map((p: any) => <li key={p.prescription_no}>{p.prescription_no} <Badge value={p.status} /></li>)}</ul></Card>
        <Card title="الفواتير"><ul className="text-sm space-y-1">{d.invoices.map((i: any) => <li key={i.invoice_no}>{i.invoice_no} — {money(i.total)} <Badge value={i.status} /></li>)}</ul></Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- App -----
const NAV: { key: PageKey; label: string; perms: string[] }[] = [
  { key: 'dashboard', label: 'لوحة القيادة', perms: ['report.read'] },
  { key: 'patients', label: 'المرضى', perms: ['patient.read'] },
  { key: 'appointments', label: 'المواعيد والاستقبال', perms: ['appointment.read'] },
  { key: 'clinic', label: 'العيادة', perms: ['clinical.encounter.read'] },
  { key: 'lab', label: 'المختبر', perms: ['lab.sample.collect'] },
  { key: 'emergency', label: 'الطوارئ والفرز', perms: ['emergency.triage'] },
  { key: 'inpatient', label: 'التنويم والأسرّة', perms: ['inpatient.admit', 'inpatient.bed.manage'] },
  { key: 'pharmacy', label: 'الصيدلية', perms: ['pharmacy.prescription.read'] },
  { key: 'billing', label: 'الفوترة', perms: ['billing.invoice.read'] },
  { key: 'reports', label: 'التقارير', perms: ['report.read'] },
  { key: 'audit', label: 'التدقيق', perms: ['audit.read'] },
  { key: 'modules', label: 'حالة الوحدات', perms: ['patient.read'] },
  { key: 'portal', label: 'بوابة المريض', perms: ['portal.self'] },
];

function EphemeralBanner() {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((h) => setMode(h?.persistence ?? null)).catch(() => setMode(null));
  }, []);
  if (mode !== 'ephemeral') return null;
  return (
    <div className="bg-amber-100 text-amber-900 text-[11px] sm:text-xs px-4 py-1.5 text-center border-b border-amber-200">
      نسخة استعراض على Vercel: قاعدة البيانات مؤقتة داخل الدالة وتُعاد تهيئتها عند إعادة تشغيلها.
      للحفظ الفعلي شغّل نسخة الخادم أو اربط Postgres عبر <span className="font-mono">DATABASE_URL</span>.
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<Me | null>(null);
  const [page, setPage] = useState<PageKey>('dashboard');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | undefined>();
  useEffect(() => {
    me().then((m) => { setAuth(m); pick(m); }).catch(() => setAuth(null)).finally(() => setLoading(false));
    setUnauthorizedHandler?.(() => { resetCsrf(); setAuth(null); });
  }, []);
  function pick(m: Me) {
    const first = NAV.find((n) => n.perms.some((p) => has(m, p)));
    if (first) setPage(first.key);
  }
  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ } resetCsrf(); setAuth(null); }
  if (loading) return <div className="p-10 text-center text-slate-500">جارٍ التحميل…</div>;
  if (!auth) return <><EphemeralBanner /><LoginPage onLogin={(m) => { setAuth(m); pick(m); }} notice={notice} /></>;
  const allowed = NAV.filter((n) => n.perms.some((p) => has(auth, p)));
  return (
    <div className="min-h-screen flex flex-col">
      <EphemeralBanner />
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><div className="w-9 h-9 rounded-lg bg-brand-700 text-white grid place-items-center font-bold">H</div>
            <div><p className="font-bold leading-tight">نظام إدارة المستشفى</p><p className="text-xs text-slate-500">{auth.facilities.find((f) => f.id === auth.activeFacilityId)?.name_ar}</p></div></div>
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden sm:inline text-slate-600">{auth.user.fullNameAr} · <span className="text-xs text-slate-400">{auth.primaryRole}</span></span>
            <button className="btn-ghost text-xs" onClick={logout}>خروج</button>
          </div>
        </div>
        <nav className="px-2 pb-2 flex gap-1 overflow-x-auto">
          {allowed.map((n) => <button key={n.key} onClick={() => setPage(n.key)} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold ${page === n.key ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{n.label}</button>)}
        </nav>
      </header>
      <main className="flex-1 p-4 max-w-[1400px] w-full mx-auto">
        {page === 'dashboard' && <Dashboard />}
        {page === 'patients' && <Patients m={auth} />}
        {page === 'appointments' && <Appointments m={auth} />}
        {page === 'clinic' && <Clinic m={auth} />}
        {page === 'emergency' && <Emergency m={auth} />}
        {page === 'inpatient' && <Inpatient m={auth} />}
        {page === 'lab' && <Lab m={auth} />}
        {page === 'pharmacy' && <Pharmacy m={auth} />}
        {page === 'billing' && <Billing m={auth} />}
        {page === 'reports' && <Reports m={auth} />}
        {page === 'audit' && <Audit />}
        {page === 'modules' && <Modules />}
        {page === 'portal' && <Portal />}
      </main>
      <footer className="text-center text-xs text-slate-400 py-3">بيانات تجريبية اصطناعية · لا تستخدم لرعاية مرضى حقيقيين دون مراجعة أمنية وامتثال</footer>
    </div>
  );
}
