import { useState } from 'react';
import { api, login, me, type Me } from '../api';
import { Button, EphemeralBanner, Input } from '../components';

const DEMO_ACCOUNTS: Array<{ group: string; items: Array<[string, string, string]> }> = [
  {
    group: 'الكادر الطبي والتمريضي',
    items: [
      ['طبيب باطنة', 'dr.ahmed@demo.hms', 'Doctor#Demo2026'],
      ['جرّاح عام', 'surgeon@demo.hms', 'Surgeon#Demo2026'],
      ['طبيب تخدير', 'anesth@demo.hms', 'Anesth#Demo2026'],
      ['استشاري عناية مركزة', 'icu.dr@demo.hms', 'IcuDoc#Demo2026'],
      ['ممرض جناح', 'nurse@demo.hms', 'Nurse#Demo2026'],
      ['ممرض ثانٍ (شاهد)', 'nurse2@demo.hms', 'Nurse2#Demo2026'],
    ],
  },
  {
    group: 'التشخيص والمساندة السريرية',
    items: [
      ['مختبر (إدخال)', 'lab@demo.hms', 'Lab#Demo2026'],
      ['مختبر (اعتماد)', 'lab.sup@demo.hms', 'LabSup#Demo2026'],
      ['أخصائي أشعة', 'radiologist@demo.hms', 'RadioDoc#Demo2026'],
      ['صيدلي', 'pharmacist@demo.hms', 'Pharma#Demo2026'],
      ['بنك الدم', 'bloodbank@demo.hms', 'Blood#Demo2026'],
      ['أخصائي تغذية', 'dietitian@demo.hms', 'Nutrition#Demo2026'],
      ['مطبخ التغذية', 'kitchen@demo.hms', 'Kitchen#Demo2026'],
      ['فني تعقيم (CSSD)', 'cssd@demo.hms', 'CSSD#Demo2026'],
      ['مشرف تعقيم', 'cssd.sup@demo.hms', 'CSSDSup#Demo2026'],
      ['مكافحة العدوى', 'infection@demo.hms', 'Infection#Demo2026'],
    ],
  },
  {
    group: 'الاستقبال، المالية، والحوكمة',
    items: [
      ['استقبال ومواعيد', 'reception@demo.hms', 'Reception#Demo2026'],
      ['محاسب فوترة', 'accountant@demo.hms', 'Account#Demo2026'],
      ['مدير النظام', 'admin@demo.hms', 'Admin#Demo2026'],
      ['مدقق داخلي', 'auditor@demo.hms', 'Auditor#Demo2026'],
      ['بوابة المريض', 'patient@demo.hms', 'Patient#Demo2026'],
    ],
  },
];

export default function LoginPage({ onLogin, notice }: { onLogin: (m: Me) => void; notice?: string }) {
  const [email, setEmail] = useState('dr.ahmed@demo.hms');
  const [password, setPassword] = useState('Doctor#Demo2026');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await login(email.trim(), password);
      if (res.mfaRequired) {
        setMfa(true);
        return;
      }
      onLogin(await me());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'تعذّر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
      onLogin(await me());
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'رمز التحقق غير صحيح');
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
              <p>• فصل المهام (SoD) في المختبر، التمريض، بنك الدم، التعقيم، ومكافحة العدوى</p>
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

            {!mfa ? (
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
                <Input
                  label="كلمة المرور"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  autoComplete="current-password"
                />
                <Button type="submit" variant="primary" className="w-full" busy={busy}>
                  تسجيل الدخول
                </Button>
              </form>
            ) : (
              <form onSubmit={submitMfa} className="card p-5 space-y-4">
                <Input
                  label="رمز التحقق الثنائي (TOTP أو رمز استرداد)"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                  hint="أدخل الرمز المكون من 6 أرقام من تطبيق المصادقة."
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" className="flex-1" busy={busy}>
                    تحقق ودخول
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setMfa(false)}>
                    رجوع
                  </Button>
                </div>
              </form>
            )}

            <div className="mt-6 space-y-3">
              <p className="text-xs font-bold text-slate-600">حسابات تجريبية جاهزة (اضغط للتعبئة السريعة):</p>
              {DEMO_ACCOUNTS.map((grp) => (
                <div key={grp.group} className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-slate-500">{grp.group}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {grp.items.map(([label, demoEmail, demoPass]) => (
                      <button
                        key={demoEmail}
                        type="button"
                        onClick={() => {
                          setEmail(demoEmail);
                          setPassword(demoPass);
                          setErr(null);
                        }}
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
          </div>
        </div>
      </div>
    </div>
  );
}
