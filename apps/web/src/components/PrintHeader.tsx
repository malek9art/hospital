import { dt } from '../lib/format';

export interface PrintHeaderProps {
  facilityName?: string;
  documentTitle: string;
  documentNo?: string | null;
}

export function PrintHeader({ facilityName = 'المنشأة الصحية', documentTitle, documentNo }: PrintHeaderProps) {
  return (
    <div className="print-only border-b-2 border-slate-800 pb-3 mb-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-base font-bold">{facilityName}</p>
          <p className="text-xs text-slate-600">نظام إدارة المستشفى — مستند مطبوع من السجل الإلكتروني</p>
        </div>
        <div className="text-end text-xs">
          <p className="font-bold text-sm">{documentTitle}</p>
          {documentNo && <p className="font-mono">رقم المستند: {documentNo}</p>}
          <p>تاريخ الطباعة: {dt(new Date().toISOString())}</p>
        </div>
      </div>
    </div>
  );
}
