import { Button } from '../components';
import { navigate } from '../hooks/useHashRoute';

export default function NotFoundPage({ fallbackRoute }: { fallbackRoute: string }) {
  return (
    <div className="card p-8 max-w-lg mx-auto my-8 text-center space-y-3">
      <div
        aria-hidden="true"
        className="mx-auto w-12 h-12 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center text-xl font-bold"
      >
        ؟
      </div>
      <h1 className="text-lg font-bold text-slate-900">الصفحة غير موجودة (404)</h1>
      <p className="text-sm text-slate-600">
        الرابط الذي حاولت فتحه لا يطابق أي شاشة معرّفة في النظام. تحقق من العنوان أو انتقل عبر القائمة الجانبية.
      </p>
      <div className="pt-2">
        <Button variant="primary" onClick={() => navigate(fallbackRoute)}>
          الانتقال إلى الصفحة الرئيسية
        </Button>
      </div>
    </div>
  );
}
