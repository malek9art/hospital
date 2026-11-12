import { useEffect, useState, type ReactNode } from 'react';
import { api, login, me, resetCsrf, has, setUnauthorizedHandler, type Me } from './api';

type PageKey = 'dashboard' | 'patients' | 'appointments' | 'clinic' | 'emergency' | 'inpatient' | 'nursing' | 'surgery' | 'icu' | 'bloodbank' | 'nutrition' | 'cssd' | 'lab' | 'radiology' | 'pharmacy' | 'billing' | 'reports' | 'audit' | 'modules' | 'portal';

const money = (v: number | string | null | undefined) =>
  new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR', maximumFractionDigits: 2 }).format(Number(v ?? 0));
const dt = (v?: string | null) => (v ? new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short', calendar: 'gregory' }).format(new Date(v)) : '—');
const day = (v?: string | null) => (v ? new Intl.DateTimeFormat('en-CA').format(new Date(v)) : '');

const STATUS: Record<string, string> = {
  booked: 'محجوز', checked_in: 'حضر', in_consultation: 'في الاستشارة', completed: 'مكتمل', cancelled: 'ملغى', no_show: 'لم يحضر',
  open: 'مفتوحة', closed: 'مغلقة', ordered: 'مطلوب', collected: 'تم جمع العينة', resulted: 'نتيجة مسجلة', verified: 'معتمدة',
  issued: 'صادرة', partially_dispensed: 'صرف جزئي', dispensed: 'مصروفة', paid: 'مدفوعة', partially_paid: 'مدفوعة جزئيًا', void: 'ملغاة',
  prepared: 'محضّرة', delivered: 'مُسلَّمة', consumed: 'مستهلكة', refused: 'مرفوضة', stopped: 'متوقفة',
  available: 'متاحة', reserved: 'محجوزة', transfused: 'مُنقلة', discarded: 'مستبعدة',
  pending: 'قيد الانتظار', crossmatched: 'مطابقة', stopped_reaction: 'أُوقف لتفاعل', stopped_other: 'أُوقف لسبب آخر',
  dirty: 'ملوّثة', washing: 'قيد الغسل', packed: 'مغلّفة', sterilizing: 'قيد التعقيم', released: 'معقّمة',
  used: 'مستخدمة', returned: 'مُعادة', quarantined: 'محجوزة احترازيًا', recalled: 'مسحوبة',
  running: 'جارية', passed: 'ناجحة', failed: 'فاشلة', approved: 'معتمدة',
  suspected: 'مشتبهة', confirmed: 'مؤكدة', excluded: 'مستبعدة',
};

function Badge({ value }: { value: string }) {
  const color = ['paid', 'verified', 'completed', 'dispensed', 'closed'].includes(value) ? 'bg-emerald-100 text-emerald-700'
    : ['cancelled', 'void', 'no_show'].includes(value) ? 'bg-rose-100 text-rose-700'
    : ['critical_high', 'critical_low', 'failed', 'quarantined', 'recalled'].includes(value) ? 'bg-rose-100 text-rose-700'
    : ['released', 'approved', 'passed', 'confirmed'].includes(value) ? 'bg-emerald-100 text-emerald-700'
    : ['suspected', 'sterilizing', 'packed', 'washing'].includes(value) ? 'bg-amber-100 text-amber-700'
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
    ['بنك الدم', 'bloodbank@demo.hms', 'Blood#Demo2026'],
    ['أخصائي تغذية', 'dietitian@demo.hms', 'Nutrition#Demo2026'],
    ['خدمات التغذية', 'kitchen@demo.hms', 'Kitchen#Demo2026'],
    ['فني تعقيم', 'cssd@demo.hms', 'CSSD#Demo2026'],
    ['مكافحة العدوى', 'infection@demo.hms', 'Infection#Demo2026'],
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
  const [doctors, setDoctors] = useState<any[]>([]);
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
  const [img, setImg] = useState({ modality: 'xray', bodyPart: '', indication: '', priority: 'routine' });
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
            {has(m, 'radiology.order') && <Card title="طلب أشعة">
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">النوع</label><select className="input" value={img.modality} onChange={(ev) => setImg({ ...img, modality: ev.target.value })}>
                  <option value="xray">أشعة سينية</option><option value="ct">مقطعية</option><option value="mri">رنين مغناطيسي</option><option value="us">سونار</option><option value="mammography">ماموغرام</option><option value="fluoroscopy">فلوروسكوبي</option>
                </select></div>
                <div><label className="label">المنطقة</label><input className="input" value={img.bodyPart} onChange={(ev) => setImg({ ...img, bodyPart: ev.target.value })} placeholder="الصدر" /></div>
                <div className="col-span-2"><label className="label">المبرر السريري</label><input className="input" value={img.indication} onChange={(ev) => setImg({ ...img, indication: ev.target.value })} /></div>
                <div><label className="label">الأولوية</label><select className="input" value={img.priority} onChange={(ev) => setImg({ ...img, priority: ev.target.value })}><option value="routine">روتيني</option><option value="urgent">عاجل</option><option value="stat">فوري</option></select></div>
                <div className="flex items-end"><button className="btn-primary" disabled={img.bodyPart.length < 2 || img.indication.length < 5} onClick={() => post(`/api/encounters/${e.id}/imaging-orders`, img, 'تم إرسال طلب الأشعة')}>إرسال الطلب</button></div>
              </div>
            </Card>}
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
  const [doctors, setDoctors] = useState<any[]>([]);
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



// ---------------------------------------------------------------- Nursing ----
const SHIFT_LABEL: Record<string, string> = { morning: 'صباحية', evening: 'مسائية', night: 'ليلية' };
const CONDITION_LABEL: Record<string, string> = { stable: 'مستقرة', improving: 'تتحسن', deteriorating: 'متدهورة', critical: 'حرجة' };
const MAR_LABEL: Record<string, string> = { given: 'أُعطي', held: 'أُوقف', refused: 'رفض المريض', missed: 'فائت' };

function Nursing({ m }: { m: Me }) {
  const [board, setBoard] = useState<any>(null);
  const [active, setActive] = useState<any>(null); const [mar, setMar] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]); const [handovers, setHandovers] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [dose, setDose] = useState<any>({ itemId: '', status: 'given', doseGiven: '', route: 'فموي', reason: '', witnessUserId: '', identity: false, allergy: false });
  const [planForm, setPlanForm] = useState({ title: '', diagnosis: '', goals: '', task: '' });
  const [handoverForm, setHandoverForm] = useState({ shift: 'evening', condition: 'stable', situation: '', background: '', assessment: '', recommendation: '', toUserId: '' });
  const [nurses, setNurses] = useState<any[]>([]);

  async function loadBoard() {
    try {
      const b = await api<any>('/api/nursing/board');
      setBoard(b);
      if (active) {
        const current = b.items.find((i: any) => i.admission_id === active.admission_id);
        if (current) setActive(current);
      }
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { loadBoard(); }, []);
  async function open(item: any) {
    setErr(null); setActive(item); setOk(null);
    try {
      const [m1, p, h] = await Promise.all([
        api<any>(`/api/nursing/patients/${item.patient_id}/mar`),
        api<any>(`/api/nursing/care-plans?admissionId=${item.admission_id}`),
        api<any>(`/api/nursing/handovers?admissionId=${item.admission_id}`),
      ]);
      setMar(m1); setPlans(p.plans); setHandovers(h.items);
      if (m1.due[0]) setDose((d: any) => ({ ...d, itemId: m1.due[0].itemId, doseGiven: m1.due[0].dose, route: m1.due[0].route }));
      if (nurses.length === 0) {
        const w = await api<any>('/api/nursing/witnesses');
        setNurses(w.items);
      }
    } catch (e: any) { setErr(e.message); }
  }
  async function refresh() { if (active) await open(active); await loadBoard(); }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await refresh(); } catch (e: any) { setErr(e.message + (e.details ? ` — ${JSON.stringify(e.details)}` : '')); }
  }
  const dueDoses = mar?.due ?? [];
  const selectedDose = dueDoses.find((d: any) => d.itemId === dose.itemId);

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {board && <div className="grid grid-cols-3 gap-3">
        {[['مرضى منومون', board.totals.patients], ['جرعات متأخرة', board.totals.overdue_medications], ['مهام رعاية مستحقة', board.totals.due_tasks]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
        ))}
      </div>}

      <Card title="لوحة جناح التمريض">
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
          <th className="th">السرير</th><th className="th">المريض</th><th className="th">آخر علامات</th><th className="th">الجرعة القادمة</th><th className="th">مهام</th><th className="th"></th>
        </tr></thead><tbody>
          {(board?.items ?? []).map((i: any) => {
            const v = i.last_vitals;
            const overdue = i.next_due?.overdueMinutes > 0;
            return <tr key={i.admission_id} className={`${overdue ? 'bg-amber-50/70' : ''} ${active?.admission_id === i.admission_id ? 'ring-1 ring-brand-700' : ''}`}>
              <td className="td">{i.bed_no ? `${i.ward_name} · ${i.room_no}/${i.bed_no}` : 'بدون سرير'}</td>
              <td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn} · {i.doctor_name}</span></td>
              <td className="td text-xs">{v ? `نبض ${v.heart_rate ?? '—'} · ضغط ${v.systolic_bp ?? '—'}/${v.diastolic_bp ?? '—'} · SpO₂ ${v.spo2 ?? '—'} · ${v.temperature_c ?? '—'}°` : '—'}</td>
              <td className="td text-xs">{i.next_due ? <>{i.next_due.drug}<span className={`block ${overdue ? 'text-rose-600 font-semibold' : 'text-slate-500'}`}>{overdue ? `متأخرة ${i.next_due.overdueMinutes} د` : `بعد ${Math.max(0, Math.round((new Date(i.next_due.nextDueAt).getTime() - Date.now()) / 60000))} د`}</span></> : '—'}</td>
              <td className="td text-xs">{i.due_tasks} مستحقة / {i.open_tasks} مفتوحة</td>
              <td className="td"><button className="btn-primary text-xs" onClick={() => open(i)}>فتح الملف التمريضي</button></td>
            </tr>;
          })}
          {(board?.items ?? []).length === 0 && <tr><td className="td text-slate-500" colSpan={6}>لا مرضى منومين حاليًا.</td></tr>}
        </tbody></table></div>
      </Card>

      {active && <div className="grid lg:grid-cols-2 gap-3">
        <Card title={`سجل إعطاء الأدوية — ${active.patient_name}`} action={<button className="btn-ghost text-xs" onClick={() => setActive(null)}>إغلاق</button>}>
          {dueDoses.length === 0 && <p className="text-xs text-slate-500">لا أدوية مفعّلة مصروفة لهذا المريض.</p>}
          {dueDoses.length > 0 && <>
            <select className="input mb-2" value={dose.itemId} onChange={(e) => {
              const d = dueDoses.find((x: any) => x.itemId === e.target.value);
              setDose({ ...dose, itemId: e.target.value, doseGiven: d?.dose ?? '', route: d?.route ?? 'فموي' });
            }}>
              {dueDoses.map((d: any) => <option key={d.itemId} value={d.itemId}>{d.drug} · {d.dose} · {d.frequency}{d.highAlert ? ' · عالي الخطورة' : ''}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">الحالة</label>
                <select className="input" value={dose.status} onChange={(e) => setDose({ ...dose, status: e.target.value })}>
                  <option value="given">أُعطي</option><option value="held">إيقاف</option><option value="refused">رفض المريض</option><option value="missed">فائت</option>
                </select></div>
              <div><label className="label">الجرعة</label><input className="input" value={dose.doseGiven} onChange={(e) => setDose({ ...dose, doseGiven: e.target.value })} /></div>
              <div><label className="label">المسار</label><input className="input" value={dose.route} onChange={(e) => setDose({ ...dose, route: e.target.value })} /></div>
              <div><label className="label">الشاهد (للأدوية عالية الخطورة)</label>
                <select className="input" value={dose.witnessUserId} onChange={(e) => setDose({ ...dose, witnessUserId: e.target.value })}>
                  <option value="">—</option>
                  {nurses.filter((n: any) => n.id !== m.user.id).map((n: any) => <option key={n.id} value={n.id}>{n.full_name_ar}</option>)}
                </select></div>
            </div>
            {dose.status !== 'given' && <input className="input mt-2" placeholder="سبب عدم الإعطاء (إلزامي)" value={dose.reason} onChange={(e) => setDose({ ...dose, reason: e.target.value })} />}
            {dose.status === 'given' && <div className="flex flex-wrap gap-3 text-xs mt-2">
              <label className="flex items-center gap-1"><input type="checkbox" checked={dose.identity} onChange={(e) => setDose({ ...dose, identity: e.target.checked })} /> تحققت من هوية المريض</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={dose.allergy} onChange={(e) => setDose({ ...dose, allergy: e.target.checked })} /> تحققت من الحساسية</label>
            </div>}
            {selectedDose?.highAlert && dose.status === 'given' && <p className="text-xs text-rose-600 mt-1">دواء عالي الخطورة: يلزم شاهد ثانٍ من التمريض.</p>}
            <button className="btn-primary mt-2" disabled={!dose.itemId || (dose.status !== 'given' && dose.reason.length < 5)}
              onClick={() => act(() => api('/api/nursing/mar', { method: 'POST', body: JSON.stringify({
                prescriptionItemId: dose.itemId,
                status: dose.status,
                doseGiven: dose.status === 'given' ? dose.doseGiven : undefined,
                route: dose.status === 'given' ? dose.route : undefined,
                identityVerified: dose.identity,
                allergyChecked: dose.allergy,
                witnessUserId: dose.witnessUserId || undefined,
                reason: dose.status === 'given' ? undefined : dose.reason,
              }) }), 'سُجل إعطاء الدواء')}>تسجيل</button>
          </>}
          <div className="mt-3 border-t pt-2">
            <h4 className="text-sm font-semibold mb-1">آخر ما أُعطي</h4>
            <ul className="text-xs space-y-1 max-h-48 overflow-auto">
              {(mar?.history ?? []).slice(0, 15).map((h: any) => <li key={h.id} className={h.corrects_id ? 'text-slate-400 line-through' : ''}>
                {dt(h.administered_at)} — {h.drug} {h.dose_given ?? ''} · <span className={h.status === 'given' ? 'text-emerald-700' : 'text-rose-600'}>{MAR_LABEL[h.status]}</span>
                {h.witness_name && ` · شاهد: ${h.witness_name}`}{h.reason && ` · ${h.reason}`}
              </li>)}
              {(mar?.history ?? []).length === 0 && <li className="text-slate-500">لا سجلات.</li>}
            </ul>
          </div>
        </Card>

        <Card title="خطة الرعاية">
          {plans.map((p: any) => <div key={p.id} className="border rounded-lg p-2 mb-2">
            <div className="flex justify-between text-sm"><span className="font-semibold">{p.title}</span><Badge value={p.status === 'active' ? 'open' : 'completed'} /></div>
            <p className="text-xs text-slate-500">{p.nursing_diagnosis}</p>
            <p className="text-xs mt-1"><span className="text-slate-500">الأهداف:</span> {p.goals}</p>
            <ul className="text-xs mt-1 space-y-1">
              {p.tasks.map((t: any) => <li key={t.id} className="flex justify-between gap-2">
                <span className={t.status !== 'pending' ? 'line-through text-slate-400' : ''}>{t.description} {t.due_at && <span className="text-slate-400">· {dt(t.due_at)}</span>}</span>
                {t.status === 'pending' && has(m, 'nursing.mar.administer') && p.status === 'active' && <span className="flex gap-1">
                  <button className="btn-ghost text-[11px]" onClick={() => act(() => api(`/api/nursing/care-plan-tasks/${t.id}/complete`, { method: 'POST', body: JSON.stringify({ status: 'done' }) }), 'أُتمت المهمة')}>تم</button>
                  <button className="btn-ghost text-[11px] text-rose-600" onClick={() => {
                    const note = window.prompt('سبب تخطي المهمة (إلزامي)');
                    if (note && note.length >= 5) act(() => api(`/api/nursing/care-plan-tasks/${t.id}/complete`, { method: 'POST', body: JSON.stringify({ status: 'skipped', note }) }), 'تم تخطي المهمة بسبب موثق');
                  }}>تخطٍ</button>
                </span>}
              </li>)}
            </ul>
            {p.status === 'active' && has(m, 'nursing.careplan.manage') && <div className="flex gap-1 mt-2">
              <button className="btn-ghost text-[11px]" onClick={() => {
                const reason = window.prompt('سبب إغلاق الخطة (إلزامي)');
                if (reason && reason.length >= 5) act(() => api(`/api/nursing/care-plans/${p.id}/close`, { method: 'POST', body: JSON.stringify({ status: 'achieved', reason }) }), 'أُغلقت الخطة');
              }}>إغلاق الخطة (تحقق الهدف)</button>
            </div>}
          </div>)}
          {plans.length === 0 && <p className="text-xs text-slate-500 mb-2">لا خطة رعاية بعد.</p>}
          {has(m, 'nursing.careplan.manage') && <div className="border-t pt-2">
            <input className="input mb-1" placeholder="عنوان الخطة" value={planForm.title} onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })} />
            <input className="input mb-1" placeholder="التشخيص التمريضي" value={planForm.diagnosis} onChange={(e) => setPlanForm({ ...planForm, diagnosis: e.target.value })} />
            <input className="input mb-1" placeholder="الأهداف" value={planForm.goals} onChange={(e) => setPlanForm({ ...planForm, goals: e.target.value })} />
            <input className="input mb-1" placeholder="أول مهمة (اختياري)" value={planForm.task} onChange={(e) => setPlanForm({ ...planForm, task: e.target.value })} />
            <button className="btn-primary text-xs" disabled={planForm.title.length < 3 || planForm.diagnosis.length < 5 || planForm.goals.length < 5}
              onClick={() => act(() => api('/api/nursing/care-plans', { method: 'POST', body: JSON.stringify({
                encounterId: active.encounter_id, title: planForm.title, nursingDiagnosis: planForm.diagnosis, goals: planForm.goals,
                tasks: planForm.task ? [{ description: planForm.task }] : [],
              }) }), 'أُنشئت خطة الرعاية', ).then(() => setPlanForm({ title: '', diagnosis: '', goals: '', task: '' }))}>إنشاء خطة</button>
          </div>}
        </Card>

        <Card title="تسليم المناوبة (SBAR)" action={<span className="text-xs text-slate-500">{handovers.length} تسليم</span>}>
          <div className="space-y-2 mb-3">
            {handovers.map((h: any) => <div key={h.id} className="border rounded-lg p-2 text-xs">
              <div className="flex justify-between text-slate-500"><span>{SHIFT_LABEL[h.shift]} · {dt(h.handed_over_at)}</span><span>{CONDITION_LABEL[h.patient_condition]} · من {h.from_name} إلى {h.to_name ?? 'مناوبة عامة'}</span></div>
              <p className="mt-1"><b>S:</b> {h.situation}</p>
              <p><b>B:</b> {h.background}</p>
              <p><b>A:</b> {h.assessment}</p>
              <p><b>R:</b> {h.recommendation}</p>
              {h.acknowledged_at ? <p className="text-emerald-700 mt-1">استُلم بواسطة {h.acknowledged_by_name} — {dt(h.acknowledged_at)}</p>
                : has(m, 'nursing.read') && h.from_user_id !== m.user.id && <button className="btn-ghost text-[11px] mt-1" onClick={() => act(() => api(`/api/nursing/handovers/${h.id}/acknowledge`, { method: 'POST' }), 'استُلم التسليم')}>استلام التسليم</button>}
            </div>)}
            {handovers.length === 0 && <p className="text-xs text-slate-500">لا تسليمات سابقة.</p>}
          </div>
          {has(m, 'nursing.handover.write') && <div className="border-t pt-2">
            <div className="grid grid-cols-2 gap-1 mb-1">
              <select className="input" value={handoverForm.shift} onChange={(e) => setHandoverForm({ ...handoverForm, shift: e.target.value })}>
                <option value="morning">صباحية</option><option value="evening">مسائية</option><option value="night">ليلية</option>
              </select>
              <select className="input" value={handoverForm.condition} onChange={(e) => setHandoverForm({ ...handoverForm, condition: e.target.value })}>
                {Object.entries(CONDITION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {[['situation', 'الوضع الحالي (S)'], ['background', 'الخلفية (B)'], ['assessment', 'التقييم (A)'], ['recommendation', 'التوصية (R)']].map(([k, label]) => (
              <input key={k} className="input mb-1" placeholder={label} value={(handoverForm as any)[k]} onChange={(e) => setHandoverForm({ ...handoverForm, [k]: e.target.value })} />
            ))}
            <button className="btn-primary text-xs" disabled={['situation', 'background', 'assessment', 'recommendation'].some((k) => (handoverForm as any)[k].length < 10)}
              onClick={() => act(() => api('/api/nursing/handovers', { method: 'POST', body: JSON.stringify({
                encounterId: active.encounter_id,
                shift: handoverForm.shift,
                condition: handoverForm.condition,
                situation: handoverForm.situation,
                background: handoverForm.background,
                assessment: handoverForm.assessment,
                recommendation: handoverForm.recommendation,
              }) }), 'سُجل تسليم المناوبة').then(() => setHandoverForm({ ...handoverForm, situation: '', background: '', assessment: '', recommendation: '' }))}>تسجيل التسليم</button>
            <p className="text-[11px] text-slate-500 mt-1">التسليم سجل ثابت لا يُعدّل بعد الحفظ؛ الاستلام يسجّل باسم المستلم.</p>
          </div>}
        </Card>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------- Surgery ----
const SURGERY_STATUS_AR: Record<string, string> = {
  scheduled: 'مجدولة', prepared: 'جاهزة', in_progress: 'قيد العملية', recovery: 'في الإفاقة',
  completed: 'مكتملة', cancelled: 'ملغاة',
};
const PHASE_AR: Record<string, string> = { sign_in: 'قبل التخدير', time_out: 'قبل الشق', sign_out: 'بعد العملية' };

function Surgery({ m }: { m: Me }) {
  const [board, setBoard] = useState<any>(null);
  const [theatres, setTheatres] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<Record<string, boolean>>({});
  const [timeOut, setTimeOut] = useState<Record<string, boolean>>({});
  const [signOut, setSignOut] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState({ instruments: { expected: 0, actual: 0 }, sponges: { expected: 0, actual: 0 }, needles: { expected: 0, actual: 0 } });
  const [discrepancy, setDiscrepancy] = useState('');
  const [anes, setAnes] = useState<any>({ phase: 'maintenance', heartRate: '', systolicBp: '', diastolicBp: '', spo2: '', agent: '', agentDose: '', airway: '' });
  const [pacu, setPacu] = useState<any>({ aldreteScore: 9, painScore: 0, heartRate: '', systolicBp: '', diastolicBp: '', spo2: '', nausea: false, disposition: 'ward', notes: '' });
  const [form, setForm] = useState<any>({ patientId: '', encounterId: '', theatreId: '', procedureName: '', anesthesiologistId: '', scheduledAt: '', estimatedMinutes: 60, priority: 'elective', anesthesiaType: 'general' });
  const [openEncounters, setOpenEncounters] = useState<any[]>([]);

  async function loadBoard() {
    try {
      const b = await api<any>('/api/surgery/board?status=active');
      setBoard(b);
      if (detail) {
        const fresh = await api<any>(`/api/surgery/cases/${detail.id}`);
        setDetail(fresh);
      }
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => {
    loadBoard();
    api<any>('/api/surgery/theatres').then((t) => setTheatres(t.items)).catch((e) => setErr(e.message));
    if (has(m, 'surgery.schedule')) {
      api<any>('/api/patients?limit=100').then((r) => setPatients(r.items ?? [])).catch(() => setPatients([]));
      api<any>('/api/meta/bootstrap').then((b) => setDoctors(b.doctors ?? [])).catch(() => setDoctors([]));
    }
  }, []);

  // Pre-fill the checklist vocabularies once the board publishes them.
  useEffect(() => {
    const cl = board?.checklist;
    if (!cl) return;
    setSignIn((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.sign_in.map((i: any) => [i.key, false]))));
    setTimeOut((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.time_out.map((i: any) => [i.key, false]))));
    setSignOut((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.sign_out.map((i: any) => [i.key, false]))));
  }, [board]);

  async function open(c: any) {
    setErr(null); setOk(null);
    try {
      const d = await api<any>(`/api/surgery/cases/${c.id}`);
      setDetail(d);
      setSignIn(Object.fromEntries((d.checklists ?? []).filter((x: any) => x.phase === 'sign_in').flatMap((x: any) => Object.entries(x.items).filter(([, v]) => typeof v === 'boolean')) as any));
      setTimeOut(Object.fromEntries((d.checklists ?? []).filter((x: any) => x.phase === 'time_out').flatMap((x: any) => Object.entries(x.items).filter(([, v]) => typeof v === 'boolean')) as any));
      setSignOut({});
      setCounts({ instruments: { expected: 0, actual: 0 }, sponges: { expected: 0, actual: 0 }, needles: { expected: 0, actual: 0 } });
      setDiscrepancy('');
    } catch (e: any) { setErr(e.message); }
  }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await loadBoard(); } catch (e: any) { setErr(e.message + (e.details ? ` — ${JSON.stringify(e.details)}` : '')); }
  }
  async function pickPatient(id: string) {
    setForm((f: any) => ({ ...f, patientId: id, encounterId: '' }));
    setOpenEncounters([]);
    if (!id) return;
    try {
      const p = await api<any>(`/api/patients/${id}`);
      setOpenEncounters((p.encounters ?? []).filter((e: any) => e.status === 'open'));
    } catch (e: any) { setErr(e.message); }
  }
  const required = board?.checklist ?? { sign_in: [], time_out: [], sign_out: [] };
  const signInDone = (detail?.checklists ?? []).some((c: any) => c.phase === 'sign_in');
  const timeOutDone = (detail?.checklists ?? []).some((c: any) => c.phase === 'time_out');
  function checklistForm(phase: 'sign_in' | 'time_out' | 'sign_out', state: Record<string, boolean>, setState: (v: any) => void) {
    const items = required[phase] ?? [];
    return (
      <div className="space-y-1">
        {items.map((i: any) => (
          <label key={i.key} className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={!!state[i.key]} onChange={(e) => setState({ ...state, [i.key]: e.target.checked })} />
            <span>{i.label}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {board && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[['قيد العملية', board.totals.in_progress], ['في الإفاقة', board.totals.recovery], ['مجدولة', board.totals.scheduled], ['مكتملة اليوم', board.totals.completed_today]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
        ))}
      </div>}

      <Card title="جدول غرف العمليات">
        <div className="overflow-x-auto"><table className="w-full min-w-[950px]"><thead><tr>
          <th className="th">العملية</th><th className="th">المريض</th><th className="th">الغرفة والفريق</th><th className="th">الموعد</th><th className="th">التحقق</th><th className="th">الحالة</th><th className="th"></th>
        </tr></thead><tbody>
          {(board?.items ?? []).map((c: any) => (
            <tr key={c.id} className={c.status === 'in_progress' ? 'bg-emerald-50/60' : c.status === 'recovery' ? 'bg-amber-50/60' : ''}>
              <td className="td">{c.procedure_name}<span className="block text-xs text-slate-400">{c.case_no} · {c.priority === 'emergency' ? 'طارئة' : c.priority === 'urgent' ? 'عاجلة' : 'مجدولة'}</span></td>
              <td className="td">{c.patient_name}<span className="block text-xs text-slate-400">{c.mrn}</span></td>
              <td className="td text-xs">{c.theatre_name}<span className="block text-slate-500">{c.surgeon_name}{c.anesthesiologist_name ? ` · تخدير: ${c.anesthesiologist_name}` : ''}</span></td>
              <td className="td text-xs">{dt(c.scheduled_at)}<span className="block text-slate-400">{c.estimated_minutes} د</span></td>
              <td className="td text-xs">{c.preop_checks}/2 قوائم{c.observations > 0 ? ` · ${c.observations} قياس تخدير` : ''}{c.counts_correct === false && <span className="block text-rose-600">عدّ غير مطابق</span>}</td>
              <td className="td"><span className="badge bg-slate-100 text-slate-700">{SURGERY_STATUS_AR[c.status] ?? c.status}</span></td>
              <td className="td"><button className="btn-ghost text-xs" onClick={() => open(c)}>فتح</button></td>
            </tr>
          ))}
          {(board?.items ?? []).length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا عمليات نشطة.</td></tr>}
        </tbody></table></div>
      </Card>

      {detail && <div className="grid lg:grid-cols-2 gap-3">
        <Card title={`${detail.procedure_name} — ${detail.patient_name}`} action={<button className="btn-ghost text-xs" onClick={() => setDetail(null)}>إغلاق</button>}>
          <div className="text-xs space-y-1 text-slate-600">
            <p>{detail.case_no} · {SURGERY_STATUS_AR[detail.status]} · {detail.theatre_name} · {detail.theatre_code}</p>
            <p>المريض: {detail.patient_name} ({detail.mrn}) · فصيلة {detail.blood_type ?? '—'} · زيارة {detail.encounter_no}</p>
            <p>الجراح: {detail.surgeon_name} · التخدير: {detail.anesthesiologist_name ?? '—'} ({detail.anesthesia_type})</p>
            <p>الموعد: {dt(detail.scheduled_at)} · المدة المتوقعة {detail.estimated_minutes} د</p>
            {detail.started_at && <p>بدأت: {dt(detail.started_at)} {detail.closed_at ? `· أُغلقت: ${dt(detail.closed_at)}` : ''}</p>}
            {detail.counts_correct === false && <p className="text-rose-700">⚠ عدّ غير مطابق: {detail.count_discrepancy}</p>}
            {detail.cancel_reason && <p className="text-rose-700">ملغاة: {detail.cancel_reason}</p>}
          </div>

          <div className="mt-3 border-t pt-2 space-y-2">
            {(detail.checklists ?? []).map((ch: any) => (
              <div key={ch.id} className="border rounded-lg p-2">
                <p className="text-xs font-semibold">{PHASE_AR[ch.phase]} — {dt(ch.completed_at)} · {ch.completed_by_name ?? ''}</p>
                <ul className="text-[11px] text-slate-600 mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-2">
                  {(ch.required ?? []).map((r: any) => <li key={r.key} className={ch.items?.[r.key] === true ? 'text-emerald-700' : 'text-slate-400'}>{ch.items?.[r.key] === true ? '✓' : '✗'} {r.label}</li>)}
                </ul>
                {ch.phase === 'sign_out' && <p className="text-[11px] mt-1">{ch.items?.counts?.instruments && `أدوات ${ch.items.counts.instruments.actual}/${ch.items.counts.instruments.expected} · كمامات ${ch.items.counts.sponges.actual}/${ch.items.counts.sponges.expected} · إبر ${ch.items.counts.needles.actual}/${ch.items.counts.needles.expected}`}</p>}
              </div>
            ))}
            {(detail.checklists ?? []).length === 0 && <p className="text-xs text-slate-500">لا قوائم تحقق مسجلة بعد.</p>}
          </div>

          {detail.status === 'scheduled' && !signInDone && (has(m, 'surgery.checklist') || has(m, 'anesthesia.perform')) && <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">قائمة ما قبل التخدير (WHO)</p>
            {checklistForm('sign_in', signIn, setSignIn)}
            <button className="btn-primary text-xs mt-2" onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/checklists`, { method: 'POST', body: JSON.stringify({ phase: 'sign_in', items: signIn }) }), 'سُجلت قائمة ما قبل التخدير')}>تسجيل القائمة</button>
          </div>}

          {detail.status === 'prepared' && !timeOutDone && (has(m, 'surgery.checklist') || has(m, 'anesthesia.perform')) && <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">قائمة ما قبل الشق (WHO)</p>
            {checklistForm('time_out', timeOut, setTimeOut)}
            <button className="btn-primary text-xs mt-2" onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/checklists`, { method: 'POST', body: JSON.stringify({ phase: 'time_out', items: timeOut }) }), 'سُجلت قائمة ما قبل الشق')}>تسجيل القائمة</button>
          </div>}

          {detail.status === 'prepared' && timeOutDone && has(m, 'surgery.perform') && <div className="mt-3 border-t pt-2">
            <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/start`, { method: 'POST' }), 'بدأت العملية')}>بدء العملية</button>
          </div>}

          {['scheduled', 'prepared'].includes(detail.status) && has(m, 'surgery.schedule') && <div className="mt-3 border-t pt-2">
            <button className="btn-ghost text-xs text-rose-600" onClick={() => {
              const reason = window.prompt('سبب إلغاء العملية (إلزامي)');
              if (reason && reason.length >= 5) act(() => api(`/api/surgery/cases/${detail.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }), 'أُلغيت العملية بسبب موثق');
            }}>إلغاء العملية</button>
          </div>}
        </Card>

        <Card title="التخدير والإفاقة">
          {detail.status === 'in_progress' && has(m, 'anesthesia.perform') && <div className="space-y-1 mb-3">
            <p className="text-sm font-semibold">قياس تخدير جديد</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
              <select className="input" value={anes.phase} onChange={(e) => setAnes({ ...anes, phase: e.target.value })}>
                <option value="induction">تحريض</option><option value="maintenance">استمرار</option><option value="emergence">إفاقة</option>
              </select>
              <input className="input" placeholder="نبض" value={anes.heartRate} onChange={(e) => setAnes({ ...anes, heartRate: e.target.value })} />
              <input className="input" placeholder="انقباضي" value={anes.systolicBp} onChange={(e) => setAnes({ ...anes, systolicBp: e.target.value })} />
              <input className="input" placeholder="انبساطي" value={anes.diastolicBp} onChange={(e) => setAnes({ ...anes, diastolicBp: e.target.value })} />
              <input className="input" placeholder="SpO₂" value={anes.spo2} onChange={(e) => setAnes({ ...anes, spo2: e.target.value })} />
              <input className="input" placeholder="الدواء التخديري" value={anes.agent} onChange={(e) => setAnes({ ...anes, agent: e.target.value })} />
            </div>
            <button className="btn-primary text-xs" disabled={!anes.heartRate && !anes.spo2 && !anes.agent}
              onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/anesthesia`, { method: 'POST', body: JSON.stringify({
                phase: anes.phase,
                heartRate: anes.heartRate ? Number(anes.heartRate) : undefined,
                systolicBp: anes.systolicBp ? Number(anes.systolicBp) : undefined,
                diastolicBp: anes.diastolicBp ? Number(anes.diastolicBp) : undefined,
                spo2: anes.spo2 ? Number(anes.spo2) : undefined,
                agent: anes.agent || undefined,
              }) }), 'سُجل قياس التخدير')}>حفظ القياس</button>
          </div>}

          {(detail.anesthesia ?? []).length > 0 && <div className="mb-3">
            <p className="text-sm font-semibold mb-1">سجل التخدير ({detail.anesthesia.length})</p>
            <ul className="text-xs space-y-1 max-h-40 overflow-auto">
              {detail.anesthesia.map((r: any) => <li key={r.id} className="border-b pb-1">
                {dt(r.recorded_at)} · {r.phase === 'induction' ? 'تحريض' : r.phase === 'emergence' ? 'إفاقة' : 'استمرار'}
                {r.heart_rate && ` · نبض ${r.heart_rate}`}{r.systolic_bp && ` · ضغط ${r.systolic_bp}/${r.diastolic_bp ?? '—'}`}{r.spo2 && ` · SpO₂ ${r.spo2}`}
                {r.agent && ` · ${r.agent} ${r.agent_dose ?? ''}`}
                <span className="block text-slate-400">{r.recorded_by_name}</span>
              </li>)}
            </ul>
          </div>}

          {detail.status === 'in_progress' && has(m, 'surgery.perform') && <div className="border-t pt-2">
            <p className="text-sm font-semibold mb-1">قائمة ما بعد العملية وعدّ الأدوات</p>
            {checklistForm('sign_out', signOut, setSignOut)}
            <div className="grid grid-cols-3 gap-1 mt-2">
              {(['instruments', 'sponges', 'needles'] as const).map((k) => (
                <div key={k} className="text-[11px]">
                  <p className="text-slate-500">{k === 'instruments' ? 'أدوات' : k === 'sponges' ? 'كمامات' : 'إبر'}</p>
                  <div className="flex gap-1">
                    <input className="input" type="number" placeholder="متوقع" value={counts[k].expected} onChange={(e) => setCounts({ ...counts, [k]: { ...counts[k], expected: Number(e.target.value) } })} />
                    <input className="input" type="number" placeholder="فعلي" value={counts[k].actual} onChange={(e) => setCounts({ ...counts, [k]: { ...counts[k], actual: Number(e.target.value) } })} />
                  </div>
                </div>
              ))}
            </div>
            <input className="input mt-1" placeholder="ملاحظة عدم التطابق (إلزامية عند الاختلاف)" value={discrepancy} onChange={(e) => setDiscrepancy(e.target.value)} />
            <button className="btn-primary text-xs mt-2" onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/close`, { method: 'POST', body: JSON.stringify({
              signOut, counts, ...(discrepancy.length >= 15 ? { discrepancyNote: discrepancy } : {}),
            }) }), 'أُغلقت العملية وسُجلت الرسوم')}>إغلاق العملية</button>
          </div>}

          {detail.status === 'recovery' && (has(m, 'anesthesia.perform') || has(m, 'surgery.checklist') || has(m, 'surgery.perform')) && <div className="border-t pt-2">
            <p className="text-sm font-semibold mb-1">تسجيل الإفاقة (ألدريتي)</p>
            <div className="grid grid-cols-2 gap-1">
              <input className="input" type="number" min={0} max={10} placeholder="درجة ألدريتي" value={pacu.aldreteScore} onChange={(e) => setPacu({ ...pacu, aldreteScore: Number(e.target.value) })} />
              <input className="input" type="number" min={0} max={10} placeholder="درجة الألم" value={pacu.painScore} onChange={(e) => setPacu({ ...pacu, painScore: Number(e.target.value) })} />
              <input className="input" placeholder="نبض" value={pacu.heartRate} onChange={(e) => setPacu({ ...pacu, heartRate: e.target.value })} />
              <input className="input" placeholder="SpO₂" value={pacu.spo2} onChange={(e) => setPacu({ ...pacu, spo2: e.target.value })} />
              <select className="input" value={pacu.disposition} onChange={(e) => setPacu({ ...pacu, disposition: e.target.value })}>
                <option value="ward">إلى الجناح</option><option value="icu">إلى العناية المركزة</option><option value="day_surgery_discharge">خروج من جراحة اليوم الواحد</option>
              </select>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={pacu.nausea} onChange={(e) => setPacu({ ...pacu, nausea: e.target.checked })} /> غثيان</label>
            </div>
            <button className="btn-primary text-xs mt-2" disabled={pacu.aldreteScore < 8}
              onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/recovery`, { method: 'POST', body: JSON.stringify({
                aldreteScore: Number(pacu.aldreteScore), painScore: Number(pacu.painScore),
                heartRate: pacu.heartRate ? Number(pacu.heartRate) : undefined, spo2: pacu.spo2 ? Number(pacu.spo2) : undefined,
                nausea: pacu.nausea, disposition: pacu.disposition, notes: pacu.notes || undefined,
              }) }), 'أُكملت العملية بعد الإفاقة')}>إتمام العملية</button>
            <p className="text-[11px] text-slate-500 mt-1">لا يُسمح بالنقل قبل درجة ألدريتي ٨ أو أعلى.</p>
          </div>}

          {detail.pacu && <div className="mt-3 border-t pt-2 text-xs">
            <p className="font-semibold">سجل الإفاقة</p>
            <p>ألدريتي {detail.pacu.aldrete_score}/10 · ألم {detail.pacu.pain_score ?? '—'} · {detail.pacu.disposition === 'ward' ? 'نُقل للجناح' : detail.pacu.disposition === 'icu' ? 'نُقل للعناية' : 'خروج'}</p>
            <p className="text-slate-500">{dt(detail.pacu.recorded_at)} · {detail.pacu.recorded_by_name}</p>
          </div>}
        </Card>
      </div>}

      {has(m, 'surgery.schedule') && <Card title="جدولة عملية جديدة">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <div><label className="label">المريض</label>
            <select className="input" value={form.patientId} onChange={(e) => pickPatient(e.target.value)}>
              <option value="">—</option>
              {patients.map((p: any) => <option key={p.id} value={p.id}>{p.fullNameAr ?? p.full_name_ar} · {p.mrn}</option>)}
            </select></div>
          <div><label className="label">الزيارة المفتوحة</label>
            <select className="input" value={form.encounterId} onChange={(e) => setForm({ ...form, encounterId: e.target.value })}>
              <option value="">—</option>
              {openEncounters.map((e: any) => <option key={e.id} value={e.id}>{e.encounter_no} · {e.department}</option>)}
            </select></div>
          <div><label className="label">غرفة العمليات</label>
            <select className="input" value={form.theatreId} onChange={(e) => setForm({ ...form, theatreId: e.target.value })}>
              <option value="">—</option>
              {theatres.map((t: any) => <option key={t.id} value={t.id}>{t.name_ar}</option>)}
            </select></div>
          <div><label className="label">اسم الإجراء</label>
            <input className="input" value={form.procedureName} onChange={(e) => setForm({ ...form, procedureName: e.target.value })} /></div>
          <div><label className="label">التاريخ والوقت</label>
            <input className="input" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></div>
          <div><label className="label">طبيب التخدير</label>
            <select className="input" value={form.anesthesiologistId} onChange={(e) => setForm({ ...form, anesthesiologistId: e.target.value })}>
              <option value="">—</option>
              {doctors.filter((d: any) => d.role_id === 'anesthesiologist').map((d: any) => <option key={d.id} value={d.id}>{d.full_name_ar}</option>)}
            </select></div>
        </div>
        <button className="btn-primary text-xs mt-2" disabled={!form.patientId || !form.encounterId || !form.theatreId || form.procedureName.length < 3 || !form.scheduledAt}
          onClick={() => act(async () => {
            await api('/api/surgery/cases', { method: 'POST', body: JSON.stringify({
              patientId: form.patientId, encounterId: form.encounterId, theatreId: form.theatreId,
              procedureName: form.procedureName,
              anesthesiologistId: form.anesthesiologistId || undefined,
              priority: form.priority, anesthesiaType: form.anesthesiaType,
              scheduledAt: new Date(form.scheduledAt).toISOString(),
              estimatedMinutes: Number(form.estimatedMinutes),
            }) });
            setForm({ ...form, procedureName: '', scheduledAt: '', encounterId: '' });
          }, 'جُدولت العملية')}>جدولة</button>
        <p className="text-[11px] text-slate-500 mt-1">تُرفض الجدولة عند تعارض الوقت في الغرفة أو إذا لم تملك صلاحية الجدولة.</p>
      </Card>}
    </div>
  );
}

// -------------------------------------------------------------------- ICU ----
const VENT_AR: Record<string, string> = {
  ac: 'تحكم بالحجم/الضغط', simv: 'SIMV', psv: 'دعم ضغط', cpap: 'CPAP', hfnc: 'أكسجين عالي التدفق', room_air: 'هواء محيط',
};
const ICU_DISPOSITION_AR: Record<string, string> = {
  ward: 'نقل للجناح', transfer: 'تحويل لمنشأة أخرى', home: 'خروج للمنزل', deceased: 'وفاة', against_advice: 'خروج ضد النصيحة الطبية',
};
const GOAL_LABELS: [string, string][] = [
  ['sedationTarget', 'هدف التهدئة اليومي'], ['headOfBedElevated', 'رأس السرير مرفوع ٣٠-٤٥°'],
  ['vapBundle', 'حزمة الوقاية من التهاب الرئة'], ['dvtProphylaxis', 'وقاية من الجلطات'],
  ['stressUlcerProphylaxis', 'وقاية قرحة الضغط'], ['nutritionPlan', 'خطة تغذية'],
  ['earlyMobility', 'حركة مبكرة'],
];

function Icu({ m }: { m: Me }) {
  const [board, setBoard] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [obs, setObs] = useState<any>({ heartRate: '', systolicBp: '', diastolicBp: '', respRate: '', spo2: '', temperatureC: '', gcs: '', rass: '', urineMl: '', notes: '' });
  const [vent, setVent] = useState<any>({ mode: 'ac', fio2Pct: 40, peepCmh2o: 5, tidalVolumeMl: 450, setRate: 16, reason: '' });
  const [sofa, setSofa] = useState<any>({ pao2: 90, fio2Pct: 40, respiratorySupport: true, platelets: 200, bilirubin: 0.8, map: 75, vasopressor: 'none', gcs: 15, creatinine: 1, urine24hMl: '' });
  const [goals, setGoals] = useState<any>({});
  const [closing, setClosing] = useState({ disposition: 'ward', note: '' });
  const [admissions, setAdmissions] = useState<any[]>([]);
  const [openFor, setOpenFor] = useState('');

  async function load() {
    try {
      const b = await api<any>('/api/icu/board');
      setBoard(b);
      if (detail) setDetail(await api<any>(`/api/icu/stays/${detail.id}`));
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => {
    load();
    if (has(m, 'icu.manage')) {
      api<any>('/api/inpatient/admissions').then((r) => setAdmissions((r.items ?? []).filter((a: any) => a.status === 'active'))).catch(() => setAdmissions([]));
    }
  }, []);

  async function open(s: any) {
    setErr(null); setOk(null);
    try {
      const d = await api<any>(`/api/icu/stays/${s.id}`);
      setDetail(d);
      const today = d.goals?.[0];
      setGoals(today ? Object.fromEntries(GOAL_LABELS.map(([k]) => [k, !!today[k]])) : Object.fromEntries(GOAL_LABELS.map(([k]) => [k, false])));
    } catch (e: any) { setErr(e.message); }
  }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await load(); } catch (e: any) { setErr(e.message + (e.details ? ` — ${JSON.stringify(e.details)}` : '')); }
  }
  const latest = detail?.observations?.[0];
  const latestVent = detail?.ventilator?.[0];
  const latestSofa = detail?.scores?.[0];

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      {board && <div className="grid grid-cols-3 gap-3">
        {[['مرضى العناية', board.totals.patients], ['على دعم تنفسي', board.totals.ventilated], ['متوسط SOFA', board.totals.avg_sofa]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
        ))}
      </div>}

      <Card title="لوحة العناية المركزة">
        <div className="overflow-x-auto"><table className="w-full min-w-[950px]"><thead><tr>
          <th className="th">السرير</th><th className="th">المريض</th><th className="th">آخر علامات</th><th className="th">التنفس</th><th className="th">SOFA</th><th className="th">حزمة اليوم</th><th className="th"></th>
        </tr></thead><tbody>
          {(board?.items ?? []).map((i: any) => (
            <tr key={i.id} className={(i.sofa_total ?? 0) >= 10 ? 'bg-rose-50/60' : ''}>
              <td className="td text-xs">{i.ward_name} · {i.room_no}/{i.bed_no}<span className="block text-slate-400">{i.stay_no}</span></td>
              <td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn} · {i.admission_no}</span></td>
              <td className="td text-xs">{i.last_observed_at ? <>نبض {i.heart_rate ?? '—'} · {i.systolic_bp ?? '—'}/{i.diastolic_bp ?? '—'} · SpO₂ {i.spo2 ?? '—'} · GCS {i.gcs ?? '—'}<span className="block text-slate-400">{dt(i.last_observed_at)}</span></> : '—'}</td>
              <td className="td text-xs">{i.vent_mode ? <>{VENT_AR[i.vent_mode] ?? i.vent_mode}<span className="block text-slate-500">FiO₂ {i.fio2_pct}% · PEEP {i.peep_cmh2o ?? '—'}</span></> : 'بلا دعم'}</td>
              <td className="td"><span className={`font-bold ${(i.sofa_total ?? 0) >= 10 ? 'text-rose-700' : (i.sofa_total ?? 0) >= 6 ? 'text-amber-700' : 'text-slate-700'}`}>{i.sofa_total ?? '—'}</span>{i.sofa_at && <span className="block text-[11px] text-slate-400">{dt(i.sofa_at)}</span>}</td>
              <td className="td text-xs">{i.bundled_today ? <span className="text-emerald-700">مسجلة ✓</span> : <span className="text-amber-700">غير مسجلة</span>}</td>
              <td className="td"><button className="btn-ghost text-xs" onClick={() => open(i)}>فتح الملف</button></td>
            </tr>
          ))}
          {(board?.items ?? []).length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا مرضى في العناية المركزة.</td></tr>}
        </tbody></table></div>
      </Card>

      {has(m, 'icu.manage') && <Card title="فتح إقامة عناية مركزة">
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[240px]"><label className="label">تنويم نشط في سرير عناية</label>
            <select className="input" value={openFor} onChange={(e) => setOpenFor(e.target.value)}>
              <option value="">—</option>
              {admissions.map((a: any) => <option key={a.id} value={a.id}>{a.admission_no} · {a.patient_name} · {a.ward_name ?? ''}</option>)}
            </select></div>
          <button className="btn-primary text-xs" disabled={!openFor} onClick={() => act(async () => {
            await api('/api/icu/stays', { method: 'POST', body: JSON.stringify({ admissionId: openFor }) });
            setOpenFor('');
          }, 'فُتحت إقامة العناية')}>فتح الإقامة</button>
        </div>
        <p className="text-[11px] text-slate-500 mt-1">يشترط تنويمًا نشطًا على سرير عناية مركزة؛ النقل يتم من صفحة التنويم.</p>
      </Card>}

      {detail && <div className="grid lg:grid-cols-2 gap-3">
        <Card title={`${detail.patient_name} — ${detail.stay_no}`} action={<button className="btn-ghost text-xs" onClick={() => setDetail(null)}>إغلاق</button>}>
          <div className="text-xs space-y-1 text-slate-600">
            <p>{detail.ward_name} · {detail.room_no}/{detail.bed_no} · تنويم {detail.admission_no}</p>
            <p>الطبيب المعالج: {detail.intensivist_name ?? '—'} · بدأت {dt(detail.opened_at)}</p>
            {detail.admission_note && <p>سبب القبول: {detail.admission_note}</p>}
            <p>الحالة: {detail.status === 'active' ? 'نشطة' : `مغلقة — ${ICU_DISPOSITION_AR[detail.discharge_disposition] ?? ''}`}</p>
            {detail.closing_note && <p className="text-slate-500">ملاحظة الإغلاق: {detail.closing_note}</p>}
            {latestSofa && <p>آخر SOFA: <b>{latestSofa.total}</b> / 24 — {dt(latestSofa.recorded_at)}</p>}
          </div>

          <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">آخر العلامات الحيوية</p>
            {latest ? <div className="grid grid-cols-2 sm:grid-cols-3 gap-1 text-xs">
              <p>نبض: {latest.heart_rate ?? '—'}</p><p>ضغط: {latest.systolic_bp ?? '—'}/{latest.diastolic_bp ?? '—'}</p>
              <p>تنفس: {latest.resp_rate ?? '—'}</p><p>SpO₂: {latest.spo2 ?? '—'}%</p><p>حرارة: {latest.temperature_c ?? '—'}</p>
              <p>GCS: {latest.gcs ?? '—'}</p><p>RASS: {latest.rass ?? '—'}</p><p>بول: {latest.urine_ml ?? '—'} مل</p>
            </div> : <p className="text-xs text-slate-500">لا قياسات بعد.</p>}
          </div>

          {detail.status === 'active' && has(m, 'icu.chart') && <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">تسجيل علامات حيوية</p>
            <div className="grid grid-cols-3 gap-1">
              {[['heartRate', 'نبض'], ['systolicBp', 'انقباضي'], ['diastolicBp', 'انبساطي'], ['respRate', 'تنفس'], ['spo2', 'SpO₂'], ['temperatureC', 'حرارة'], ['gcs', 'GCS'], ['rass', 'RASS'], ['urineMl', 'بول/ساعة']].map(([k, label]) => (
                <input key={k} className="input" placeholder={label} value={obs[k]} onChange={(e) => setObs({ ...obs, [k]: e.target.value })} />
              ))}
            </div>
            <input className="input mt-1" placeholder="ملاحظة (اختياري)" value={obs.notes} onChange={(e) => setObs({ ...obs, notes: e.target.value })} />
            <button className="btn-primary text-xs mt-2" disabled={!Object.entries(obs).some(([k, v]) => k !== 'notes' && v !== '')}
              onClick={() => act(async () => {
                await api(`/api/icu/stays/${detail.id}/observations`, { method: 'POST', body: JSON.stringify({
                  ...Object.fromEntries(Object.entries(obs).filter(([k, v]) => k !== 'notes' && v !== '').map(([k, v]) => [k, k === 'temperatureC' ? Number(v) : Number(v)])),
                  notes: obs.notes || undefined,
                }) });
                setObs({ ...obs, notes: '' });
              }, 'سُجلت العلامات الحيوية')}>حفظ القياسات</button>
          </div>}

          {detail.status === 'active' && has(m, 'icu.discharge') && <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">إغلاق الإقامة</p>
            <div className="flex flex-wrap gap-1">
              <select className="input" value={closing.disposition} onChange={(e) => setClosing({ ...closing, disposition: e.target.value })}>
                {Object.entries(ICU_DISPOSITION_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input className="input flex-1 min-w-[220px]" placeholder="ملاحظة الإغلاق (١٥ حرفًا على الأقل)" value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} />
              <button className="btn-ghost text-xs text-rose-600" disabled={closing.note.trim().length < 15}
                onClick={() => act(() => api(`/api/icu/stays/${detail.id}/discharge`, { method: 'POST', body: JSON.stringify(closing) }), 'أُغلقت إقامة العناية')}>إغلاق</button>
            </div>
          </div>}
        </Card>

        <Card title="التنفس الصناعي وSOFA وحزمة الرعاية">
          <div className="text-xs mb-2">
            <p className="font-semibold">الإعداد الحالي</p>
            {latestVent ? <p>{VENT_AR[latestVent.mode]} · FiO₂ {latestVent.fio2_pct}% · PEEP {latestVent.peep_cmh2o ?? '—'} · {latestVent.tidal_volume_ml ?? '—'} مل · {latestVent.set_rate ?? '—'} نفس/د</p> : <p className="text-slate-500">لا إعدادات مسجلة.</p>}
          </div>
          {detail.status === 'active' && has(m, 'icu.ventilator') && <div className="border-t pt-2 mb-2">
            <div className="grid grid-cols-2 gap-1">
              <select className="input" value={vent.mode} onChange={(e) => setVent({ ...vent, mode: e.target.value })}>
                {Object.entries(VENT_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input className="input" type="number" placeholder="FiO₂ %" value={vent.fio2Pct} onChange={(e) => setVent({ ...vent, fio2Pct: Number(e.target.value) })} />
              <input className="input" type="number" placeholder="PEEP" value={vent.peepCmh2o} onChange={(e) => setVent({ ...vent, peepCmh2o: Number(e.target.value) })} />
              <input className="input" type="number" placeholder="حجم المد" value={vent.tidalVolumeMl} onChange={(e) => setVent({ ...vent, tidalVolumeMl: Number(e.target.value) })} />
            </div>
            <input className="input mt-1" placeholder="سبب التغيير" value={vent.reason} onChange={(e) => setVent({ ...vent, reason: e.target.value })} />
            <button className="btn-primary text-xs mt-1" onClick={() => act(() => api(`/api/icu/stays/${detail.id}/ventilator`, { method: 'POST', body: JSON.stringify({ ...vent, reason: vent.reason || undefined }) }), 'سُجلت إعدادات التنفس (إصدار جديد)')}>تسجيل الإعدادات</button>
          </div>}

          {(detail.ventilator ?? []).length > 0 && <div className="mb-2">
            <p className="text-xs font-semibold mb-1">سجل التغييرات</p>
            <ul className="text-[11px] space-y-1 max-h-28 overflow-auto">
              {detail.ventilator.map((v: any) => <li key={v.id}>{dt(v.recorded_at)} — {VENT_AR[v.mode]} · FiO₂ {v.fio2_pct}%{v.reason ? ` · ${v.reason}` : ''}<span className="block text-slate-400">{v.recorded_by_name}</span></li>)}
            </ul>
          </div>}

          {detail.status === 'active' && has(m, 'icu.chart') && <div className="border-t pt-2">
            <p className="text-sm font-semibold mb-1">حزمة الرعاية اليومية</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-2">
              {GOAL_LABELS.map(([k, label]) => <label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!goals[k]} onChange={(e) => setGoals({ ...goals, [k]: e.target.checked })} /> {label}</label>)}
            </div>
            <button className="btn-primary text-xs mt-1" onClick={() => act(() => api(`/api/icu/stays/${detail.id}/goals`, { method: 'POST', body: JSON.stringify(goals) }), goals && 'حُفظت حزمة اليوم')}>حفظ الحزمة</button>
          </div>}

          {detail.status === 'active' && has(m, 'icu.chart') && <div className="border-t pt-2 mt-2">
            <p className="text-sm font-semibold mb-1">حساب SOFA</p>
            <div className="grid grid-cols-3 gap-1">
              {[['pao2', 'PaO₂'], ['fio2Pct', 'FiO₂ %'], ['platelets', 'صفيحات'], ['bilirubin', 'بيليروبين'], ['map', 'MAP'], ['gcs', 'GCS'], ['creatinine', 'كرياتينين'], ['urine24hMl', 'بول ٢٤س']].map(([k, label]) => (
                <input key={k} className="input" type="number" placeholder={label} value={sofa[k]} onChange={(e) => setSofa({ ...sofa, [k]: e.target.value === '' ? '' : Number(e.target.value) })} />
              ))}
              <select className="input" value={sofa.vasopressor} onChange={(e) => setSofa({ ...sofa, vasopressor: e.target.value })}>
                <option value="none">بلا رافع ضغط</option><option value="dobutamine">دوبوتامين</option>
                <option value="dopamine_low">دوبامين ≤5</option><option value="dopamine_mid">دوبامين &gt;5</option><option value="dopamine_high">دوبامين &gt;15</option>
                <option value="norepinephrine_low">نورإبينفرين ≤0.1</option><option value="norepinephrine_high">نورإبينفرين &gt;0.1</option>
                <option value="epinephrine_low">إبينفرين ≤0.1</option><option value="epinephrine_high">إبينفرين &gt;0.1</option>
              </select>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={sofa.respiratorySupport} onChange={(e) => setSofa({ ...sofa, respiratorySupport: e.target.checked })} /> دعم تنفسي</label>
            </div>
            <button className="btn-primary text-xs mt-1" onClick={() => act(() => api(`/api/icu/stays/${detail.id}/sofa`, { method: 'POST', body: JSON.stringify({
              ...sofa,
              pao2: Number(sofa.pao2), fio2Pct: Number(sofa.fio2Pct), platelets: Number(sofa.platelets),
              bilirubin: Number(sofa.bilirubin), map: Number(sofa.map), gcs: Number(sofa.gcs), creatinine: Number(sofa.creatinine),
              urine24hMl: sofa.urine24hMl === '' ? undefined : Number(sofa.urine24hMl),
            }) }), 'حُسبت درجة SOFA')}>حساب وحفظ</button>
          </div>}

          {(detail.scores ?? []).length > 0 && <div className="border-t pt-2 mt-2">
            <p className="text-xs font-semibold mb-1">سجل الدرجات</p>
            <ul className="text-[11px] space-y-1 max-h-28 overflow-auto">
              {detail.scores.map((s: any) => <li key={s.id}><b>{s.total}</b> / 24 — {dt(s.recorded_at)}<span className="block text-slate-400">تنفس {s.components.respiration} · تخثر {s.components.coagulation} · كبد {s.components.liver} · قلب {s.components.cardiovascular} · وعي {s.components.cns} · كلية {s.components.renal}</span></li>)}
            </ul>
          </div>}
        </Card>
      </div>}
    </div>
  );
}

// -------------------------------------------------------------- Radiology ----
const MODALITY_LABEL: Record<string, string> = {
  xray: 'أشعة سينية', ct: 'مقطعية', mri: 'رنين مغناطيسي', us: 'سونار', mammography: 'ماموغرام', fluoroscopy: 'فلوروسكوبي',
};

function Radiology({ m }: { m: Me }) {
  const [items, setItems] = useState<any[]>([]); const [status, setStatus] = useState('active');
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({ findings: '', impression: '', recommendation: '', critical: false });
  const [ackNote, setAckNote] = useState(''); const [cancelReason, setCancelReason] = useState('');

  async function load() {
    try { const r = await api<any>(`/api/radiology/worklist?status=${status}`); setItems(r.items); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [status]);
  async function open(id: string) {
    try { setDetail(await api(`/api/radiology/orders/${id}`)); } catch (e: any) { setErr(e.message); }
  }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await load(); if (detail) await open(detail.order.id); }
    catch (e: any) { setErr(e.message); }
  }
  const draft = detail?.reports.find((r: any) => r.status === 'draft');
  const finalReport = detail?.reports.find((r: any) => r.status === 'final');
  const o = detail?.order;

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      <Card title="قائمة عمل الأشعة" action={<select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="active">النشطة</option><option value="ordered">بالانتظار</option><option value="in_progress">قيد التصوير</option>
        <option value="performed">بانتظار التقرير</option><option value="verified">معتمدة</option><option value="cancelled">ملغاة</option><option value="all">الكل</option>
      </select>}>
        <div className="overflow-x-auto"><table className="w-full min-w-[820px]"><thead><tr>
          <th className="th">الرقم</th><th className="th">المريض</th><th className="th">الفحص</th><th className="th">الأولوية</th><th className="th">الحالة</th><th className="th">طالب الفحص</th><th className="th"></th>
        </tr></thead><tbody>
          {items.map((i: any) => <tr key={i.id} className={i.priority === 'stat' ? 'bg-rose-50/60' : ''}>
            <td className="td font-mono text-xs">{i.order_no}</td>
            <td className="td">{i.patient_name}<span className="block text-xs text-slate-400">{i.mrn} · {i.encounter_no}</span></td>
            <td className="td">{i.modality_ar}<span className="block text-xs text-slate-400">{i.body_part}</span></td>
            <td className="td"><Badge value={i.priority === 'stat' ? 'urgent' : i.priority === 'urgent' ? 'in_consultation' : 'open'} /> <span className="text-xs text-slate-500">{i.priority}</span></td>
            <td className="td"><Badge value={i.status === 'verified' ? 'completed' : i.status === 'cancelled' ? 'cancelled' : 'open'} /> <span className="text-xs text-slate-500">{i.status}</span>{i.critical && <span className="badge bg-rose-600 text-white ms-1">حرجة</span>}</td>
            <td className="td text-xs">{i.ordered_by_name}</td>
            <td className="td"><button className="btn-ghost text-xs" onClick={() => open(i.id)}>فتح</button></td>
          </tr>)}
          {items.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا طلبات في هذه الحالة.</td></tr>}
        </tbody></table></div>
      </Card>

      {o && <Card title={`${o.order_no} — ${o.patient_name}`} action={<button className="btn-ghost text-xs" onClick={() => { setDetail(null); setForm({ findings: '', impression: '', recommendation: '', critical: false }); }}>إغلاق</button>}>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="text-sm space-y-1">
            <p><span className="text-slate-500">الفحص:</span> {MODALITY_LABEL[o.modality]} — {o.body_part}</p>
            <p><span className="text-slate-500">المبرر:</span> {o.clinical_indication}</p>
            <p><span className="text-slate-500">الحالة:</span> {o.status} · <span className="text-slate-500">الأولوية:</span> {o.priority}</p>
            <p><span className="text-slate-500">الطبيب الطالب:</span> {o.ordered_by_name}</p>
            {o.performed_at && <p><span className="text-slate-500">تم التصوير:</span> {dt(o.performed_at)}</p>}
            {o.cancel_reason && <p className="text-rose-600">سبب الإلغاء: {o.cancel_reason}</p>}
          </div>
          <div className="flex flex-wrap gap-2 items-start">
            {has(m, 'radiology.perform') && o.status === 'ordered' && <button className="btn-primary" onClick={() => act(() => api(`/api/radiology/orders/${o.id}/start`, { method: 'POST' }), 'بدأ التصوير')}>بدء التصوير</button>}
            {has(m, 'radiology.perform') && ['ordered', 'in_progress'].includes(o.status) && <button className="btn-primary" onClick={() => act(() => api(`/api/radiology/orders/${o.id}/perform`, { method: 'POST' }), 'أُتم التصوير')}>إتمام التصوير</button>}
            {has(m, 'radiology.order') && ['ordered', 'in_progress'].includes(o.status) && <div className="w-full flex gap-2 mt-2">
              <input className="input" placeholder="سبب الإلغاء (5 أحرف على الأقل)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <button className="btn-danger" disabled={cancelReason.length < 5} onClick={() => act(() => api(`/api/radiology/orders/${o.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: cancelReason }) }), 'أُلغي الطلب')}>إلغاء</button>
            </div>}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <h4 className="font-semibold text-sm">التقارير</h4>
          {detail.reports.length === 0 && <p className="text-xs text-slate-500">لا تقارير بعد.</p>}
          {detail.reports.map((r: any) => <div key={r.id} className="border rounded-lg p-2 text-sm">
            <div className="flex justify-between text-xs text-slate-500"><span>الإصدار {r.version} · {r.reported_by_name} · {dt(r.reported_at)}</span>
              <span>{r.status === 'final' ? 'معتمد' : 'مسودة'}{r.is_critical && ' · نتيجة حرجة'}{r.acknowledged_at && ` · مُستلمة بواسطة ${r.acknowledged_by_name}`}</span></div>
            <p className="mt-1"><span className="text-slate-500">النتائج:</span> {r.findings}</p>
            <p><span className="text-slate-500">الانطباع:</span> {r.impression}</p>
            {r.recommendation && <p><span className="text-slate-500">التوصية:</span> {r.recommendation}</p>}
          </div>)}
        </div>

        {has(m, 'radiology.report') && ['performed', 'reported'].includes(o.status) && !draft && <div className="mt-3 border-t pt-3">
          <h4 className="font-semibold text-sm mb-2">{detail.reports.length ? 'تقرير تصحيحي (إصدار جديد)' : 'كتابة التقرير'}</h4>
          <textarea className="input mb-2" rows={2} placeholder="النتائج (5 أحرف على الأقل)" value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} />
          <textarea className="input mb-2" rows={2} placeholder="الانطباع التشخيصي" value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} />
          <input className="input mb-2" placeholder="التوصية (اختياري)" value={form.recommendation} onChange={(e) => setForm({ ...form, recommendation: e.target.value })} />
          <label className="flex items-center gap-2 text-xs mb-2"><input type="checkbox" checked={form.critical} onChange={(e) => setForm({ ...form, critical: e.target.checked })} /> نتيجة حرجة تستوجب إبلاغ الطبيب الطالب</label>
          <button className="btn-primary" disabled={form.findings.length < 5 || form.impression.length < 5}
            onClick={() => act(() => api(`/api/radiology/orders/${o.id}/reports`, { method: 'POST', body: JSON.stringify(form) }), 'حُفظ التقرير كمسودة')}>حفظ كمسودة</button>
        </div>}

        {has(m, 'radiology.verify') && draft && <div className="mt-3 border-t pt-3">
          <button className="btn-primary" onClick={() => act(() => api(`/api/radiology/reports/${draft.id}/finalize`, { method: 'POST' }), 'اعتُمد التقرير وأُضيفت الرسوم')}>اعتماد التقرير النهائي</button>
          <p className="text-xs text-slate-500 mt-1">الاعتماد يقفل التقرير نهائيًا؛ أي تصحيح لاحق يكون بإصدار جديد مرتبط بالأصل.</p>
        </div>}

        {has(m, 'radiology.critical.ack') && finalReport?.is_critical && !finalReport.acknowledged_at && <div className="mt-3 border-t pt-3">
          <h4 className="font-semibold text-sm text-rose-700 mb-1">استلام نتيجة حرجة</h4>
          <div className="flex gap-2"><input className="input" placeholder="ملاحظة الاستلام والإجراء" value={ackNote} onChange={(e) => setAckNote(e.target.value)} />
            <button className="btn-primary" disabled={ackNote.length < 5} onClick={() => act(() => api(`/api/radiology/reports/${finalReport.id}/acknowledge`, { method: 'POST', body: JSON.stringify({ note: ackNote }) }), 'سُجّل استلام النتيجة الحرجة')}>تأكيد الاستلام</button></div>
        </div>}
      </Card>}
    </div>
  );
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

// ------------------------------------------------------------- Blood bank ----
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const COMPONENT_AR: Record<string, string> = { rbc: 'كريات حمراء', ffp: 'بلازما مجمدة', platelets: 'صفائح', cryo: 'راسب قري' };
const URGENCY_AR: Record<string, string> = { routine: 'روتيني', urgent: 'عاجل', emergency: 'طارئ' };
const REACTION_AR: Record<string, string> = { febrile: 'حمّوي', allergic: 'تحسسي', hemolytic: 'انحلالي', trali: 'TRALI', taco: 'TACO', septic: 'إنتاني', other: 'أخرى' };
const SEVERITY_AR: Record<string, string> = { mild: 'خفيف', moderate: 'متوسط', severe: 'شديد', life_threatening: 'مهدد للحياة' };
const OUTCOME_AR: Record<string, string> = { completed: 'مكتمل', stopped_reaction: 'أُوقف لتفاعل', stopped_other: 'أُوقف لسبب آخر' };

function BloodBank({ m }: { m: Me }) {
  const [stock, setStock] = useState<any>(null);
  const [requestList, setRequestList] = useState<any[]>([]);
  const [filter, setFilter] = useState('active');
  const [sel, setSel] = useState<any>(null);
  const [match, setMatch] = useState<any>(null);
  const [reserved, setReserved] = useState<any[]>([]);
  const [unit, setUnit] = useState<any>(null);
  const [checkers, setCheckers] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [encounters, setEncounters] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);

  const [donor, setDonor] = useState<any>({ bloodType: 'O+', hemoglobin: '', hbv: true, hcv: true, hiv: true, syphilis: true, deferralReason: '', components: ['rbc'] });
  const [req, setReq] = useState<any>({ patientId: '', encounterId: '', component: 'rbc', unitsRequested: 2, urgency: 'routine', indication: '', hbValue: '' });
  const [override, setOverride] = useState('');
  const [tx, setTx] = useState<any>({ secondCheckerId: '', preHeartRate: '', preSystolicBp: '', preTemperatureC: '', preSpo2: '', consent: false });
  const [closing, setClosing] = useState<any>({ outcome: 'completed', volumeTransfusedMl: '', notes: '' });
  const [reaction, setReaction] = useState<any>({ reactionType: 'febrile', severity: 'mild', description: '', actionTaken: '' });
  const [discard, setDiscard] = useState('');

  async function loadStock() {
    try { setStock(await api<any>('/api/bloodbank/stock')); } catch (e: any) { setErr(e.message); }
  }
  async function loadRequests() {
    try { const r = await api<any>(`/api/bloodbank/requests?status=${filter}`); setRequestList(r.items ?? []); } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => {
    loadStock(); loadRequests();
    if (has(m, 'bloodbank.transfuse')) api<any>('/api/bloodbank/second-checkers').then((r) => setCheckers(r.items ?? [])).catch(() => setCheckers([]));
    if (has(m, 'bloodbank.request')) api<any>('/api/patients?limit=100').then((r) => setPatients(r.items ?? [])).catch(() => setPatients([]));
  }, [filter]);

  async function refreshAll() {
    await loadStock();
    try {
      const r = await api<any>(`/api/bloodbank/requests?status=${filter}`);
      setRequestList(r.items ?? []);
      if (sel) setSel((r.items ?? []).find((x: any) => x.id === sel.id) ?? sel);
    } catch { /* handled by load */ }
    if (sel && has(m, 'bloodbank.crossmatch')) {
      try { setMatch(await api<any>(`/api/bloodbank/requests/${sel.id}/compatible-units`)); } catch { /* stale panel is fine */ }
    }
    if (sel && has(m, 'bloodbank.issue')) {
      try { const x = await api<any>(`/api/bloodbank/requests/${sel.id}/reserved-units`); setReserved(x.items ?? []); } catch { /* ignore */ }
    }
    if (unit) { try { setUnit(await api<any>(`/api/bloodbank/units/${unit.id}`)); } catch { /* ignore */ } }
  }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await refreshAll(); }
    catch (e: any) { setErr(e.message + (e.details ? ` — ${JSON.stringify(e.details)}` : '')); }
  }
  async function openRequest(r: any) {
    setSel(r); setMatch(null); setReserved([]); setOverride(''); setUnit(null); setErr(null); setOk(null);
    if (has(m, 'bloodbank.crossmatch')) {
      try { setMatch(await api<any>(`/api/bloodbank/requests/${r.id}/compatible-units`)); } catch (e: any) { setErr(e.message); }
    }
    if (has(m, 'bloodbank.issue')) {
      try { const x = await api<any>(`/api/bloodbank/requests/${r.id}/reserved-units`); setReserved(x.items ?? []); } catch (e: any) { setErr(e.message); }
    }
  }
  async function openUnit(id: string) {
    setErr(null); setOk(null); setDiscard(''); setOverride('');
    try { setUnit(await api<any>(`/api/bloodbank/units/${id}`)); } catch (e: any) { setErr(e.message); }
  }
  async function pickPatient(patientId: string) {
    setReq({ ...req, patientId, encounterId: '' }); setEncounters([]);
    if (!patientId) return;
    try {
      const r = await api<any>(`/api/encounters?patientId=${patientId}`);
      setEncounters(r.items ?? []);
      if ((r.items ?? [])[0]) setReq((cur: any) => ({ ...cur, patientId, encounterId: r.items[0].id }));
    } catch (e: any) { setErr(e.message); }
  }

  const selectedPatient = patients.find((p) => p.id === req.patientId);
  const latestMatch = unit?.crossmatches?.length ? [...unit.crossmatches].reverse().find((c: any) => c.result === 'compatible') ?? unit.crossmatches[unit.crossmatches.length - 1] : null;
  const activeTx = (unit?.transfusions ?? []).find((t: any) => !t.completed_at);
  const doneTx = (unit?.transfusions ?? []).find((t: any) => t.completed_at);
  const anyReaction = (unit?.transfusions ?? []).some((t: any) => t.reaction);
  const hasScreeningPass = donor.hbv && donor.hcv && donor.hiv && donor.syphilis;

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />

      {stock && <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[['وحدات متاحة', stock.totals.available], ['محجوزة', stock.totals.reserved], ['مصروفة', stock.totals.issued], ['منتهية الصلاحية', stock.totals.expired], ['نُقلت اليوم', stock.totals.transfused_today]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
        ))}
      </div>}

      <Card title="مخزون بنك الدم">
        <p className="text-[11px] text-slate-500 mb-2">جدول ABO/Rh مطبَّق على الخادم؛ فحص العامل الريصي إلزامي لكرات الدم والصفائح. لا فحص أجسام مضادة ولا تكامل مع بنك دم وطني.</p>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px]"><thead><tr>
          <th className="th">المكوّن</th>{BLOOD_TYPES.map((t) => <th key={t} className="th text-center">{t}</th>)}
        </tr></thead><tbody>
          {Object.keys(COMPONENT_AR).map((c) => <tr key={c}>
            <td className="td font-semibold">{COMPONENT_AR[c]}</td>
            {BLOOD_TYPES.map((t) => {
              const g = (stock?.grid ?? []).find((x: any) => x.component === c && x.blood_type === t);
              const n = g?.available ?? 0;
              return <td key={t} className={`td text-center ${n > 0 ? 'font-bold text-emerald-700' : 'text-slate-300'}`}>
                {n || '—'}{g?.reserved ? <span className="block text-[11px] font-normal text-amber-700">محجوز {g.reserved}</span> : null}
              </td>;
            })}
          </tr>)}
        </tbody></table></div>

        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[760px]"><thead><tr>
          <th className="th">الوحدة</th><th className="th">المكوّن</th><th className="th">الفصيلة</th><th className="th">الصلاحية</th><th className="th">الحالة</th><th className="th">المتبرع</th><th className="th"></th>
        </tr></thead><tbody>
          {(stock?.units ?? []).map((u: any) => <tr key={u.id} className={u.expired ? 'bg-rose-50/70' : ''}>
            <td className="td text-xs font-mono">{u.unit_no}</td>
            <td className="td text-xs">{u.component_ar}</td>
            <td className="td text-xs font-semibold">{u.blood_type}</td>
            <td className="td text-xs">{u.expired ? <span className="text-rose-700">منتهية</span> : <span className={u.days_left <= 5 ? 'text-amber-700 font-semibold' : ''}>{u.days_left} يوم</span>}
              <span className="block text-[11px] text-slate-400">{dt(u.expires_at)}</span></td>
            <td className="td"><Badge value={u.status} /></td>
            <td className="td text-xs">{u.donor_no}</td>
            <td className="td"><button className="btn-ghost text-xs" onClick={() => openUnit(u.id)}>تفاصيل</button></td>
          </tr>)}
          {(stock?.units ?? []).length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا وحدات في المخزون.</td></tr>}
        </tbody></table></div>
      </Card>

      <Card title="طلبات الدم" action={<div className="flex gap-1">
        <button className={`btn-ghost text-xs ${filter === 'active' ? 'bg-slate-100' : ''}`} onClick={() => setFilter('active')}>النشطة</button>
        <button className={`btn-ghost text-xs ${filter === 'all' ? 'bg-slate-100' : ''}`} onClick={() => setFilter('all')}>الكل</button>
      </div>}>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
          <th className="th">الطلب</th><th className="th">المريض</th><th className="th">المكوّن</th><th className="th">الوحدات</th><th className="th">الأولوية</th><th className="th">الحالة</th><th className="th">الاستطباب</th><th className="th"></th>
        </tr></thead><tbody>
          {requestList.map((r: any) => <tr key={r.id}>
            <td className="td text-xs font-mono">{r.request_no}<span className="block text-slate-400">{dt(r.requested_at)}</span></td>
            <td className="td text-xs">{r.patient_name}<span className="block text-slate-400">{r.mrn} · {r.patient_blood_type ?? 'فصيلة غير مسجلة'}</span></td>
            <td className="td text-xs">{r.component_ar}</td>
            <td className="td text-xs">{r.transfused_units}/{r.units_requested}</td>
            <td className="td text-xs"><span className={r.urgency === 'emergency' ? 'badge bg-rose-100 text-rose-700' : r.urgency === 'urgent' ? 'badge bg-amber-100 text-amber-700' : 'badge bg-slate-100 text-slate-700'}>{URGENCY_AR[r.urgency]}</span></td>
            <td className="td"><Badge value={r.status} /></td>
            <td className="td text-xs max-w-[220px]">{r.indication}</td>
            <td className="td"><button className="btn-ghost text-xs" onClick={() => openRequest(r)}>المطابقة والصرف</button></td>
          </tr>)}
          {requestList.length === 0 && <tr><td className="td text-slate-500" colSpan={8}>لا طلبات بهذه الحالة.</td></tr>}
        </tbody></table></div>
      </Card>

      {sel && <Card title={`طلب ${sel.request_no} — ${sel.patient_name}`} action={<button className="btn-ghost text-xs" onClick={() => { setSel(null); setMatch(null); setReserved([]); }}>إغلاق</button>}>
        <div className="text-xs text-slate-600 space-y-1">
          <p>فصيلة المريض: <b>{sel.patient_blood_type ?? 'غير مسجلة'}</b> · المكوّن: {sel.component_ar} · الوحدات المطلوبة: {sel.units_requested} · الحالة: <Badge value={sel.status} /></p>
          <p>الزيارة {sel.encounter_no} · طلبها {sel.requested_by_name} · {dt(sel.requested_at)}</p>
          <p>الاستطباب: {sel.indication}{sel.hb_value ? ` · Hb ${sel.hb_value}` : ''}{sel.platelets_value ? ` · صفائح ${sel.platelets_value}` : ''}</p>
        </div>

        {reserved.length > 0 && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">وحدات محجوزة جاهزة للصرف</p>
          <table className="w-full"><tbody>
            {reserved.map((u: any) => <tr key={u.id}>
              <td className="td text-xs font-mono">{u.unit_no}</td>
              <td className="td text-xs">{u.blood_type} · {u.component_ar}</td>
              <td className="td text-xs">{u.days_left} يوم</td>
              <td className="td text-xs">{u.match_result === 'compatible' ? 'متوافقة' : 'تجاوز موثق'}</td>
              <td className="td">{has(m, 'bloodbank.issue') && <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/bloodbank/requests/${sel.id}/issue`, { method: 'POST', body: JSON.stringify({ unitId: u.id }) }), `صُرفت الوحدة ${u.unit_no}`)}>صرف للجناح</button>}</td>
            </tr>)}
          </tbody></table>
        </div>}

        {match && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">وحدات متاحة للفحص — متوافقة {match.compatibleCount} من {match.units.length}</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[700px]"><thead><tr>
            <th className="th">الوحدة</th><th className="th">الفصيلة</th><th className="th">الصلاحية</th><th className="th">النتيجة</th><th className="th"></th>
          </tr></thead><tbody>
            {match.units.map((u: any) => <tr key={u.id}>
              <td className="td text-xs font-mono">{u.unit_no}</td>
              <td className="td text-xs">{u.blood_type}</td>
              <td className="td text-xs">{u.days_left} يوم</td>
              <td className="td text-xs">{u.compatible ? <span className="text-emerald-700">متوافقة</span> : <span className="text-rose-700">{u.reason}</span>}</td>
              <td className="td">{has(m, 'bloodbank.crossmatch') && (u.compatible
                ? <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/bloodbank/requests/${sel.id}/crossmatch`, { method: 'POST', body: JSON.stringify({ unitId: u.id, method: 'gel' }) }), `حُجزت الوحدة ${u.unit_no}`)}>فحص وحجز</button>
                : <div className="flex flex-wrap items-center gap-1">
                    <input className="input !w-40 text-xs" placeholder="سبب سريري للتجاوز" value={override} onChange={(e) => setOverride(e.target.value)} />
                    <button className="btn-ghost text-xs" disabled={override.trim().length < 5}
                      onClick={() => act(() => api(`/api/bloodbank/requests/${sel.id}/crossmatch`, { method: 'POST', body: JSON.stringify({ unitId: u.id, method: 'gel', forceIncompatible: true, note: override }) }), 'سُجّل تجاوز موثق (لا يسمح بالصرف)')}>تجاوز موثق</button>
                  </div>)}
              </td>
            </tr>)}
            {match.units.length === 0 && <tr><td className="td text-slate-500" colSpan={5}>لا وحدات متاحة من هذا المكوّن.</td></tr>}
          </tbody></table></div>
          <p className="text-[11px] text-slate-500 mt-1">التجاوز الموثق يسجّل قرارًا سريريًا ولا يمنح إمكانية الصرف؛ الصرف يتطلب فحص توافق ناجحًا.</p>
        </div>}
      </Card>}

      {unit && <Card title={`الوحدة ${unit.unit_no} — ${COMPONENT_AR[unit.component]}`} action={<button className="btn-ghost text-xs" onClick={() => setUnit(null)}>إغلاق</button>}>
        <div className="grid sm:grid-cols-2 gap-2 text-xs text-slate-600">
          <div className="space-y-1">
            <p>الفصيلة: <b>{unit.blood_type}</b> · الحجم: {unit.volume_ml ?? '—'} مل · الحالة: <Badge value={unit.status} /></p>
            <p>المتبرع: {unit.donor_no} · الجمع: {dt(unit.collected_at)}</p>
            <p>الصلاحية: {dt(unit.expires_at)} {unit.expires_at && new Date(unit.expires_at) <= new Date() && <span className="text-rose-700"> (منتهية)</span>}</p>
            {unit.patient_name && <p>المريض: {unit.patient_name} · {unit.patient_mrn}</p>}
            {unit.discard_reason && <p className="text-rose-700">سبب الاستبعاد: {unit.discard_reason}</p>}
          </div>
          <div className="space-y-1">
            <p>فحوص المتبرع: HBV {unit.screening?.hbv ? 'سلبي' : 'إيجابي'} · HCV {unit.screening?.hcv ? 'سلبي' : 'إيجابي'} · HIV {unit.screening?.hiv ? 'سلبي' : 'إيجابي'} · الزهري {unit.screening?.syphilis ? 'سلبي' : 'إيجابي'}</p>
            <p>فحوص التوافق: {unit.crossmatches?.length ? unit.crossmatches.map((c: any) => `${c.request_no}: ${c.result === 'compatible' ? 'متوافق' : 'غير متوافق'}`).join(' · ') : 'لا يوجد'}</p>
          </div>
        </div>

        {(unit.transfusions ?? []).map((t: any) => <div key={t.id} className={`mt-3 rounded-lg border p-2 text-xs ${t.completed_at ? 'bg-slate-50' : 'bg-amber-50 border-amber-200'}`}>
          <p className="font-semibold">نقل بدأه {t.started_by_name} · تدقيق {t.checker_name} · {dt(t.started_at)}</p>
          <p>{t.completed_at ? <>انتهى {dt(t.completed_at)} — {OUTCOME_AR[t.outcome] ?? t.outcome} · {t.volume_transfused_ml ?? 0} مل</> : 'جارٍ الآن — لم يُغلق بعد'}</p>
          {t.notes && <p className="text-slate-500">ملاحظات: {t.notes}</p>}
          {t.reaction && <p className="text-rose-700">تفاعل: {REACTION_AR[t.reaction.reaction_type] ?? t.reaction.reaction_type} · {SEVERITY_AR[t.reaction.severity] ?? t.reaction.severity} — {t.reaction.description}</p>}
        </div>)}

        {unit.status === 'issued' && !activeTx && has(m, 'bloodbank.transfuse') && latestMatch && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">بدء النقل — يتطلب مدققًا ثانيًا وحضور الموافقة</p>
          <div className="flex flex-wrap gap-1 items-end">
            <select className="input !w-52 text-xs" value={tx.secondCheckerId} onChange={(e) => setTx({ ...tx, secondCheckerId: e.target.value })}>
              <option value="">المدقق الثاني</option>
              {checkers.filter((c) => c.id !== m.user.id).map((c) => <option key={c.id} value={c.id}>{c.full_name_ar} · {c.role_name}</option>)}
            </select>
            {[['preHeartRate', 'نبض'], ['preSystolicBp', 'انقباضي'], ['preSpo2', 'SpO₂'], ['preTemperatureC', 'حرارة']].map(([k, label]) => (
              <input key={k} className="input !w-24 text-xs" placeholder={label} value={tx[k]} onChange={(e) => setTx({ ...tx, [k]: e.target.value })} />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs mt-2"><input type="checkbox" checked={tx.consent} onChange={(e) => setTx({ ...tx, consent: e.target.checked })} />تم التحقق من هوية المريض والموافقة المستنيرة ووحدة الدم المطابقة</label>
          <button className="btn-primary text-xs mt-2" disabled={!tx.secondCheckerId || !tx.consent}
            onClick={() => act(() => api(`/api/bloodbank/units/${unit.id}/transfuse`, { method: 'POST', body: JSON.stringify({
              requestId: latestMatch.request_id,
              secondCheckerId: tx.secondCheckerId,
              consentConfirmed: true,
              ...Object.fromEntries(Object.entries(tx).filter(([k, v]) => k.startsWith('pre') && v !== '').map(([k, v]) => [k, Number(v)])),
            }) }), 'بدأ النقل')}>بدء النقل</button>
        </div>}

        {activeTx && has(m, 'bloodbank.transfuse') && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">إغلاق النقل</p>
          <div className="flex flex-wrap gap-1 items-end">
            <select className="input !w-44 text-xs" value={closing.outcome} onChange={(e) => setClosing({ ...closing, outcome: e.target.value })}>
              {Object.entries(OUTCOME_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input !w-28 text-xs" type="number" placeholder="الحجم المنقول (مل)" value={closing.volumeTransfusedMl} onChange={(e) => setClosing({ ...closing, volumeTransfusedMl: e.target.value })} />
            <input className="input !w-56 text-xs" placeholder="ملاحظات (اختياري)" value={closing.notes} onChange={(e) => setClosing({ ...closing, notes: e.target.value })} />
            <button className="btn-primary text-xs" disabled={closing.volumeTransfusedMl === '' || Number(closing.volumeTransfusedMl) > 600}
              onClick={() => act(() => api(`/api/bloodbank/transfusions/${activeTx.id}/complete`, { method: 'POST', body: JSON.stringify({ outcome: closing.outcome, volumeTransfusedMl: Number(closing.volumeTransfusedMl), notes: closing.notes || undefined }) }), 'أُغلق سجل النقل')}>حفظ النتيجة</button>
          </div>
        </div>}

        {unit.status === 'transfused' && !anyReaction && has(m, 'bloodbank.reaction') && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">الإبلاغ عن تفاعل نقل</p>
          <div className="flex flex-wrap gap-1 items-end">
            <select className="input !w-32 text-xs" value={reaction.reactionType} onChange={(e) => setReaction({ ...reaction, reactionType: e.target.value })}>
              {Object.entries(REACTION_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="input !w-32 text-xs" value={reaction.severity} onChange={(e) => setReaction({ ...reaction, severity: e.target.value })}>
              {Object.entries(SEVERITY_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input !w-60 text-xs" placeholder="وصف التفاعل (١٠ أحرف على الأقل)" value={reaction.description} onChange={(e) => setReaction({ ...reaction, description: e.target.value })} />
            <input className="input !w-56 text-xs" placeholder="الإجراء المتخذ" value={reaction.actionTaken} onChange={(e) => setReaction({ ...reaction, actionTaken: e.target.value })} />
            <button className="btn-danger text-xs" disabled={reaction.description.trim().length < 10 || reaction.actionTaken.trim().length < 5}
              onClick={() => act(() => api(`/api/bloodbank/transfusions/${doneTx?.id ?? unit.transfusions[0]?.id}/reactions`, { method: 'POST', body: JSON.stringify(reaction) }), 'سُجل التفاعل وحُجزت الوحدة')}>تسجيل التفاعل</button>
          </div>
          {reaction.severity !== 'mild' && !(unit.transfusions ?? []).some((t: any) => t.completed_at) && <p className="text-[11px] text-amber-700 mt-1">التفاعل المتوسط أو الشديد يتطلب إغلاق النقل أولًا مع اختيار «أُوقف لتفاعل».</p>}
          <p className="text-[11px] text-slate-500 mt-1">الوحدة المتورطة تُستبعد تلقائيًا ولا تعود للمخزون.</p>
        </div>}

        {(unit.status === 'available' || unit.status === 'reserved') && has(m, 'bloodbank.stock') && <div className="mt-3 border-t pt-2">
          <p className="text-sm font-semibold mb-1">استبعاد الوحدة</p>
          <div className="flex flex-wrap gap-1 items-end">
            <input className="input !w-72 text-xs" placeholder="سبب الاستبعاد (٥ أحرف على الأقل)" value={discard} onChange={(e) => setDiscard(e.target.value)} />
            <button className="btn-danger text-xs" disabled={discard.trim().length < 5}
              onClick={() => act(() => api(`/api/bloodbank/units/${unit.id}/discard`, { method: 'POST', body: JSON.stringify({ reason: discard }) }), 'استُبعدت الوحدة')}>استبعاد</button>
          </div>
        </div>}
      </Card>}

      <div className="grid lg:grid-cols-2 gap-4">
        {has(m, 'bloodbank.stock') && <Card title="تسجيل تبرع جديد">
          <div className="grid sm:grid-cols-3 gap-2">
            <div><label className="label">فصيلة الدم</label>
              <select className="input" value={donor.bloodType} onChange={(e) => setDonor({ ...donor, bloodType: e.target.value })}>
                {BLOOD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div><label className="label">الهيموغلوبين</label>
              <input className="input" type="number" step="0.1" min="5" max="25" value={donor.hemoglobin} onChange={(e) => setDonor({ ...donor, hemoglobin: e.target.value })} /></div>
            <div><label className="label">سبب الاستبعاد (إن وجد)</label>
              <input className="input" value={donor.deferralReason} onChange={(e) => setDonor({ ...donor, deferralReason: e.target.value })} /></div>
          </div>
          <div className="flex flex-wrap gap-3 mt-2 text-xs">
            {[['hbv', 'HBV سلبي'], ['hcv', 'HCV سلبي'], ['hiv', 'HIV سلبي'], ['syphilis', 'الزهري سلبي']].map(([k, label]) => (
              <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={donor[k]} onChange={(e) => setDonor({ ...donor, [k]: e.target.checked })} />{label}</label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 mt-2 text-xs">
            {Object.entries(COMPONENT_AR).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={donor.components.includes(k)}
                onChange={(e) => setDonor({ ...donor, components: e.target.checked ? [...donor.components, k] : donor.components.filter((x: string) => x !== k) })} />{label}</label>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">صلاحية افتراضية: كريات ٤٢ يومًا، بلازما ٣٦٥، صفائح ٥، راسب قري ٣٦٥. أي فحص إيجابي ⇒ تبرع غير مؤهل والوحدات تُستبعد تلقائيًا.</p>
          <button className="btn-primary text-xs mt-2" disabled={donor.components.length === 0}
            onClick={() => act(() => api('/api/bloodbank/donors', { method: 'POST', body: JSON.stringify({
              bloodType: donor.bloodType,
              hemoglobin: donor.hemoglobin === '' ? undefined : Number(donor.hemoglobin),
              hbvNegative: donor.hbv, hcvNegative: donor.hcv, hivNegative: donor.hiv, syphilisNegative: donor.syphilis,
              deferralReason: donor.deferralReason || undefined,
              units: donor.components.map((c: string) => ({ component: c })),
            }) }), hasScreeningPass ? 'سُجل التبرع وأُضيفت الوحدات' : 'سُجل تبرع غير مؤهل واستُبعدت وحداته')}>
            تسجيل التبرع
          </button>
        </Card>}

        {has(m, 'bloodbank.request') && <Card title="طلب دم جديد">
          <div className="grid sm:grid-cols-2 gap-2">
            <div><label className="label">المريض</label>
              <select className="input" value={req.patientId} onChange={(e) => pickPatient(e.target.value)}>
                <option value="">—</option>
                {patients.map((p) => <option key={p.id} value={p.id}>{p.mrn} · {p.fullNameAr} · {p.bloodType ?? 'بلا فصيلة'}</option>)}
              </select></div>
            <div><label className="label">الزيارة المفتوحة</label>
              <select className="input" value={req.encounterId} onChange={(e) => setReq({ ...req, encounterId: e.target.value })}>
                <option value="">—</option>
                {encounters.map((e: any) => <option key={e.id} value={e.id}>{e.encounter_no} · {e.department_name ?? ''} · {dt(e.started_at)}</option>)}
              </select></div>
            <div><label className="label">المكوّن</label>
              <select className="input" value={req.component} onChange={(e) => setReq({ ...req, component: e.target.value })}>
                {Object.entries(COMPONENT_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div><label className="label">عدد الوحدات</label>
              <input className="input" type="number" min="1" max="20" value={req.unitsRequested} onChange={(e) => setReq({ ...req, unitsRequested: Number(e.target.value) })} /></div>
            <div><label className="label">الأولوية</label>
              <select className="input" value={req.urgency} onChange={(e) => setReq({ ...req, urgency: e.target.value })}>
                {Object.entries(URGENCY_AR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div><label className="label">Hb (اختياري)</label>
              <input className="input" type="number" step="0.1" min="1" max="25" value={req.hbValue} onChange={(e) => setReq({ ...req, hbValue: e.target.value })} /></div>
          </div>
          <input className="input mt-2" placeholder="الاستطباب السريري (٥ أحرف على الأقل)" value={req.indication} onChange={(e) => setReq({ ...req, indication: e.target.value })} />
          {selectedPatient && !selectedPatient.bloodType && <p className="text-[11px] text-rose-700 mt-1">فصيلة دم المريض غير مسجلة — سجّلها من ملف المريض أولًا.</p>}
          {req.patientId && encounters.length === 0 && <p className="text-[11px] text-amber-700 mt-1">لا توجد زيارة مفتوحة لهذا المريض؛ ابدأ زيارة من العيادة أو الطوارئ أولًا.</p>}
          <button className="btn-primary text-xs mt-2" disabled={!req.encounterId || !selectedPatient?.bloodType || req.indication.trim().length < 5}
            onClick={() => act(async () => {
              await api('/api/bloodbank/requests', { method: 'POST', body: JSON.stringify({
                patientId: req.patientId, encounterId: req.encounterId, component: req.component,
                unitsRequested: Number(req.unitsRequested), urgency: req.urgency, indication: req.indication,
                hbValue: req.hbValue === '' ? undefined : Number(req.hbValue),
              }) });
              setReq({ ...req, patientId: '', encounterId: '', indication: '', hbValue: '' }); setEncounters([]);
            }, 'أُنشئ طلب الدم')}>إرسال الطلب</button>
        </Card>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Nutrition ---
const MEAL_LABELS: Record<string, string> = { breakfast: 'إفطار', lunch: 'غداء', dinner: 'عشاء', snack: 'وجبة خفيفة' };
const DIET_LABELS: Record<string, string> = {
  regular: 'عادي', diabetic: 'سكري', renal: 'كلوي', low_sodium: 'قليل الصوديوم', soft: 'لين',
  liquid: 'سوائل صافية', npo: 'صائم (NPO)', enteral: 'تغذية أنبوبية', parenteral: 'تغذية وريدية',
};
const RISK_LABELS: Record<string, string> = { low: 'منخفض', medium: 'متوسط', high: 'مرتفع' };
const RESTRICTION_LABELS: Record<string, string> = {
  lactose_free: 'خالٍ من اللاكتوز', gluten_free: 'خالٍ من الغلوتين', nut_free: 'خالٍ من المكسرات',
  egg_free: 'خالٍ من البيض', fish_free: 'خالٍ من السمك', soy_free: 'خالٍ من الصويا',
  diabetic: 'سكري', low_sodium: 'قليل الصوديوم', renal: 'كلوي', low_fat: 'قليل الدهون',
};
const TOLERANCE_LABELS: Record<string, string> = { good: 'جيد', partial: 'جزئي', poor: 'ضعيف' };
const TUBE_LABELS: Record<string, string> = {
  ng: 'أنفي معدي', og: 'فموي معدي', peg: 'فغر معدة', pej: 'فغر صائم', tpn: 'وريدي كلي', ppn: 'وريدي جزئي',
};
const TRAY_STATUS: Record<string, string> = {
  ordered: 'مطلوبة', prepared: 'محضّرة', delivered: 'مُسلَّمة', consumed: 'مستهلكة', refused: 'مرفوضة', cancelled: 'ملغاة',
};

function Nutrition({ m }: { m: Me }) {
  const [board, setBoard] = useState<any>(null);
  const [kitchen, setKitchen] = useState<any>(null);
  const [file, setFile] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState<string | null>(null);
  const [screen, setScreen] = useState<any>({ admissionId: '', weightKg: '', heightCm: '', weightLossPct: '0', intakeReduction: 'none', diseaseSeverity: 'none', actionTaken: '', notes: '' });
  const [assess, setAssess] = useState<any>({ admissionId: '', weightKg: '', heightCm: '', energyTargetKcal: '', proteinTargetG: '', fluidLimitMl: '', nutritionDiagnosis: '', plan: '', varianceReason: '' });
  const [order, setOrder] = useState<any>({ admissionId: '', dietType: 'diabetic', texture: '', restrictions: [] as string[], notes: '' });
  const [tube, setTube] = useState<any>({ admissionId: '', route: 'ng', formulaName: '', kcalPerMl: '1', proteinGPerL: '40', rateMlHr: '40', hoursPerDay: '16', notes: '' });
  const [intake, setIntake] = useState<any>({ pct: '60', refused: false, notes: '' });
  const [follow, setFollow] = useState<any>({ weightKg: '', intakePctAvg: '', tolerance: 'good', note: '' });
  const isDietitian = has(m, 'nutrition.assess');
  const admissions = board?.items ?? [];

  async function load() {
    try {
      const b = await api<any>('/api/nutrition/board');
      setBoard(b);
      if (file) setFile(await api<any>(`/api/nutrition/patients/${file.patient.id}`));
    } catch (e: any) { setErr(e.message); }
  }
  async function loadKitchen() {
    if (!has(m, 'nutrition.kitchen')) return;
    try { setKitchen(await api<any>('/api/nutrition/kitchen')); } catch { /* kitchen only */ }
  }
  useEffect(() => { load(); loadKitchen(); }, []);
  async function refresh() { await load(); await loadKitchen(); }
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await refresh(); } catch (e: any) { setErr(e.message + (e.details ? ` — ${JSON.stringify(e.details)}` : '')); }
  }
  async function open(row: any) {
    setErr(null); setOk(null);
    try {
      const f = await api<any>(`/api/nutrition/patients/${row.patient_id}`);
      setFile(f);
      setScreen({ ...screen, admissionId: row.admission_id, weightKg: row.weight_kg ?? '', heightCm: '' });
      setAssess({ ...assess, admissionId: row.admission_id, weightKg: row.weight_kg ?? '' });
      setOrder({ ...order, admissionId: row.admission_id });
      setTube({ ...tube, admissionId: row.admission_id });
    } catch (e: any) { setErr(e.message); }
  }

  const selectedAdmission = admissions.find((a: any) => a.admission_id === screen.admissionId);

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />

      {board && <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[['منوّمون', board.totals.inpatients], ['خطر مرتفع', board.totals.high_risk], ['صائمون', board.totals.npo], ['بحاجة لفحص', board.totals.needs_screening], ['بلا أمر تغذية', board.totals.without_diet]].map(([l, v]) => (
          <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
        ))}
      </div>}

      {board && <Card title="لوحة التغذية العلاجية">
        <div className="overflow-x-auto"><table className="w-full min-w-[1000px]"><thead><tr>
          <th className="th">المريض</th><th className="th">الجناح</th><th className="th">آخر فحص</th><th className="th">الخطر</th><th className="th">أمر التغذية</th><th className="th">التغذية الأنبوبية</th><th className="th">وجبات اليوم</th><th className="th"></th>
        </tr></thead><tbody>
          {admissions.map((a: any) => <tr key={a.admission_id} className={a.risk_level === 'high' ? 'bg-rose-50/60' : a.needs_screening ? 'bg-amber-50/50' : ''}>
            <td className="td text-xs">{a.patient_name}<span className="block text-slate-400">{a.mrn} · {a.admission_no} · {a.age_years} سنة</span></td>
            <td className="td text-xs">{a.ward_name ?? '—'} {a.room_no ? `${a.room_no}/${a.bed_no}` : ''}</td>
            <td className="td text-xs">{a.screening_date ? <>{day(a.screening_date)}<span className="block text-slate-400">BMI {Number(a.bmi)} · نقاط {a.screening_score}</span></> : <span className="text-amber-700">لم يُفحص</span>}</td>
            <td className="td text-xs">{a.risk_level ? <span className={a.risk_level === 'high' ? 'badge bg-rose-100 text-rose-700' : a.risk_level === 'medium' ? 'badge bg-amber-100 text-amber-700' : 'badge bg-emerald-100 text-emerald-700'}>{RISK_LABELS[a.risk_level]}</span> : '—'}</td>
            <td className="td text-xs">{a.diet_type ? <>{a.diet_ar}<span className="block text-slate-400">{a.order_no} · {(a.restriction_labels ?? []).join(' · ') || 'بلا قيود'}</span></> : <span className="text-slate-400">لا يوجد</span>}</td>
            <td className="td text-xs">{a.tube_route ? <>{TUBE_LABELS[a.tube_route]}<span className="block text-slate-400">{a.formula_name} · {a.kcal_day} سعرة</span></> : '—'}</td>
            <td className="td text-xs">{a.trays_total ? <>{a.trays_done}/{a.trays_total} منجز<span className="block text-slate-400">{a.trays_pending} قيد التنفيذ</span></> : '—'}</td>
            <td className="td"><button className="btn-ghost text-xs" onClick={() => open(a)}>فتح الملف</button></td>
          </tr>)}
          {admissions.length === 0 && <tr><td className="td text-slate-500" colSpan={8}>لا مرضى منوّمين.</td></tr>}
        </tbody></table></div>
      </Card>}

      {kitchen && <Card title="صواني المطبخ اليوم">
        <div className="flex flex-wrap gap-3 text-xs text-slate-600 mb-2">
          <span>مطلوبة: <b>{kitchen.totals.ordered}</b></span><span>محضّرة: <b>{kitchen.totals.prepared}</b></span><span>مُسلَّمة: <b>{kitchen.totals.delivered}</b></span>
          {board?.trays && <span>متوسط الاستهلاك: <b>{board.trays.avg_intake_pct}%</b></span>}
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
          <th className="th">الصينية</th><th className="th">الوجبة</th><th className="th">المريض</th><th className="th">الحمية</th><th className="th">الطاقة</th><th className="th">الحالة</th><th className="th"></th>
        </tr></thead><tbody>
          {kitchen.items.map((t: any) => <tr key={t.id}>
            <td className="td text-xs font-mono">{t.tray_no}</td>
            <td className="td text-xs">{t.meal_ar}</td>
            <td className="td text-xs">{t.patient_name}<span className="block text-slate-400">{t.mrn} · {t.ward_name ?? ''} {t.room_no ?? ''}</span></td>
            <td className="td text-xs">{t.diet_ar}<span className="block text-slate-400">{(t.restriction_labels ?? []).join(' · ') || t.texture || ''}</span></td>
            <td className="td text-xs">{t.kcal_planned} سعرة<span className="block text-slate-400">{t.protein_planned_g} غ بروتين</span></td>
            <td className="td"><Badge value={t.status} /></td>
            <td className="td"><div className="flex gap-1">
              {has(m, 'nutrition.kitchen') && t.status === 'ordered' && <button className="btn-ghost text-xs" onClick={() => act(() => api(`/api/nutrition/trays/${t.id}/prepare`, { method: 'POST' }), 'حُضّرت الصينية')}>تحضير</button>}
              {has(m, 'nutrition.kitchen') && t.status === 'prepared' && <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/nutrition/trays/${t.id}/deliver`, { method: 'POST' }), 'سُلّمت الصينية')}>تسليم</button>}
              {has(m, 'nutrition.intake') && t.status === 'delivered' && <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/nutrition/trays/${t.id}/intake`, { method: 'POST', body: JSON.stringify({ consumedPct: Number(intake.pct), refused: intake.refused, notes: intake.notes || undefined }) }), 'سُجّل الاستهلاك')}>تسجيل الاستهلاك ({intake.pct}%)</button>}
            </div></td>
          </tr>)}
          {kitchen.items.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا صواني اليوم.</td></tr>}
        </tbody></table></div>
        {has(m, 'nutrition.intake') && <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
          <span className="text-slate-500">نسبة الاستهلاك المستخدمة عند التسجيل:</span>
          <input className="input !w-24" type="number" min="0" max="100" value={intake.pct} onChange={(e) => setIntake({ ...intake, pct: e.target.value })} />
          <label className="flex items-center gap-1"><input type="checkbox" checked={intake.refused} onChange={(e) => setIntake({ ...intake, refused: e.target.checked })} />رفض الوجبة</label>
          <input className="input !w-64" placeholder="ملاحظة (اختياري)" value={intake.notes} onChange={(e) => setIntake({ ...intake, notes: e.target.value })} />
        </div>}
      </Card>}

      {file && <div className="grid lg:grid-cols-2 gap-3">
        <Card title={`${file.patient.name} — ${file.patient.mrn}`} action={<button className="btn-ghost text-xs" onClick={() => setFile(null)}>إغلاق</button>}>
          <div className="text-xs space-y-1 text-slate-600">
            <p>الطاقة اليوم: <b>{file.today.kcalConsumed}</b> / {file.today.targetKcal} سعرة {file.today.adherencePct !== null && <span className="text-slate-400">({file.today.adherencePct}%)</span>}</p>
            <p>أمر التغذية النشط: {file.activeDiet ? <>{file.activeDiet.order_no} · {file.activeDiet.dietAr} · {(file.activeDiet.restrictionLabels ?? []).join(' · ') || 'بلا قيود'}</> : 'لا يوجد'}</p>
            {file.requiredRestrictions.length > 0 && <p className="text-rose-700">قيود إلزامية من الحساسية: {file.requiredRestrictions.map((r: any) => `${RESTRICTION_LABELS[r.code] ?? r.code} (${r.name})`).join(' · ')}</p>}
            <p className="text-slate-500">{file.limits}</p>
          </div>
          <div className="mt-3 border-t pt-2">
            <p className="text-sm font-semibold mb-1">وجبات آخر يومين</p>
            <table className="w-full"><tbody>
              {file.trays.map((t: any) => <tr key={t.id}>
                <td className="td text-xs">{day(t.tray_date)}</td><td className="td text-xs">{t.mealAr}</td>
                <td className="td text-xs">{t.kcal_planned} سعرة</td>
                <td className="td text-xs">{t.intake_pct !== null ? `${t.intake_pct}% (${t.kcal_consumed} سعرة)` : '—'}</td>
                <td className="td"><Badge value={t.status} /></td>
              </tr>)}
              {file.trays.length === 0 && <tr><td className="td text-xs text-slate-500">لا صواني مسجلة.</td></tr>}
            </tbody></table>
          </div>
          <div className="mt-3 border-t pt-2 text-xs">
            <p className="text-sm font-semibold mb-1">فحوص وتقييمات</p>
            {file.screenings.map((s: any) => <p key={s.id}>فحص {day(s.screening_date)}: نقاط {s.score} · {RISK_LABELS[s.risk_level]} · BMI {Number(s.bmi)}</p>)}
            {file.assessments.map((a: any) => <p key={a.id}>تقييم {day(a.assessed_at)}: {a.energy_target_kcal} سعرة · {Number(a.protein_target_g)} غ بروتين{a.variance_reason ? ' (انحراف مبرر)' : ''}</p>)}
            {file.tubeOrders.map((t: any) => <p key={t.id}>{t.order_no}: {t.routeAr} · {t.formula_name} · {Number(t.rate_ml_hr)} مل/س × {t.hours_per_day} سا · {t.kcal_day} سعرة</p>)}
            {file.followups.map((f: any) => <p key={f.id}>متابعة {dt(f.recorded_at)}: تحمل {TOLERANCE_LABELS[f.tolerance]}{f.weight_kg ? ` · ${Number(f.weight_kg)} كغ` : ''} — {f.note}</p>)}
          </div>
        </Card>

        <div className="space-y-3">
          {has(m, 'nutrition.screen') && <Card title="فحص خطر التغذية (تمريض)">
            <div className="grid grid-cols-2 gap-1">
              {[['weightKg', 'الوزن (كغ)'], ['heightCm', 'الطول (سم)'], ['weightLossPct', 'فقد الوزن %'], ['actionTaken', 'الإجراء المتخذ']].map(([k, label]) => (
                <input key={k} className="input" placeholder={label} value={screen[k]} onChange={(e) => setScreen({ ...screen, [k]: e.target.value })} />
              ))}
              <select className="input" value={screen.intakeReduction} onChange={(e) => setScreen({ ...screen, intakeReduction: e.target.value })}>
                <option value="none">تناول طبيعي</option><option value="mild">نقص خفيف</option><option value="moderate">نقص متوسط</option><option value="severe">نقص شديد</option>
              </select>
              <select className="input" value={screen.diseaseSeverity} onChange={(e) => setScreen({ ...screen, diseaseSeverity: e.target.value })}>
                <option value="none">بلا مرض حاد</option><option value="mild">مرض خفيف</option><option value="moderate">مرض متوسط</option><option value="severe">مرض شديد</option>
              </select>
            </div>
            <button className="btn-primary text-xs mt-2" disabled={!selectedAdmission || !screen.weightKg || !screen.heightCm}
              onClick={() => act(async () => {
                await api('/api/nutrition/screenings', { method: 'POST', body: JSON.stringify({
                  admissionId: screen.admissionId, weightKg: Number(screen.weightKg), heightCm: Number(screen.heightCm),
                  weightLossPct: Number(screen.weightLossPct || 0), intakeReduction: screen.intakeReduction,
                  diseaseSeverity: screen.diseaseSeverity, actionTaken: screen.actionTaken || undefined,
                }) });
              }, 'سُجّل فحص التغذية')}>حفظ الفحص</button>
            <p className="text-[11px] text-slate-500 mt-1">نقاط مرتفعة تتطلب إجراءً موثقًا. الفحص سجل ملحق لا يُعدّل.</p>
          </Card>}

          {isDietitian && <Card title="تقييم وأهداف التغذية (أخصائي)">
            <div className="grid grid-cols-2 gap-1">
              {[['weightKg', 'الوزن (كغ)'], ['heightCm', 'الطول (سم)'], ['energyTargetKcal', 'هدف الطاقة (اختياري)'], ['proteinTargetG', 'هدف البروتين غ (اختياري)'], ['fluidLimitMl', 'حد السوائل مل (اختياري)'], ['varianceReason', 'سبب الانحراف (إن وجد)']].map(([k, label]) => (
                <input key={k} className="input" placeholder={label} value={assess[k]} onChange={(e) => setAssess({ ...assess, [k]: e.target.value })} />
              ))}
            </div>
            <input className="input mt-1" placeholder="التشخيص التغذوي" value={assess.nutritionDiagnosis} onChange={(e) => setAssess({ ...assess, nutritionDiagnosis: e.target.value })} />
            <input className="input mt-1" placeholder="الخطة الغذائية" value={assess.plan} onChange={(e) => setAssess({ ...assess, plan: e.target.value })} />
            <button className="btn-primary text-xs mt-2" disabled={!assess.admissionId || !assess.weightKg || !assess.heightCm || assess.nutritionDiagnosis.length < 5 || assess.plan.length < 10}
              onClick={() => act(async () => {
                await api('/api/nutrition/assessments', { method: 'POST', body: JSON.stringify({
                  admissionId: assess.admissionId, weightKg: Number(assess.weightKg), heightCm: Number(assess.heightCm),
                  energyTargetKcal: assess.energyTargetKcal ? Number(assess.energyTargetKcal) : undefined,
                  proteinTargetG: assess.proteinTargetG ? Number(assess.proteinTargetG) : undefined,
                  fluidLimitMl: assess.fluidLimitMl ? Number(assess.fluidLimitMl) : undefined,
                  varianceReason: assess.varianceReason || undefined,
                  nutritionDiagnosis: assess.nutritionDiagnosis, plan: assess.plan,
                }) });
              }, 'حُفظ التقييم')}>حفظ التقييم</button>
          </Card>}

          {has(m, 'nutrition.order') && <Card title="أمر التغذية">
            <div className="grid grid-cols-2 gap-1">
              <select className="input" value={order.dietType} onChange={(e) => setOrder({ ...order, dietType: e.target.value })}>
                {Object.entries(DIET_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select className="input" value={order.texture} onChange={(e) => setOrder({ ...order, texture: e.target.value })}>
                <option value="">القوام الافتراضي</option><option value="normal">عادي</option><option value="soft">لين</option><option value="minced">مفروم</option><option value="pureed">مهروس</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2 mt-2 text-xs">
              {Object.entries(RESTRICTION_LABELS).map(([k, v]) => (
                <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={order.restrictions.includes(k)}
                  onChange={(e) => setOrder({ ...order, restrictions: e.target.checked ? [...order.restrictions, k] : order.restrictions.filter((x: string) => x !== k) })} />{v}</label>
              ))}
            </div>
            {file.requiredRestrictions.length > 0 && <p className="text-[11px] text-rose-700 mt-1">يجب اختيار: {file.requiredRestrictions.map((r: any) => RESTRICTION_LABELS[r.code] ?? r.code).join(' · ')} وإلا سيُرفض الأمر.</p>}
            <input className="input mt-1" placeholder="ملاحظات (اختياري)" value={order.notes} onChange={(e) => setOrder({ ...order, notes: e.target.value })} />
            <div className="flex gap-1 mt-2">
              <button className="btn-primary text-xs" disabled={!order.admissionId}
                onClick={() => act(async () => {
                  await api('/api/nutrition/diet-orders', { method: 'POST', body: JSON.stringify({
                    admissionId: order.admissionId, dietType: order.dietType,
                    texture: order.texture || undefined, restrictions: order.restrictions, notes: order.notes || undefined,
                  }) });
                }, 'صدر أمر التغذية')}>إصدار الأمر</button>
              {file.activeDiet && <button className="btn-ghost text-xs"
                onClick={() => act(async () => {
                  await api(`/api/nutrition/diet-orders/${file.activeDiet.id}/trays`, { method: 'POST', body: JSON.stringify({}) });
                }, 'وُلّدت وجبات اليوم')}>توليد وجبات اليوم</button>}
            </div>
          </Card>}

          {has(m, 'nutrition.tube') && <Card title="تغذية أنبوبية / وريدية">
            <div className="grid grid-cols-2 gap-1">
              <select className="input" value={tube.route} onChange={(e) => setTube({ ...tube, route: e.target.value })}>
                {Object.entries(TUBE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input className="input" placeholder="اسم التركيبة" value={tube.formulaName} onChange={(e) => setTube({ ...tube, formulaName: e.target.value })} />
              {[['kcalPerMl', 'سعرة/مل'], ['proteinGPerL', 'بروتين غ/ل'], ['rateMlHr', 'معدل مل/سا'], ['hoursPerDay', 'ساعات/يوم']].map(([k, label]) => (
                <input key={k} className="input" type="number" placeholder={label} value={tube[k]} onChange={(e) => setTube({ ...tube, [k]: e.target.value })} />
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">الحجم اليومي = المعدل × الساعات، والسعرات = الحجم × تركيز الطاقة (محسوبة على الخادم).</p>
            <button className="btn-primary text-xs mt-2" disabled={!tube.admissionId || tube.formulaName.length < 2}
              onClick={() => act(async () => {
                await api('/api/nutrition/tube-orders', { method: 'POST', body: JSON.stringify({
                  admissionId: tube.admissionId, route: tube.route, formulaName: tube.formulaName,
                  kcalPerMl: Number(tube.kcalPerMl), proteinGPerL: Number(tube.proteinGPerL),
                  rateMlHr: Number(tube.rateMlHr), hoursPerDay: Number(tube.hoursPerDay), notes: tube.notes || undefined,
                }) });
              }, 'صدر أمر التغذية الأنبوبية')}>بدء التغذية</button>
            {file.tubeOrders.filter((t: any) => t.status === 'active').map((t: any) => <button key={t.id} className="btn-danger text-xs mt-2 ms-2"
              onClick={() => act(async () => {
                const reason = window.prompt('سبب إيقاف التغذية (٥ أحرف على الأقل):') ?? '';
                if (reason.trim().length < 5) return;
                await api(`/api/nutrition/tube-orders/${t.id}/stop`, { method: 'POST', body: JSON.stringify({ reason }) });
              }, 'أُوقف أمر التغذية')}>إيقاف {t.order_no}</button>)}
          </Card>}

          {isDietitian && <Card title="متابعة أخصائي التغذية">
            <div className="grid grid-cols-3 gap-1">
              <input className="input" placeholder="الوزن (كغ)" value={follow.weightKg} onChange={(e) => setFollow({ ...follow, weightKg: e.target.value })} />
              <input className="input" type="number" placeholder="متوسط الاستهلاك %" value={follow.intakePctAvg} onChange={(e) => setFollow({ ...follow, intakePctAvg: e.target.value })} />
              <select className="input" value={follow.tolerance} onChange={(e) => setFollow({ ...follow, tolerance: e.target.value })}>
                {Object.entries(TOLERANCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <input className="input mt-1" placeholder="ملاحظة المتابعة (١٠ أحرف على الأقل)" value={follow.note} onChange={(e) => setFollow({ ...follow, note: e.target.value })} />
            <button className="btn-primary text-xs mt-2" disabled={follow.note.trim().length < 10}
              onClick={() => act(async () => {
                const admId = screen.admissionId || admissions.find((a: any) => a.patient_id === file.patient.id)?.admission_id;
                await api(`/api/nutrition/patients/${file.patient.id}/followups`, { method: 'POST', body: JSON.stringify({
                  admissionId: admId, weightKg: follow.weightKg ? Number(follow.weightKg) : undefined,
                  intakePctAvg: follow.intakePctAvg ? Number(follow.intakePctAvg) : undefined,
                  tolerance: follow.tolerance, note: follow.note,
                }) });
              }, 'سُجّلت المتابعة')}>حفظ المتابعة</button>
          </Card>}
        </div>
      </div>}
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

// ------------------------------------------------------- CSSD & infection ---
function CSSD({ m }: { m: Me }) {
  const [tab, setTab] = useState<'cssd' | 'ipc'>('cssd');
  const [board, setBoard] = useState<any>(null);
  const [ipc, setIpc] = useState<any>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [setForm, setSetForm] = useState({ code: '', nameAr: '', category: 'laparotomy', instrumentCount: '20', department: 'OR' });
  const [recv, setRecv] = useState({ setId: '', packaging: 'wrap' });
  const [loadForm, setLoadForm] = useState({ autoclaveCode: 'STM-01', method: 'steam', packIds: [] as string[] });
  const [issue, setIssue] = useState({ packId: '', issuedTo: 'غرفة العمليات 1', caseId: '' });
  const [iso, setIso] = useState({ patientId: '', precaution: 'contact', organism: '', reason: '' });
  const [hai, setHai] = useState({
    patientId: '', caseType: 'cauti', organism: '', deviceDays: '', notes: '',
    onsetDate: new Date().toISOString().slice(0, 10),
  });
  const [hyg, setHyg] = useState({ unit: 'العناية المركزة', moment: 'before_patient', opportunities: '20', compliant: '18', observedRole: 'nurse', notes: '' });
  const can = (p: string) => has(m, p);

  async function load() {
    try {
      if (can('cssd.read')) setBoard(await api<any>('/api/cssd/board'));
    } catch (e: any) { setErr(e.message); }
    try {
      if (can('infection.read')) setIpc(await api<any>('/api/infection/board'));
    } catch (e: any) { /* a role may hold only one of the two boards */ }
    try {
      if (can('patient.read')) {
        const list = await api<any>('/api/patients?limit=50');
        setPatients(list.items ?? []);
      }
    } catch { /* patient lookup is optional */ }
    try {
      if (can('surgery.read')) {
        const b = await api<any>('/api/surgery/board?status=active');
        setCases(b.items ?? []);
      }
    } catch { /* case linking is optional */ }
  }
  useEffect(() => { load(); }, []);
  async function act(fn: () => Promise<any>, msg: string) {
    setErr(null); setOk(null);
    try { await fn(); setOk(msg); await load(); } catch (e: any) { setErr(e.message); }
  }

  const packs: any[] = board?.packs ?? [];
  const loads: any[] = board?.loads ?? [];
  const sets: any[] = board?.sets ?? [];
  const releasedPacks = packs.filter((p) => p.status === 'released' && !p.expired);
  const packedPacks = packs.filter((p) => p.status === 'packed');

  return (
    <div className="space-y-4">
      <Msg text={err} /><Msg text={ok} kind="ok" />
      <div className="flex gap-2">
        {can('cssd.read') && <button className={tab === 'cssd' ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setTab('cssd')}>التعقيم المركزي (CSSD)</button>}
        {can('infection.read') && <button className={tab === 'ipc' ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setTab('ipc')}>مكافحة العدوى</button>}
      </div>

      {tab === 'cssd' && <>
        {board && <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          {[['قيد المعالجة', board.totals.in_process], ['قيد التعقيم', board.totals.sterilizing], ['جاهزة', board.totals.released],
            ['مصروفة', board.totals.issued], ['محجوزة', board.totals.quarantined], ['منتهية الصلاحية', board.totals.expired]].map(([l, v]) => (
            <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
          ))}
        </div>}

        {board && <Card title="حزم الأدوات ودورة التعقيم">
          <div className="overflow-x-auto"><table className="w-full min-w-[1100px]"><thead><tr>
            <th className="th">الحزمة</th><th className="th">الطقم</th><th className="th">الحالة</th><th className="th">الدورة</th>
            <th className="th">الصلاحية</th><th className="th">الجهة / العملية</th><th className="th"></th>
          </tr></thead><tbody>
            {packs.map((p: any) => <tr key={p.id} className={p.status === 'quarantined' || p.status === 'recalled' ? 'bg-rose-50/60' : p.expired ? 'bg-amber-50/60' : ''}>
              <td className="td text-xs font-mono">{p.pack_no}<span className="block text-slate-400">دورة الإنتاج #{p.cycle_count}</span></td>
              <td className="td text-xs">{p.set_name}<span className="block text-slate-400">{p.set_code} · {p.instrument_count} أداة · {p.packaging === 'container' ? 'حاوية' : 'تغليف ورقي'}</span></td>
              <td className="td text-xs"><Badge value={p.status} />{p.status_ar && <span className="block text-slate-400">{p.status_ar}</span>}</td>
              <td className="td text-xs">{p.load_no ? <>{p.load_no}<span className="block text-slate-400">{p.autoclave_code} · {p.method_ar ?? p.method} · مؤشر {p.biological_indicator === 'pass' ? 'سليم' : p.biological_indicator === 'fail' ? 'فاشل' : 'قيد الحضانة'}</span></> : '—'}</td>
              <td className="td text-xs">{p.expires_at ? <>{day(p.expires_at)}{p.expired ? <span className="block text-rose-700">منتهية</span> : <span className="block text-slate-400">متبقٍ {p.days_left} يوم</span>}</> : '—'}</td>
              <td className="td text-xs">{p.issued_to ?? '—'}{p.case_no && <span className="block text-slate-400">{p.case_no}</span>}{p.recall_reason && <span className="block text-rose-700">{p.recall_reason}</span>}</td>
              <td className="td"><div className="flex flex-wrap gap-1">
                {can('cssd.reprocess') && p.status === 'dirty' && <button className="btn-ghost text-xs" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/wash`, { method: 'POST' }), 'سُجّل الغسل')}>غسل</button>}
                {can('cssd.reprocess') && p.status === 'washing' && <button className="btn-ghost text-xs" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/pack`, { method: 'POST' }), 'غُلّفت الحزمة')}>تغليف</button>}
                {can('cssd.issue') && p.status === 'released' && !p.expired && <button className="btn-ghost text-xs" onClick={() => setIssue({ ...issue, packId: p.id })}>تجهيز الصرف</button>}
                {can('cssd.issue') && p.status === 'issued' && <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/use`, { method: 'POST' }), 'سُجّل استخدام الحزمة')}>تسجيل الاستخدام</button>}
                {can('cssd.reprocess') && ['issued', 'used'].includes(p.status) && <button className="btn-ghost text-xs" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/return`, { method: 'POST' }), 'أُعيدت الحزمة للتعقيم')}>استرجاع</button>}
              </div></td>
            </tr>)}
            {packs.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا حزم مسجلة.</td></tr>}
          </tbody></table></div>
          <p className="text-[11px] text-slate-500 mt-2">
            الصلاحية الافتراضية بعد الإفراج: تغليف ورقي ٣٠ يومًا وحاوية ٩٠ يومًا (سياسة موثقة وليست قراءة آلية من جهاز).
            فشل أي مؤشر يحجز كل حزم الدورة، ولا يجوز صرف حزمة قبل اعتماد الدورة من شخص آخر.
          </p>
        </Card>}

        {board && <Card title="دورات التعقيم">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
            <th className="th">الدورة</th><th className="th">الجهاز</th><th className="th">المؤشرات</th><th className="th">المشغّل / المعتمد</th><th className="th">الحالة</th><th className="th"></th>
          </tr></thead><tbody>
            {loads.map((l: any) => <tr key={l.id} className={l.status === 'failed' ? 'bg-rose-50/60' : ''}>
              <td className="td text-xs font-mono">{l.load_no}<span className="block text-slate-400">دورة {l.cycle_no} · {l.pack_count} حزمة</span></td>
              <td className="td text-xs">{l.autoclave_code}<span className="block text-slate-400">{l.method_ar ?? l.method} · {l.temperature_c ? `${Number(l.temperature_c)}°` : '—'} · {l.duration_min ? `${l.duration_min} د` : '—'}</span></td>
              <td className="td text-xs">كيميائي: {l.chemical_indicator === 'pass' ? 'سليم' : l.chemical_indicator === 'fail' ? 'فاشل' : '—'}<span className="block text-slate-400">بيولوجي: {l.biological_indicator === 'pass' ? 'سليم' : l.biological_indicator === 'fail' ? 'فاشل' : 'قيد الحضانة'}</span></td>
              <td className="td text-xs">{l.operator_name}<span className="block text-slate-400">{l.approver_name ? `اعتمدها ${l.approver_name}` : 'بانتظار اعتماد شخص آخر'}</span></td>
              <td className="td text-xs"><Badge value={l.status} />{l.recalled_at && <span className="block text-rose-700">مسحوبة</span>}</td>
              <td className="td"><div className="flex flex-wrap gap-1">
                {can('cssd.sterilize') && l.status === 'running' && <>
                  <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/cssd/loads/${l.id}/result`, { method: 'POST', body: JSON.stringify({ chemicalIndicator: 'pass', biologicalIndicator: 'pass' }) }), 'سُجّلت نتيجة ناجحة؛ يلزم اعتماد شخص آخر')}>نتيجة ناجحة</button>
                  <button className="btn-ghost text-xs" onClick={() => act(() => api(`/api/cssd/loads/${l.id}/result`, { method: 'POST', body: JSON.stringify({ chemicalIndicator: 'pass', biologicalIndicator: 'fail', notes: 'فشل المؤشر البيولوجي' }) }), 'سُجّل فشل الدورة وحُجزت حزمها')}>نتيجة فاشلة</button>
                </>}
                {can('cssd.release') && l.status === 'passed' && <button className="btn-primary text-xs" onClick={() => act(() => api(`/api/cssd/loads/${l.id}/approve`, { method: 'POST' }), 'اعتُمدت الدورة وأُفرج عن حزمها')}>اعتماد</button>}
                {can('cssd.release') && !l.recalled_at && l.status !== 'running' && <button className="btn-ghost text-xs text-rose-700" onClick={() => {
                  const reason = window.prompt('سبب سحب الدورة (٥ أحرف على الأقل):') ?? '';
                  if (reason.trim().length >= 5) act(() => api(`/api/cssd/loads/${l.id}/recall`, { method: 'POST', body: JSON.stringify({ reason }) }), 'سُحبت الدورة وأُبلغ عن الحالات المتأثرة');
                }}>سحب</button>}
              </div></td>
            </tr>)}
            {loads.length === 0 && <tr><td className="td text-slate-500" colSpan={6}>لا دورات مسجلة.</td></tr>}
          </tbody></table></div>
        </Card>}

        <div className="grid lg:grid-cols-3 gap-3">
          {can('cssd.manage') && <Card title="تعريف طقم أدوات">
            <div className="space-y-2">
              <input className="input" placeholder="رمز الطقم (مثال CSS-SET-30)" value={setForm.code} onChange={(e) => setSetForm({ ...setForm, code: e.target.value })} />
              <input className="input" placeholder="اسم الطقم" value={setForm.nameAr} onChange={(e) => setSetForm({ ...setForm, nameAr: e.target.value })} />
              <div className="flex gap-2">
                <select className="input" value={setForm.category} onChange={(e) => setSetForm({ ...setForm, category: e.target.value })}>
                  <option value="minor">جراحة صغرى</option><option value="laparotomy">فتح بطن</option><option value="orthopedic">عظام</option>
                  <option value="dressing">ضمادات</option><option value="endoscopy">مناظير</option><option value="other">أخرى</option>
                </select>
                <input className="input !w-28" type="number" min="1" max="500" value={setForm.instrumentCount} onChange={(e) => setSetForm({ ...setForm, instrumentCount: e.target.value })} />
              </div>
              <button className="btn-primary text-xs" disabled={setForm.code.length < 2 || setForm.nameAr.length < 3}
                onClick={() => act(() => api('/api/cssd/sets', { method: 'POST', body: JSON.stringify({ ...setForm, instrumentCount: Number(setForm.instrumentCount) }) }), 'أُضيف الطقم')}>إضافة</button>
            </div>
          </Card>}

          {can('cssd.reprocess') && <Card title="استلام حزمة ملوّثة">
            <div className="space-y-2">
              <select className="input" value={recv.setId} onChange={(e) => setRecv({ ...recv, setId: e.target.value })}>
                <option value="">اختر الطقم</option>
                {sets.map((s: any) => <option key={s.id} value={s.id}>{s.name_ar} ({s.code}) — {s.live_packs ? `نسخة قائمة` : 'متاح'}</option>)}
              </select>
              <select className="input" value={recv.packaging} onChange={(e) => setRecv({ ...recv, packaging: e.target.value })}>
                <option value="wrap">تغليف ورقي (٣٠ يومًا)</option><option value="container">حاوية (٩٠ يومًا)</option>
              </select>
              <button className="btn-primary text-xs" disabled={!recv.setId}
                onClick={() => act(async () => {
                  const r = await api<any>('/api/cssd/packs', { method: 'POST', body: JSON.stringify(recv) });
                  setRecv({ ...recv, setId: '' });
                  return r;
                }, 'سُجّل استلام الحزمة بدورة جديدة')}>تسجيل الاستلام</button>
              <p className="text-[11px] text-slate-500">الحزمة العائدة تُعاد بنفس رقمها مع زيادة عدّاد الدورات بدل إنشاء هوية جديدة.</p>
            </div>
          </Card>}

          {can('cssd.sterilize') && <Card title="فتح دورة تعقيم">
            <div className="space-y-2">
              <select className="input" value={loadForm.autoclaveCode} onChange={(e) => setLoadForm({ ...loadForm, autoclaveCode: e.target.value })}>
                <option value="STM-01">STM-01 — بخار</option><option value="STM-02">STM-02 — بخار</option><option value="STM-03">STM-03 — بخار</option>
              </select>
              <div className="max-h-28 overflow-y-auto border rounded-lg p-2 text-xs space-y-1">
                {packedPacks.map((p: any) => <label key={p.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={loadForm.packIds.includes(p.id)}
                    onChange={(e) => setLoadForm({ ...loadForm, packIds: e.target.checked ? [...loadForm.packIds, p.id] : loadForm.packIds.filter((x) => x !== p.id) })} />
                  {p.pack_no} · {p.set_name}
                </label>)}
                {packedPacks.length === 0 && <p className="text-slate-500">لا حزم مغلّفة جاهزة للدورة.</p>}
              </div>
              <button className="btn-primary text-xs" disabled={loadForm.packIds.length === 0}
                onClick={() => act(async () => {
                  const r = await api<any>('/api/cssd/loads', { method: 'POST', body: JSON.stringify({ ...loadForm, packIds: loadForm.packIds }) });
                  setLoadForm({ ...loadForm, packIds: [] });
                  return r;
                }, 'فُتحت دورة التعقيم')}>بدء الدورة ({loadForm.packIds.length})</button>
            </div>
          </Card>}
        </div>

        {can('cssd.issue') && <Card title="صرف حزمة معقمة">
          <div className="flex flex-wrap gap-2 items-end text-xs">
            <label className="flex-1 min-w-[220px]">الحزمة
              <select className="input mt-1" value={issue.packId} onChange={(e) => setIssue({ ...issue, packId: e.target.value })}>
                <option value="">اختر حزمة معقّمة</option>
                {releasedPacks.map((p: any) => <option key={p.id} value={p.id}>{p.pack_no} · {p.set_name} · {p.days_left} يوم</option>)}
              </select>
            </label>
            <label>الجهة المستلمة
              <input className="input mt-1" value={issue.issuedTo} onChange={(e) => setIssue({ ...issue, issuedTo: e.target.value })} />
            </label>
            {cases.length > 0 && <label>ربط بعملية (اختياري)
              <select className="input mt-1" value={issue.caseId} onChange={(e) => setIssue({ ...issue, caseId: e.target.value })}>
                <option value="">بدون ربط</option>
                {cases.map((c: any) => <option key={c.id} value={c.id}>{c.case_no} · {c.procedure_name}</option>)}
              </select>
            </label>}
            <button className="btn-primary text-xs" disabled={!issue.packId || issue.issuedTo.length < 2}
              onClick={() => act(async () => {
                const r = await api<any>(`/api/cssd/packs/${issue.packId}/issue`, { method: 'POST', body: JSON.stringify({ issuedTo: issue.issuedTo, caseId: issue.caseId || undefined }) });
                setIssue({ ...issue, packId: '', caseId: '' });
                return r;
              }, 'صُرفت الحزمة وسُجّل تتبعها')}>صرف</button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">لا يُقبل صرف حزمة منتهية الصلاحية أو لم تُعتمد دورتها. كل صرف يُقيّد في سجل التدقيق مع الجهة والمستخدم.</p>
        </Card>}
      </>}

      {tab === 'ipc' && <>
        {ipc && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[['عزل نشط', ipc.totals.active_isolations], ['حالات مشتبهة', ipc.totals.suspected_cases],
            ['مؤكدة آخر ٣٠ يومًا', ipc.totals.confirmed_30d], ['التزام نظافة الأيدي ٣٠ يومًا', `${ipc.totals.hygiene_compliance_30d}%`]].map(([l, v]) => (
            <div key={String(l)} className="card p-3"><p className="text-xs text-slate-500">{l}</p><p className="text-xl font-bold">{v as any}</p></div>
          ))}
        </div>}

        {ipc && <Card title="أوامر العزل النشطة">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
            <th className="th">المريض</th><th className="th">المكان</th><th className="th">نوع الاحتياط</th><th className="th">الكائن</th><th className="th">السبب</th><th className="th">البداية</th><th className="th"></th>
          </tr></thead><tbody>
            {ipc.isolations.map((i: any) => <tr key={i.id}>
              <td className="td text-xs">{i.patient_name}<span className="block text-slate-400">{i.mrn} · {i.admission_no ?? 'خارجي'}</span></td>
              <td className="td text-xs">{i.ward_name ?? '—'} {i.room_no ? `${i.room_no}/${i.bed_no ?? ''}` : ''}</td>
              <td className="td text-xs"><span className={i.precaution === 'airborne' ? 'badge bg-rose-100 text-rose-700' : 'badge bg-amber-100 text-amber-700'}>{i.precaution_ar}</span></td>
              <td className="td text-xs">{i.organism ?? '—'}</td>
              <td className="td text-xs max-w-[280px]">{i.reason}</td>
              <td className="td text-xs">{dt(i.started_at)}<span className="block text-slate-400">{i.ordered_by_name}</span></td>
              <td className="td">{can('infection.isolate') && <button className="btn-ghost text-xs" onClick={() => {
                const reason = window.prompt('سبب إنهاء العزل (٥ أحرف على الأقل):') ?? '';
                if (reason.trim().length >= 5) act(() => api(`/api/infection/isolations/${i.id}/end`, { method: 'POST', body: JSON.stringify({ reason }) }), 'أُنهي أمر العزل');
              }}>إنهاء العزل</button>}</td>
            </tr>)}
            {ipc.isolations.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا أوامر عزل نشطة.</td></tr>}
          </tbody></table></div>
        </Card>}

        {can('infection.surveillance') && <Card title="تسجيل حالة عدوى مرتبطة بالرعاية">
          <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs items-end">
            <label className="lg:col-span-2">المريض
              <select className="input mt-1" value={hai.patientId} onChange={(e) => setHai({ ...hai, patientId: e.target.value })}>
                <option value="">اختر المريض</option>
                {patients.map((p: any) => <option key={p.id} value={p.id}>{p.full_name_ar ?? p.full_name} · {p.mrn}</option>)}
              </select>
            </label>
            <label>النوع
              <select className="input mt-1" value={hai.caseType} onChange={(e) => setHai({ ...hai, caseType: e.target.value })}>
                <option value="cauti">عدوى بولية</option><option value="clabsi">عدوى دم</option><option value="vap">التهاب رئة</option>
                <option value="ssi">موضع جراحي</option><option value="cdi">مطثية عسيرة</option><option value="mrsa">MRSA</option><option value="other">أخرى</option>
              </select>
            </label>
            <label>تاريخ البدء
              <input className="input mt-1" type="date" value={hai.onsetDate} onChange={(e) => setHai({ ...hai, onsetDate: e.target.value })} />
            </label>
            <label>الكائن الممرض
              <input className="input mt-1" value={hai.organism} onChange={(e) => setHai({ ...hai, organism: e.target.value })} />
            </label>
            <label>أيام الأجهزة
              <input className="input mt-1" type="number" min="0" max="365" value={hai.deviceDays} onChange={(e) => setHai({ ...hai, deviceDays: e.target.value })} />
            </label>
            <label className="lg:col-span-4">ملاحظات
              <input className="input mt-1" value={hai.notes} onChange={(e) => setHai({ ...hai, notes: e.target.value })} />
            </label>
            <div className="lg:col-span-2">
              <button className="btn-primary text-xs" disabled={!hai.patientId || !hai.onsetDate}
                onClick={() => act(async () => {
                  const r = await api<any>('/api/infection/cases', {
                    method: 'POST', body: JSON.stringify({
                      patientId: hai.patientId, caseType: hai.caseType, onsetDate: hai.onsetDate,
                      organism: hai.organism || undefined, deviceDays: hai.deviceDays ? Number(hai.deviceDays) : undefined,
                      notes: hai.notes || undefined,
                    }),
                  });
                  setHai({ ...hai, organism: '', deviceDays: '', notes: '' });
                  return r;
                }, 'سُجّلت حالة مشتبهة بانتظار مراجعة شخص آخر')}>تسجيل الحالة</button>
            </div>
          </div>
        </Card>}

        {ipc && <Card title="ترصد حالات العدوى (٩٠ يومًا)">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr>
            <th className="th">المريض</th><th className="th">النوع</th><th className="th">البداية</th><th className="th">أيام الأجهزة</th><th className="th">الحالة</th><th className="th">المراجع</th><th className="th"></th>
          </tr></thead><tbody>
            {ipc.cases.map((c: any) => <tr key={c.id} className={c.status === 'suspected' ? 'bg-amber-50/50' : ''}>
              <td className="td text-xs">{c.patient_name}<span className="block text-slate-400">{c.mrn} · {c.admission_no ?? 'خارجي'}</span></td>
              <td className="td text-xs">{c.case_type_ar}<span className="block text-slate-400">{c.organism ?? '—'}</span></td>
              <td className="td text-xs">{day(c.onset_date)}</td>
              <td className="td text-xs">{c.device_days ?? '—'}</td>
              <td className="td text-xs"><Badge value={c.status} /></td>
              <td className="td text-xs">{c.reviewed_by_name ?? '—'}{c.review_note && <span className="block text-slate-400 max-w-[240px]">{c.review_note}</span>}</td>
              <td className="td"><div className="flex gap-1">
                {can('infection.confirm') && c.status === 'suspected' && <>
                  <button className="btn-primary text-xs" onClick={() => {
                    const note = window.prompt('ملاحظة الاعتماد (٥ أحرف على الأقل):') ?? '';
                    if (note.trim().length >= 5) act(() => api(`/api/infection/cases/${c.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'confirmed', note }) }), 'اعتُمدت الحالة');
                  }}>تأكيد</button>
                  <button className="btn-ghost text-xs" onClick={() => {
                    const note = window.prompt('سبب الاستبعاد (٥ أحرف على الأقل):') ?? '';
                    if (note.trim().length >= 5) act(() => api(`/api/infection/cases/${c.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'excluded', note }) }), 'استُبعدت الحالة');
                  }}>استبعاد</button>
                </>}
              </div></td>
            </tr>)}
            {ipc.cases.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>لا حالات مسجلة.</td></tr>}
          </tbody></table></div>
          <p className="text-[11px] text-slate-500 mt-2">
            هذه أعداد وصفية للحالات المرتبطة بالرعاية وليست معدلات معيارية معدّلة حسب NHSN/CDC. لا يوجد كشف آلي لتفشي العدوى؛ المراجعة بشرية.
          </p>
        </Card>}

        <div className="grid lg:grid-cols-2 gap-3">
          {can('infection.isolate') && <Card title="أمر عزل جديد">
            <div className="space-y-2 text-xs">
              <select className="input" value={iso.patientId} onChange={(e) => setIso({ ...iso, patientId: e.target.value })}>
                <option value="">اختر المريض</option>
                {patients.map((p: any) => <option key={p.id} value={p.id}>{p.full_name_ar ?? p.full_name} · {p.mrn}</option>)}
              </select>
              <select className="input" value={iso.precaution} onChange={(e) => setIso({ ...iso, precaution: e.target.value })}>
                <option value="contact">ملامسة</option><option value="droplet">رذاذ</option><option value="airborne">هوائي</option><option value="protective">حماية عكسية</option>
              </select>
              <input className="input" placeholder="الكائن الممرض (اختياري)" value={iso.organism} onChange={(e) => setIso({ ...iso, organism: e.target.value })} />
              <input className="input" placeholder="السبب السريري (٥ أحرف على الأقل)" value={iso.reason} onChange={(e) => setIso({ ...iso, reason: e.target.value })} />
              <button className="btn-primary text-xs" disabled={!iso.patientId || iso.reason.length < 5}
                onClick={() => act(async () => {
                  const r = await api<any>('/api/infection/isolations', { method: 'POST', body: JSON.stringify({ ...iso, organism: iso.organism || undefined }) });
                  setIso({ ...iso, patientId: '', organism: '', reason: '' });
                  return r;
                }, 'صدر أمر العزل')}>إصدار أمر العزل</button>
              <p className="text-[11px] text-slate-500">عزل واحد نشط لكل مريض؛ تغيير الاحتياط يتطلب إنهاء الأمر السابق بسبب موثّق.</p>
            </div>
          </Card>}

          {can('infection.audit') && <Card title="تدقيق نظافة الأيدي">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label>الوحدة<input className="input mt-1" value={hyg.unit} onChange={(e) => setHyg({ ...hyg, unit: e.target.value })} /></label>
              <label>اللحظة
                <select className="input mt-1" value={hyg.moment} onChange={(e) => setHyg({ ...hyg, moment: e.target.value })}>
                  <option value="before_patient">قبل لمس المريض</option><option value="before_aseptic">قبل إجراء معقّم</option>
                  <option value="after_body_fluid">بعد سوائل الجسم</option><option value="after_patient">بعد لمس المريض</option>
                  <option value="after_surroundings">بعد محيط المريض</option>
                </select>
              </label>
              <label>الفرص<input className="input mt-1" type="number" min="1" max="100" value={hyg.opportunities} onChange={(e) => setHyg({ ...hyg, opportunities: e.target.value })} /></label>
              <label>الملتزم بها<input className="input mt-1" type="number" min="0" max="100" value={hyg.compliant} onChange={(e) => setHyg({ ...hyg, compliant: e.target.value })} /></label>
              <label>الفئة المرصودة
                <select className="input mt-1" value={hyg.observedRole} onChange={(e) => setHyg({ ...hyg, observedRole: e.target.value })}>
                  <option value="nurse">تمريض</option><option value="physician">أطباء</option><option value="tech">فنيون</option><option value="other">أخرى</option>
                </select>
              </label>
              <label>ملاحظة<input className="input mt-1" value={hyg.notes} onChange={(e) => setHyg({ ...hyg, notes: e.target.value })} /></label>
              <div className="col-span-2">
                <button className="btn-primary text-xs" disabled={Number(hyg.compliant) > Number(hyg.opportunities)}
                  onClick={() => act(() => api('/api/infection/hand-hygiene', {
                    method: 'POST', body: JSON.stringify({
                      ...hyg, opportunities: Number(hyg.opportunities), compliant: Number(hyg.compliant), notes: hyg.notes || undefined,
                    }),
                  }), 'سُجّلت ملاحظة نظافة الأيدي')}>تسجيل الملاحظة</button>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">الملاحظات نهائية وغير قابلة للتعديل أو الحذف بعد الحفظ (دليل تدقيق).</p>
          </Card>}
        </div>

        {ipc && <Card title="التزام نظافة الأيدي حسب الوحدة (٣٠ يومًا)">
          <table className="w-full"><thead><tr><th className="th">الوحدة</th><th className="th">الفرص</th><th className="th">الملتزم بها</th><th className="th">النسبة</th></tr></thead><tbody>
            {ipc.hygiene.map((h: any) => <tr key={h.unit}>
              <td className="td text-xs">{h.unit}</td><td className="td text-xs">{h.opportunities}</td><td className="td text-xs">{h.compliant}</td>
              <td className="td text-xs"><span className={Number(h.compliance_pct) < 80 ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>{h.compliance_pct}%</span></td>
            </tr>)}
            {ipc.hygiene.length === 0 && <tr><td className="td text-slate-500" colSpan={4}>لا ملاحظات في آخر ٣٠ يومًا.</td></tr>}
          </tbody></table>
        </Card>}
      </>}
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
  { key: 'nursing', label: 'التمريض', perms: ['nursing.read'] },
  { key: 'surgery', label: 'العمليات والتخدير', perms: ['surgery.read'] },
  { key: 'icu', label: 'العناية المركزة', perms: ['icu.read'] },
  { key: 'bloodbank', label: 'بنك الدم', perms: ['bloodbank.read'] },
  { key: 'nutrition', label: 'التغذية الطبية', perms: ['nutrition.read', 'nutrition.kitchen'] },
  { key: 'cssd', label: 'التعقيم ومكافحة العدوى', perms: ['cssd.read', 'infection.read'] },
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
        {page === 'nursing' && <Nursing m={auth} />}
        {page === 'surgery' && <Surgery m={auth} />}
        {page === 'icu' && <Icu m={auth} />}
        {page === 'bloodbank' && <BloodBank m={auth} />}
        {page === 'nutrition' && <Nutrition m={auth} />}
        {page === 'cssd' && <CSSD m={auth} />}
        {page === 'lab' && <Lab m={auth} />}
        {page === 'radiology' && <Radiology m={auth} />}
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
