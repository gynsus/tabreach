import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

type Tone = 'ok' | 'bad';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

/** Short, non-blocking confirmations ("Exported 120 rows"). Announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const show = useCallback((message: string, tone: Tone = 'ok') => {
    const id = next.current++;
    setToasts((all) => [...all, { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4_000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 grid gap-2">
        {toasts.map((t) => (
          <p
            key={t.id}
            data-testid="toast"
            className={cn(
              'rounded-md px-3 py-2 text-[13px] shadow-lg',
              t.tone === 'ok' ? 'bg-ink text-paper' : 'bg-bad text-accent-ink',
            )}
          >
            {t.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
