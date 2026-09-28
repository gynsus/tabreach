import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { translateKey } from '../i18n';
import { cn } from '../lib/cn';

const buttonStyles = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
        secondary: 'border border-rule bg-raised text-ink hover:border-accent',
        ghost: 'text-soft hover:bg-sunken hover:text-ink',
        danger: 'border border-bad text-bad hover:bg-bad-bg',
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-[13px]' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonStyles>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonStyles({ variant, size }), className)} {...props} />
  );
});

const control =
  'h-8 w-full rounded-md border border-rule bg-raised px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(control, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(control, 'pr-7', className)} {...props} />;
});

/** Label + control + translated error key. `children` receives the generated id. */
export function Field(props: {
  label: string;
  hint?: string;
  errorKey?: string | undefined;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const messageId = `${id}-message`;
  const error = props.errorKey ? translateKey(t, `errors.${props.errorKey}`, t('errors.generic')) : null;
  return (
    <div className={cn('grid gap-1', props.className)}>
      <label htmlFor={id} className="text-xs font-medium text-soft">
        {props.label}
      </label>
      {props.children(id, error || props.hint ? messageId : undefined)}
      {error ? (
        <p id={messageId} className="text-xs text-bad">
          {error}
        </p>
      ) : props.hint ? (
        <p id={messageId} className="text-xs text-faint">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

const badgeStyles = cva('inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] leading-none', {
  variants: {
    tone: {
      neutral: 'bg-sunken text-soft',
      accent: 'bg-accent-soft text-accent',
      ok: 'bg-ok-bg text-ok',
      warn: 'bg-warn-bg text-warn',
      bad: 'bg-bad-bg text-bad',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge(props: { children: ReactNode; className?: string } & VariantProps<typeof badgeStyles>) {
  return <span className={cn(badgeStyles({ tone: props.tone }), props.className)}>{props.children}</span>;
}

export function Tags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Badge key={tag}>{tag}</Badge>
      ))}
    </span>
  );
}

export function PageHeader(props: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-6 pt-6 pb-4">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.subtitle ? <div className="text-[13px] text-soft">{props.subtitle}</div> : null}
      </div>
      {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
    </header>
  );
}

export function EmptyState(props: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-sm justify-items-center gap-2 py-16 text-center">
      <p className="font-medium">{props.title}</p>
      {props.body ? <p className="text-[13px] text-soft">{props.body}</p> : null}
      {props.action}
    </div>
  );
}

export function Alert(props: { tone?: 'bad' | 'warn' | 'ok'; children: ReactNode }) {
  const tone = props.tone ?? 'bad';
  return (
    <p
      role={tone === 'ok' ? 'status' : 'alert'}
      className={cn(
        'rounded-md px-3 py-2 text-[13px]',
        tone === 'bad' && 'bg-bad-bg text-bad',
        tone === 'warn' && 'bg-warn-bg text-warn',
        tone === 'ok' && 'bg-ok-bg text-ok',
      )}
    >
      {props.children}
    </p>
  );
}

/**
 * Modal built on the native <dialog>: focus trap, Escape and backdrop come from the browser, and it
 * needs no injected <style> tags (the renderer CSP allows only bundled styles).
 */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useTranslation();
  const { open, onClose } = props;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        'm-auto max-h-[85vh] w-[calc(100%-2rem)] rounded-xl border border-rule bg-raised p-0 text-ink shadow-2xl',
        props.wide ? 'max-w-4xl' : 'max-w-lg',
      )}
      aria-labelledby={titleId}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-rule px-5 py-3">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {props.title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close')}>
              <X size={16} aria-hidden />
            </Button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{props.children}</div>
          {props.footer ? (
            <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function DetailList(props: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2 text-[13px]">
      {props.items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-soft">{item.label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
