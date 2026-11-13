import { EmptyState, PageHeader, Button } from '../components';
import { navigate } from '../hooks/useHashRoute';

export default function HrPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="الموارد البشرية والدوام"
        subtitle="إدارة ملفات الموظفين، التراخيص المهنية، المناوبات، والإجازات."
      />
      <EmptyState
        title="الوحدة قيد التفعيل"
        description="راجع خريطة حالة الوحدات لمعرفة تفاصيل نطاق الموارد البشرية والدوام."
        action={
          <Button variant="ghost" onClick={() => navigate('#/modules')}>
            مراجعة حالة الوحدات
          </Button>
        }
      />
    </div>
  );
}
