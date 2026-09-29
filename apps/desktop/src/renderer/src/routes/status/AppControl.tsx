import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Alert, Button } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

/** App-wide control state, shared with the paused banner. */
export function useAppControl() {
  return useQuery({ queryKey: ['settings', 'control'], queryFn: () => call('app.control.get', {}) });
}

function useControlAction() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (action: 'app.pauseAll' | 'app.resumeAll' | 'app.emergencyStop') => call(action, {}),
    onSuccess: () => invalidateEntities(qc, ['settings', 'browser', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
}

/** Shown on every screen while outreach is paused (docs/19). */
export function PausedBanner() {
  const { t } = useTranslation();
  const control = useAppControl();
  const act = useControlAction();
  if (!control.data?.paused) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 bg-warn-bg px-6 py-2 text-[13px] text-warn"
      data-testid="paused-banner"
    >
      <span className="font-medium">
        {control.data.emergencyStoppedAt ? t('control.emergencyStopped') : t('control.pausedBanner')}
      </span>
      <Button size="sm" onClick={() => act.mutate('app.resumeAll')} disabled={act.isPending}>
        {t('control.resume')}
      </Button>
    </div>
  );
}

/** Pause all, emergency stop, keep awake (docs/11 "User experience", FR-BRA-008, FR-APP-004). */
export function AppControlSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const control = useAppControl();
  const act = useControlAction();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const keepAwake = useMutation({
    mutationFn: (value: boolean) => call('app.setKeepAwake', { keepAwake: value }),
    onSuccess: () => invalidateEntities(qc, ['settings']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  // Pause and Emergency stop stay available even if the state could not be read.
  const c = control.data;
  return (
    <section
      aria-labelledby="control-heading"
      className="grid gap-3 rounded-md border border-rule bg-raised p-4 text-[13px]"
    >
      <h2 id="control-heading" className="text-[15px] font-semibold">
        {t('control.title')}
      </h2>
      <p className="text-soft">{t('control.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {c?.paused ? (
          <Button variant="primary" onClick={() => act.mutate('app.resumeAll')} disabled={act.isPending}>
            {t('control.resume')}
          </Button>
        ) : (
          <Button onClick={() => act.mutate('app.pauseAll')} disabled={act.isPending}>
            {t('control.pauseAll')}
          </Button>
        )}
        {confirmStop ? (
          <span className="flex items-center gap-2">
            <Button
              variant="danger"
              onClick={() => {
                setConfirmStop(false);
                act.mutate('app.emergencyStop');
              }}
              autoFocus
            >
              {t('control.confirmEmergency')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </Button>
          </span>
        ) : (
          <Button variant="danger" onClick={() => setConfirmStop(true)} disabled={act.isPending}>
            {t('control.emergencyStop')}
          </Button>
        )}
      </div>
      <p className="text-xs text-soft">{t('control.emergencyHint')}</p>
      {control.isError ? <Alert>{errorMessage(t, control.error)}</Alert> : null}
      {c ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={c.keepAwake}
            disabled={keepAwake.isPending}
            onChange={(e) => keepAwake.mutate(e.target.checked)}
          />
          {t('control.keepAwake')}
        </label>
      ) : null}
    </section>
  );
}
