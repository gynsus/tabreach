import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_EMAIL_LIMITS,
  type ConnectionCheck,
  type EmailAccount,
  type ImapAccountInput,
  type MailSecurity,
  type MailServer,
} from '@tabreach/protocol';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Field, Input, Modal, Select } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage, fieldErrors, formAlert } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

/** Server settings for well-known providers; anything else starts from smtp./imap.<domain>. */
const PRESETS: { domains: RegExp; smtp: MailServer; imap: MailServer }[] = [
  {
    domains: /^(gmail\.com|googlemail\.com)$/,
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
  },
  {
    domains: /^(outlook\.com|hotmail\.com|live\.com)$/,
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
  },
  {
    domains: /^(icloud\.com|me\.com|mac\.com)$/,
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
  },
  {
    domains: /^(yandex\.(ru|com)|ya\.ru)$/,
    smtp: { host: 'smtp.yandex.ru', port: 465, security: 'tls' },
    imap: { host: 'imap.yandex.ru', port: 993, security: 'tls' },
  },
  {
    domains: /^(mail\.ru|bk\.ru|list\.ru|inbox\.ru|internet\.ru)$/,
    smtp: { host: 'smtp.mail.ru', port: 465, security: 'tls' },
    imap: { host: 'imap.mail.ru', port: 993, security: 'tls' },
  },
];

function serversFor(address: string): { smtp: MailServer; imap: MailServer } {
  const domain = address.split('@')[1]?.trim().toLowerCase() ?? '';
  const preset = PRESETS.find((p) => p.domains.test(domain));
  if (preset) return { smtp: preset.smtp, imap: preset.imap };
  return {
    smtp: { host: domain ? `smtp.${domain}` : '', port: 587, security: 'starttls' },
    imap: { host: domain ? `imap.${domain}` : '', port: 993, security: 'tls' },
  };
}

export function EmailAccounts() {
  const { t } = useTranslation();
  const [connecting, setConnecting] = useState(false);
  const [gmail, setGmail] = useState(false);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => call('accounts.list', {}) });
  const items = accounts.data?.items ?? [];
  return (
    <section aria-labelledby="accounts-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="accounts-heading" className="text-[15px] font-semibold">
            {t('accounts.title')}
          </h2>
          <p className="text-[13px] text-soft">{t('accounts.subtitle')}</p>
        </div>
        <span className="flex gap-2">
          <Button onClick={() => setGmail(true)}>
            <Plus size={14} aria-hidden />
            {t('accounts.connectGmail')}
          </Button>
          <Button onClick={() => setConnecting(true)}>
            <Plus size={14} aria-hidden />
            {t('accounts.connect')}
          </Button>
        </span>
      </div>
      {accounts.isError ? <Alert>{errorMessage(t, accounts.error)}</Alert> : null}
      {accounts.isSuccess && items.length === 0 ? (
        <p className="text-[13px] text-soft">{t('accounts.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul
          aria-label={t('accounts.title')}
          className="divide-y divide-rule rounded-md border border-rule bg-raised"
        >
          {items.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </ul>
      ) : null}
      {connecting ? <ConnectAccount onClose={() => setConnecting(false)} /> : null}
      {gmail ? <ConnectGmail onClose={() => setGmail(false)} /> : null}
    </section>
  );
}

function describeCheck(
  t: ReturnType<typeof useTranslation>['t'],
  check: ConnectionCheck,
): { ok: boolean; text: string } {
  if (check.smtp.ok && check.imap.ok) {
    return check.imap.sentFolder
      ? { ok: true, text: t('accounts.testOk', { folder: check.imap.sentFolder }) }
      : { ok: true, text: t('accounts.testNoSent') };
  }
  const part = (r: { ok: boolean; error?: string | undefined }) =>
    r.ok
      ? t('accounts.ok')
      : translateKey(
          t,
          `errors.account.${r.error ?? 'connectionFailed'}`,
          t('errors.account.connectionFailed'),
        );
  return { ok: false, text: t('accounts.testFailed', { smtp: part(check.smtp), imap: part(check.imap) }) };
}

function AccountRow({ account: a }: { account: EmailAccount }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [password, setPassword] = useState('');
  const refresh = () => invalidateEntities(qc, ['account', 'activity']);
  const test = useMutation({ mutationFn: () => call('accounts.test', { id: a.id }) });
  const savePassword = useMutation({
    mutationFn: () => call('accounts.update', { id: a.id, password }),
    onSuccess: async () => {
      setPassword('');
      await refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => call('accounts.disconnect', { id: a.id }),
    onSuccess: refresh,
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirm(false),
  });
  const check = test.data ? describeCheck(t, test.data) : null;
  return (
    <li className="grid gap-3 px-4 py-3 text-[13px]" data-testid="email-account">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid gap-0.5">
          <span className="font-medium">{a.fromName ? `${a.fromName} <${a.address}>` : a.address}</span>
          <span className="text-xs text-faint">
            {a.smtp ? `${a.smtp.host}:${a.smtp.port}` : 'Gmail API'} ·{' '}
            {t('accounts.perDay', { count: a.limits.dailyLimit })} ·{' '}
            {a.appendToSent ? t('accounts.appendToSent') : t('accounts.serverSaves')}
          </span>
        </span>
        <Badge tone={a.status === 'active' ? 'ok' : 'warn'}>{t(`accounts.statuses.${a.status}`)}</Badge>
        <span className="ml-auto flex gap-1">
          <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? t('accounts.connecting') : t('accounts.test')}
          </Button>
          {confirm ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {t('accounts.confirmDisconnect')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              {t('accounts.disconnect')}
            </Button>
          )}
        </span>
      </div>
      {check ? <Alert tone={check.ok ? 'ok' : 'bad'}>{check.text}</Alert> : null}
      {test.isError ? <Alert>{errorMessage(t, test.error)}</Alert> : null}
      {a.status === 'auth_required' && a.provider === 'gmail_api' ? (
        <>
          <Button size="sm" variant="primary" className="justify-self-start" onClick={() => setReauth(true)}>
            {t('accounts.gmail.signIn')}
          </Button>
          {reauth ? <ConnectGmail onClose={() => setReauth(false)} /> : null}
        </>
      ) : null}
      {a.status === 'auth_required' && a.provider === 'imap_smtp' ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) savePassword.mutate();
          }}
        >
          <Field
            label={t('accounts.newPassword')}
            errorKey={fieldErrors(savePassword.error).password}
            className="w-64"
          >
            {(id, describedBy) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={!password || savePassword.isPending}>
            {savePassword.isPending ? t('accounts.connecting') : t('accounts.savePassword')}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function ServerFields(props: {
  legend: string;
  prefix: 'smtp' | 'imap';
  value: MailServer;
  onChange: (value: MailServer) => void;
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { value, onChange } = props;
  return (
    <fieldset className="grid grid-cols-[1fr_96px_128px] gap-2">
      <legend className="mb-1 text-xs font-semibold text-soft">{props.legend}</legend>
      <Field label={t('accounts.host')} errorKey={props.errors[`${props.prefix}.host`]}>
        {(id, describedBy) => (
          <Input
            id={id}
            value={value.host}
            disabled={props.disabled}
            aria-describedby={describedBy}
            onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
          />
        )}
      </Field>
      <Field label={t('accounts.port')}>
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={65535}
            value={value.port}
            disabled={props.disabled}
            onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
          />
        )}
      </Field>
      <Field label={t('accounts.security')}>
        {(id) => (
          <Select
            id={id}
            value={value.security}
            disabled={props.disabled}
            onChange={(e) => onChange({ ...value, security: e.target.value as MailSecurity })}
          >
            <option value="tls">{t('accounts.securities.tls')}</option>
            <option value="starttls">{t('accounts.securities.starttls')}</option>
          </Select>
        )}
      </Field>
    </fieldset>
  );
}

function ConnectAccount(props: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [servers, setServers] = useState(serversFor(''));
  const [touchedServers, setTouchedServers] = useState(false);
  const [limits, setLimits] = useState(DEFAULT_EMAIL_LIMITS);
  const connect = useMutation({
    mutationFn: (input: ImapAccountInput) => call('accounts.connectImap', input),
    onSuccess: async () => {
      toast(t('accounts.connected'));
      await invalidateEntities(qc, ['account', 'activity']);
      props.onClose();
    },
  });
  const errors = fieldErrors(connect.error);
  const busy = connect.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate({
      address,
      fromName: fromName || null,
      username: username ?? address,
      password,
      smtp: servers.smtp,
      imap: servers.imap,
      appendToSent: null,
      limits,
    });
  };
  const alert = formAlert(t, connect.error, ['address', 'password', 'smtp.host', 'imap.host']);
  return (
    <Modal
      open
      wide
      onClose={props.onClose}
      title={t('accounts.connectTitle')}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="connect-account"
            disabled={busy || !address || !password}
          >
            {busy ? t('accounts.connecting') : t('accounts.connect')}
          </Button>
        </>
      }
    >
      <form id="connect-account" onSubmit={submit} className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('accounts.address')} errorKey={errors.address}>
            {(id, describedBy) => (
              <Input
                id={id}
                type="email"
                autoFocus
                value={address}
                disabled={busy}
                aria-describedby={describedBy}
                aria-invalid={errors.address ? true : undefined}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (!touchedServers) setServers(serversFor(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={t('accounts.fromName')} hint={t('accounts.fromNameHint')}>
            {(id, describedBy) => (
              <Input
                id={id}
                value={fromName}
                disabled={busy}
                aria-describedby={describedBy}
                onChange={(e) => setFromName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('accounts.username')}>
            {(id) => (
              <Input
                id={id}
                value={username ?? address}
                disabled={busy}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('accounts.password')} hint={t('accounts.passwordHint')} errorKey={errors.password}>
            {(id, describedBy) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                value={password}
                disabled={busy}
                aria-describedby={describedBy}
                aria-invalid={errors.password ? true : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        </div>
        <ServerFields
          legend={t('accounts.smtp')}
          prefix="smtp"
          value={servers.smtp}
          errors={errors}
          disabled={busy}
          onChange={(smtp) => {
            setTouchedServers(true);
            setServers({ ...servers, smtp });
          }}
        />
        <ServerFields
          legend={t('accounts.imap')}
          prefix="imap"
          value={servers.imap}
          errors={errors}
          disabled={busy}
          onChange={(imap) => {
            setTouchedServers(true);
            setServers({ ...servers, imap });
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('accounts.dailyLimit')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={2000}
                value={limits.dailyLimit}
                disabled={busy}
                onChange={(e) =>
                  setLimits({
                    ...limits,
                    dailyLimit: Math.max(1, Math.min(2000, Number(e.target.value) || 1)),
                  })
                }
              />
            )}
          </Field>
          <Field label={t('accounts.spacing')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={86400}
                value={limits.minSpacingSeconds}
                disabled={busy}
                onChange={(e) =>
                  setLimits({
                    ...limits,
                    minSpacingSeconds: Math.max(0, Math.min(86400, Number(e.target.value) || 0)),
                  })
                }
              />
            )}
          </Field>
        </div>
        {alert ? <Alert>{alert}</Alert> : null}
      </form>
    </Modal>
  );
}

const GMAIL_STEPS = ['project', 'api', 'consent', 'production', 'client', 'paste'] as const;

/** Wizard for a Gmail account through the user's own OAuth client (ADR 016, options A and B). */
export function ConnectGmail(props: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const connect = useMutation({
    mutationFn: () =>
      call('accounts.connectGmail', { clientId: clientId.trim(), clientSecret: clientSecret.trim() || null }),
    onSuccess: async () => {
      toast(t('accounts.gmail.connected'));
      await invalidateEntities(qc, ['account', 'activity']);
      props.onClose();
    },
  });
  const errors = fieldErrors(connect.error);
  const busy = connect.isPending;
  const alert = formAlert(t, connect.error, ['clientId', 'clientSecret']);
  return (
    <Modal
      open
      wide
      onClose={props.onClose}
      title={t('accounts.gmail.title')}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="connect-gmail" disabled={busy || !clientId.trim()}>
            {busy ? t('accounts.gmail.waiting') : t('accounts.gmail.signIn')}
          </Button>
        </>
      }
    >
      <form
        id="connect-gmail"
        className="grid gap-4 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
      >
        <p className="text-soft">{t('accounts.gmail.intro')}</p>
        <ol className="grid list-decimal gap-1.5 pl-5">
          {GMAIL_STEPS.map((step) => (
            <li key={step}>{t(`accounts.gmail.steps.${step}`)}</li>
          ))}
        </ol>
        <p className="rounded-md bg-sunken px-3 py-2 text-soft">{t('accounts.gmail.scopes')}</p>
        <p className="rounded-md bg-warn-bg px-3 py-2 text-warn">{t('accounts.gmail.unverified')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('accounts.gmail.clientId')} errorKey={errors.clientId}>
            {(id, describedBy) => (
              <Input
                id={id}
                value={clientId}
                disabled={busy}
                placeholder="…apps.googleusercontent.com"
                aria-describedby={describedBy}
                aria-invalid={errors.clientId ? true : undefined}
                onChange={(e) => setClientId(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('accounts.gmail.clientSecret')} errorKey={errors.clientSecret}>
            {(id, describedBy) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                value={clientSecret}
                disabled={busy}
                aria-describedby={describedBy}
                aria-invalid={errors.clientSecret ? true : undefined}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            )}
          </Field>
        </div>
        {alert ? <Alert>{alert}</Alert> : null}
      </form>
    </Modal>
  );
}
