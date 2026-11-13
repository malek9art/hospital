import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[HMS ErrorBoundary]', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="min-h-[60vh] flex items-center justify-center p-6">
          <div className="card max-w-lg w-full p-6 border-rose-200 space-y-3 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-rose-100 text-rose-700 grid place-items-center text-xl font-bold">
              !
            </div>
            <h1 className="text-lg font-bold text-slate-900">حدث خطأ غير متوقع في عرض هذه الشاشة</h1>
            <p className="text-xs text-slate-600">
              لم تتأثر البيانات المحفوظة على الخادم. يمكنك إعادة محاولة العرض أو العودة إلى الصفحة الرئيسية.
            </p>
            <p className="text-xs font-mono bg-slate-100 text-slate-700 rounded p-2 break-all">
              {this.state.error.message}
            </p>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="primary" onClick={this.reset}>
                إعادة المحاولة
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  window.location.hash = '#/dashboard';
                  this.reset();
                }}
              >
                العودة للرئيسية
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
