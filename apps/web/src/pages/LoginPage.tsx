import { useMemo, useState } from 'react';
import { api, login, me, resetCsrf, type Me } from '../api';
import { Button, EphemeralBanner, Input } from '../components';

const DEMO_ACCOUNTS: Array<{ group: string; items: Array<[string, string, string]> }> = [
  {
    group: 'الكادر الطبي، الأسنان، التأهيل والتمريض',
    items: [
      ['طبيب باطنة', 'dr.ahmed@demo.hms', 'Doctor#Demo2026'],
      ['طبيبة طوارئ', 'dr.sara@demo.hms', 'Doctor#Demo2026'],
      ['طبيب وجراح أسنان', 'dentist@demo.hms', 'Dental#Demo2026'],
      ['أخصائي علاج طبيعي', 'physio@demo.hms', 'Physio#Demo2026'],
      ['جرّاح عام', 'surgeon@demo.hms', 'Surgeon#Demo2026'],
      ['طبيب تخدير', 'anesthesia@demo.hms', 'Anesthesia#Demo2026'],
      ['تمريض عمليات', 'ornurse@demo.hms', 'Nurse#Demo2026'],
      ['استشاري عناية مركزة', 'intensivist@demo.hms', 'ICU#Demo2026'],
      ['تمريض عناية مركزة', 'icunurse@demo.hms', 'ICU#Demo2026'],
      ['ممرض جناح', 'nurse@demo.hms', 'Nurse#Demo2026'],
      ['ممرض ثانٍ (شاهد)', 'nurse2@demo.hms', 'Nurse#Demo2026'],
    ],
  },
  {
    group: 'التشخيص، المخازن، والمساندة السريرية',
    items: [
      ['مختبر (إدخال)', 'lab@demo.hms', 'Lab#Demo2026'],
      ['مختبر (اعتماد)', 'lab2@demo.hms', 'Lab#Demo2026'],
      ['فني أشعة', 'radiology@demo.hms', 'Radiology#Demo2026'],
      ['استشاري أشعة', 'radiologist@demo.hms', 'Radiology#Demo2026'],
      ['بنك الدم', 'bloodbank@demo.hms', 'Blood#Demo2026'],
      ['أمين مستودع (طلب/توريد)', 'stores@demo.hms', 'Store#Demo2026'],
      ['أمين مستودع ثانٍ (صرف SoD)', 'stores2@demo.hms', 'Store#Demo2026'],
      ['صيدلي', 'pharmacist@demo.hms', 'Pharma#Demo2026'],
      ['أخصائي تغذية', 'dietitian@demo.hms', 'Nutrition#Demo2026'],
      ['مطبخ التغذية', 'kitchen@demo.hms', 'Kitchen#Demo2026'],
      ['فني تعقيم (CSSD)', 'cssd@demo.hms', 'CSSD#Demo2026'],
      ['مشرف تعقيم', 'cssd2@demo.hms', 'CSSD#Demo2026'],
      ['مكافحة العدوى', 'infection@demo.hms', 'Infection#Demo2026'],
    ],
  },
  {
    group: 'الموارد البشرية، الاستقبال، والحوكمة',
    items: [
      ['موارد بشرية (إدخال)', 'hr@demo.hms', 'HR#Demo2026'],
      ['مشرف تراخيص وإجازات', 'hr2@demo.hms', 'HR#Demo2026'],
      ['استقبال ومواعيد', 'reception@demo.hms', 'Reception#Demo2026'],
      ['السجلات الطبية والدمج', 'records@demo.hms', 'Records#Demo2026'],
      ['محاسب فوترة', 'accountant@demo.hms', 'Account#Demo2026'],
      ['المدير التنفيذي', 'director@demo.hms', 'Director#Demo2026'],
      ['مدير النظام', 'admin@demo.hms', 'Admin#Demo2026'],
      ['مدقق داخلي', 'auditor@demo.hms', 'Auditor#Demo2026'],
      ['بوابة المريض', 'patient@demo.hms', 'Patient#Demo2026'],
    ],
  },
];

function normalizeCode(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, '');
}

type AuthStep = 'credentials' | 'mfa_verify' | 'mfa_enroll' | 'mfa_recovery_codes';

export default function LoginPage({ onLogin, notice }: { onLogin: (m: Me) => void; notice?: string }) {
  const [email, setEmail] = useState('dr.ahmed@demo.hms');
  const [password, setPassword] = useState('Doctor#Demo2026');
  const [showPassword, setShowPassword] = useState(false);
  const [roleFilter, setRoleFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<AuthStep>('credentials');
  const [code, setCode] = useState('');
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  const filteredGroups = useMemo(() => {
    const q = roleFilter.trim().toLowerCase();
    if (!q) return DEMO_ACCOUNTS;
    return DEMO_ACCOUNTS.map((grp) => ({
      ...grp,
      items: grp.items.filter(
        ([label, demoEmail]) => label.toLowerCase().includes(q) || demoEmail.toLowerCase().includes(q),
      ),
    })).filter((grp) => grp.items.length > 0);
  }, [roleFilter]);

  async function performLogin(targetEmail: string, targetPass: string) {
    setBusy(true);
    setErr(null);
    try {
      const res = await login(targetEmail.trim(), targetPass);
      if (res.mfaRequired) {
        setCode('');
        setStep('mfa_verify');
        return;
      }
      if (res.mfaEnrollmentRequired) {
        const setup = await api<{ secret: string; otpauth: string }>('/api/auth/mfa/setup', { method: 'POST' });
        setMfaSetup(setup);
        setCode('');
        setStep('mfa_enroll');
        return;
      }
      onLogin(await me());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'تعذّر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await performLogin(email, password);
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ code: normalizeCode(code) }),
      });
      onLogin(await me());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'رمز التحقق غير صحيح');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfaEnroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const out = await api<{ recoveryCodes: string[] }>('/api/auth/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ code: normalizeCode(code) }),
      });
      setRecoveryCodes(out.recoveryCodes ?? []);
      setStep('mfa_recovery_codes');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'رمز التحقق غير صحيح');
    } finally {
      setBusy(false);
    }
  }

  async function cancelMfaStep() {
    setBusy(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    } finally {
      resetCsrf();
      setCode('');
      setMfaSetup(null);
      setErr(null);
      setStep('credentials');
      setBusy(false);
    }
  }

  async function finishAfterRecoveryCodes() {
    setBusy(true);
    try {
      onLogin(await me());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'تعذّر إكمال الدخول');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <EphemeralBanner />
      <div className="flex-1 grid lg:grid-cols-12">
        <div className="hidden lg:flex lg:col-span-5 flex-col justify-between bg-brand-900 text-white p-10">
          <div>
            <div className="w-12 h-12 rounded-2xl bg-white/15 grid place-items-center mb-5">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="w-7 h-7 fill-current">
                <path d="M10.5 4h3v6.5H20v3h-6.5V20h-3v-6.5H4v-3h6.5V4z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold leading-snug">نظام إدارة المستشفى</h1>
            <p className="text-brand-100 mt-2 text-base">
              منصة تشغيلية وسريرية موحّدة — مصممة بالعربية أولًا (RTL) مع دعم الإنجليزية.
            </p>
          </div>

          <div className="space-y-3 text-sm text-brand-100">
            <div className="rounded-xl bg-white/10 p-4 space-y-1.5">
              <p className="font-bold text-white">الضوابط المطبّقة فعليًا:</p>
              <p>• عزل بيانات المنشآت على مستوى الصفوف في PostgreSQL (<span className="font-mono">FORCE RLS</span>)</p>
              <p>• فصل المهام (SoD) في المختبرات، التمريض، بنك الدم، المخازن الطبية، التعقيم، مكافحة العدوى، والتراخيص المهنية</p>
              <p>• سجل تدقيق غير قابل للتعديل مرتبط بسلسلة تجزئة SHA-256</p>
            </div>
            <p className="text-xs text-brand-200/90">
              بيانات تجريبية اصطناعية بالكامل — لا يُستخدم لرعاية مرضى حقيقيين قبل تقييم أمني وتنظيمي مستقل.
            </p>
          </div>
        </div>

        <div className="lg:col-span-7 flex items-center justify-center p-5 sm:p-8 bg-slate-50">
          <div className="w-full max-w-xl">
            <div className="mb-5">
              <h2 className="text-2xl font-bold text-slate-900">تسجيل الدخول</h2>
              <p className="text-sm text-slate-500 mt-1">
                تُنشأ جلسة محمية بملف تعريف ارتباط <span className="font-mono">HttpOnly</span> ورمز CSRF مزدوج.
              </p>
            </div>

            {notice && (
              <div role="status" className="rounded-xl px-3.5 py-2.5 text-sm mb-4 bg-emerald-50 text-emerald-800 border border-emerald-200">
                {notice}
              </div>
            )}
            {err && (
              <div role="alert" className="rounded-xl px-3.5 py-2.5 text-sm mb-4 bg-rose-50 text-rose-800 border border-rose-200">
                {err}
              </div>
            )}

            {step === 'credentials' && (
              <form onSubmit={submit} className="card p-5 space-y-4">
                <Input
                  label="البريد الإلكتروني"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  dir="ltr"
                  autoComplete="username"
                />
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label htmlFor="login-password-input" className="label mb-0">
                      كلمة المرور
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                      className="text-xs text-brand-700 hover:text-brand-900 font-medium cursor-pointer"
                    >
                      {showPassword ? 'إخفاء' : 'إظهار'}
                    </button>
                  </div>
                  <input
                    id="login-password-input"
                    className="input"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    dir="ltr"
                    autoComplete="current-password"
                  />
                </div>
                <Button type="submit" variant="primary" className="w-full" busy={busy}>
                  تسجيل الدخول
                </Button>
              </form>
            )}

            {step === 'mfa_verify' && (
              <form onSubmit={submitMfa} className="card p-5 space-y-4">
                <Input
                  label="رمز التحقق الثنائي (TOTP أو رمز استرداد)"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                  autoFocus
                  hint="أدخل الرمز المكون من 6 أرقام من تطبيق المصادقة (يدعم الأرقام العربية والإنجليزية)."
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" className="flex-1" busy={busy}>
                    تحقق ودخول
                  </Button>
                  <Button type="button" variant="ghost" onClick={cancelMfaStep} disabled={busy}>
                    رجوع
                  </Button>
                </div>
              </form>
            )}

            {step === 'mfa_enroll' && mfaSetup && (
              <form onSubmit={submitMfaEnroll} className="card p-5 space-y-4">
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950 space-y-1.5">
                  <p className="font-bold">إعداد التحقق الثنائي (MFA) إلزامي لهذا الحساب</p>
                  <p>أضف المفتاح السري التالي في تطبيق المصادقة (مثل Google Authenticator أو Authy) ثم أدخل الرمز المكوّن من 6 أرقام:</p>
                  <p className="font-mono text-sm bg-white px-2.5 py-1.5 rounded border border-amber-200 select-all text-left" dir="ltr">
                    {mfaSetup.secret}
                  </p>
                </div>
                <Input
                  label="رمز التأكيد من تطبيق المصادقة"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" className="flex-1" busy={busy}>
                    تأكيد وتفعيل MFA
                  </Button>
                  <Button type="button" variant="ghost" onClick={cancelMfaStep} disabled={busy}>
                    رجوع
                  </Button>
                </div>
              </form>
            )}

            {step === 'mfa_recovery_codes' && (
              <div className="card p-5 space-y-4">
                <div className="space-y-1">
                  <h3 className="font-bold text-slate-900">رموز الاسترداد الاحتياطية (احتفظ بها في مكان آمن)</h3>
                  <p className="text-xs text-slate-600">يُستخدم كل رمز مرة واحدة فقط في حال فقدان تطبيق المصادقة:</p>
                </div>
                <div className="grid grid-cols-2 gap-2 bg-slate-100 p-3 rounded-xl font-mono text-xs text-center" dir="ltr">
                  {recoveryCodes.map((rc) => (
                    <span key={rc} className="bg-white py-1 px-2 rounded border border-slate-200">
                      {rc}
                    </span>
                  ))}
                </div>
                <Button type="button" variant="primary" className="w-full" busy={busy} onClick={finishAfterRecoveryCodes}>
                  متابعة إلى النظام
                </Button>
              </div>
            )}

            {step === 'credentials' && (
              <div className="mt-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold text-slate-600">
                    حسابات تجريبية جاهزة ({DEMO_ACCOUNTS.reduce((n, g) => n + g.items.length, 0)} حسابًا — اضغط للتعبئة أو مرتين للدخول الفوري):
                  </p>
                  <input
                    type="search"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    placeholder="تصفية الأدوار..."
                    aria-label="تصفية الحسابات التجريبية"
                    className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-brand-500 w-40"
                  />
                </div>
                {filteredGroups.map((grp) => (
                  <div key={grp.group} className="space-y-1.5">
                    <p className="text-[11px] font-semibold text-slate-500">{grp.group}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {grp.items.map(([label, demoEmail, demoPass]) => (
                        <button
                          key={demoEmail}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEmail(demoEmail);
                            setPassword(demoPass);
                            setErr(null);
                          }}
                          onDoubleClick={() => {
                            setEmail(demoEmail);
                            setPassword(demoPass);
                            void performLogin(demoEmail, demoPass);
                          }}
                          title={`${demoEmail} — نقرة للتعبئة، نقرتان للدخول المباشر`}
                          className={`text-xs px-2.5 py-1.5 rounded-lg border transition cursor-pointer ${
                            email === demoEmail
                              ? 'bg-brand-50 border-brand-500 text-brand-900 font-semibold'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
