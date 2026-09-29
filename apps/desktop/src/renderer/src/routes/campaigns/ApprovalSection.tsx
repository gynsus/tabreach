import type { CampaignConfig } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { Field, Input, Select } from '../../components/ui';

const textarea =
  'min-h-20 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** How messages get approved, and what every draft is checked for (docs/17, ADR 025). */
export function ApprovalSection(props: {
  config: CampaignConfig;
  disabled: boolean;
  onChange: (config: CampaignConfig) => void;
}) {
  const { t } = useTranslation();
  const { config, disabled, onChange } = props;
  return (
    <section aria-labelledby="approval-heading" className="grid gap-3">
      <h2 id="approval-heading" className="text-[15px] font-semibold">
        {t('campaigns.approval')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('campaigns.approvalMode')} className="w-80">
          {(id) => (
            <Select
              id={id}
              value={config.approvalMode}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...config,
                  approvalMode: e.target.value === 'approve_campaign' ? 'approve_campaign' : 'approve_each',
                })
              }
            >
              <option value="approve_each">{t('campaigns.approvalModes.approve_each')}</option>
              <option value="approve_campaign">{t('campaigns.approvalModes.approve_campaign')}</option>
            </Select>
          )}
        </Field>
        {config.approvalMode === 'approve_campaign' ? (
          <Field label={t('campaigns.sampleSize')} className="w-40">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={50}
                value={config.sampleSize}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ ...config, sampleSize: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })
                }
              />
            )}
          </Field>
        ) : null}
      </div>
      <p className="max-w-2xl text-xs text-soft">
        {t(`campaigns.approvalModeHints.${config.approvalMode}`, { n: config.sampleSize })}
      </p>
      <h3 className="mt-2 text-[13px] font-semibold">{t('campaigns.checks')}</h3>
      <p className="max-w-2xl text-xs text-soft">{t('campaigns.checksHint')}</p>
      <Field label={t('campaigns.maxLength')} className="w-48">
        {(id) => (
          <Input
            id={id}
            type="number"
            min={100}
            max={10_000}
            step={50}
            value={config.maxLength}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...config,
                maxLength: Math.max(100, Math.min(10_000, Number(e.target.value) || 100)),
              })
            }
          />
        )}
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('campaigns.forbiddenPhrases')} hint={t('campaigns.onePerLine')}>
          {(id, describedBy) => (
            <textarea
              id={id}
              className={textarea}
              aria-describedby={describedBy}
              disabled={disabled}
              defaultValue={config.forbiddenPhrases.join('\n')}
              onBlur={(e) => onChange({ ...config, forbiddenPhrases: lines(e.target.value).slice(0, 100) })}
            />
          )}
        </Field>
        <Field label={t('campaigns.allowedLinkDomains')} hint={t('campaigns.allowedLinkDomainsHint')}>
          {(id, describedBy) => (
            <textarea
              id={id}
              className={textarea}
              placeholder="example.com"
              aria-describedby={describedBy}
              disabled={disabled}
              defaultValue={config.allowedLinkDomains.join('\n')}
              onBlur={(e) => onChange({ ...config, allowedLinkDomains: lines(e.target.value).slice(0, 50) })}
            />
          )}
        </Field>
      </div>
    </section>
  );
}
