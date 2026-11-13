import { Button } from '../components';
import { navigate } from '../hooks/useHashRoute';

export default function ForbiddenPage({
  pageTitle,
  fallbackRoute,
}: {
  pageTitle?: string;
  fallbackRoute: string;
}) {
  return (
    <div className="card p-8 max-w-lg mx-auto my-8 text-center space-y-3">
      <div
        aria-hidden="true"
        className="mx-auto w-12 h-12 rounded-full bg-rose-100 text-rose-700 flex items-center justify-center text-xl font-bold"
      >
        ⊘
      </div>
      <h1 className="text-lg font-bold text-slate-900">غير مصرح بالوصول إلى هذا القسم (403)</h1>
      <p className="text-sm text-slate-600">
        {pageTitle ? `قسم «${pageTitle}» ` : 'هذا القسم '}
        يتطلب صلاحيات غير مسندة لدورك الوظيفي الحالي في المنشأة النشطة. جميع محاولات الوصول غير المصرح بها تخضع لسياسة الحد الأدنى من الصلاحيات.
      </p>
      <div className="pt-2">
        <Button variant="primary" onClick={() => navigate(fallbackRoute)}>
          العودة إلى الصفحة الرئيسية المتاحة
        </Button>
      </div>
    </div>
  );
}
