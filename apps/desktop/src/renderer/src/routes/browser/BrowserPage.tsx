import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrowserProfile, ProfileStatus } from '@tabreach/protocol';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
} from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const tone: Record<ProfileStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'> = {
  ready: 'neutral',
  open: 'accent',
  needs_login: 'warn',
  unhealthy: 'bad',
  archived: 'neutral',
};

/** Browser profiles (docs/08): separate Chrome identities the user signs in to by hand. */
export function BrowserPage() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const profiles = useQuery({
    queryKey: ['profiles', 'list'],
    queryFn: () => call('profiles.list', { includeArchived: false }),
  });
  const items = profiles.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={t('browser.title')}
        subtitle={t('browser.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden />
            {t('browser.new')}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {profiles.isPending ? <Loading /> : null}
        {profiles.isError ? <Alert>{errorMessage(t, profiles.error)}</Alert> : null}
        {profiles.isSuccess && items.length === 0 ? (
          <EmptyState title={t('browser.emptyTitle')} body={t('browser.emptyBody')} />
        ) : null}
        {items.length ? (
          <ul aria-label={t('browser.title')} className="grid max-w-4xl gap-3">
            {items.map((p) => (
              <ProfileRow key={p.id} profile={p} />
            ))}
          </ul>
        ) : null}
        <p className="mt-6 max-w-3xl text-xs text-soft">{t('browser.privacy')}</p>
      </div>
      {creating ? <CreateProfile onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function ProfileRow({ profile: p }: { profile: BrowserProfile }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const act = useMutation({
    mutationFn: (action: 'profiles.open' | 'profiles.close' | 'profiles.focus' | 'profiles.check') =>
      action === 'profiles.open' ? call(action, { id: p.id, startUrl: null }) : call(action, { id: p.id }),
    onSuccess: () => invalidateEntities(qc, ['browser', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const open = p.session !== null;
  const opening = p.session?.status === 'opening' || (act.isPending && act.variables === 'profiles.open');
  return (
    <li className="grid gap-2 rounded-md border border-rule bg-raised p-4 text-[13px]" data-testid="profile">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <Badge tone="neutral">{t(`browser.purposes.${p.purpose}`)}</Badge>
        <Badge tone={tone[p.status]}>{t(`browser.statuses.${p.status}`)}</Badge>
        {p.session ? <Badge tone="warn">{t(`browser.controlModes.${p.session.controlMode}`)}</Badge> : null}
        <span className="ml-auto font-mono text-[11px] text-faint">
          {p.lastOpenedAt
            ? t('browser.lastOpened', { when: formatDateTime(p.lastOpenedAt, i18n.language) })
            : t('browser.neverOpened')}
        </span>
      </div>
      {p.session?.currentUrl ? (
        <p className="truncate font-mono text-[11px] text-soft">{p.session.currentUrl}</p>
      ) : null}
      {p.health && p.health.status !== 'healthy' && p.health.detail ? (
        <p className={p.health.status === 'unhealthy' ? 'text-bad' : 'text-warn'}>
          {translateKey(t, `browser.health.${p.health.detail.replace('.', '_')}`, p.health.detail)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {open ? (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => act.mutate('profiles.focus')}
              disabled={act.isPending}
            >
              {t('browser.showWindow')}
            </Button>
            <Button size="sm" onClick={() => act.mutate('profiles.close')} disabled={act.isPending}>
              {t('browser.close')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => act.mutate('profiles.open')}
            disabled={act.isPending}
          >
            {opening ? t('browser.opening') : t('browser.open')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => act.mutate('profiles.check')}
          disabled={act.isPending}
        >
          {t('browser.check')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
          {t('browser.rename')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDeleting(true)} disabled={open}>
          {t('browser.delete')}
        </Button>
      </div>
      {renaming ? <RenameProfile profile={p} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteProfile profile={p} onClose={() => setDeleting(false)} /> : null}
    </li>
  );
}

function CreateProfile({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<'general' | 'research'>('general');
  const create = useMutation({
    mutationFn: () => call('profiles.create', { name, purpose }),
    onSuccess: async () => {
      await invalidateEntities(qc, ['browser', 'activity']);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('browser.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            type="submit"
            form="create-profile"
            disabled={!name.trim() || create.isPending}
          >
            {t('browser.create')}
          </Button>
        </>
      }
    >
      <form id="create-profile" onSubmit={submit} className="grid gap-3">
        {create.isError ? <Alert>{errorMessage(t, create.error)}</Alert> : null}
        <Field label={t('browser.name')} errorKey={fieldErrors(create.error).name}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label={t('browser.purpose')} hint={t(`browser.purposeHints.${purpose}`)}>
          {(id, describedBy) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value === 'research' ? 'research' : 'general')}
            >
              <option value="general">{t('browser.purposes.general')}</option>
              <option value="research">{t('browser.purposes.research')}</option>
            </Select>
          )}
        </Field>
      </form>
    </Modal>
  );
}

function RenameProfile({ profile, onClose }: { profile: BrowserProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(profile.name);
  const save = useMutation({
    mutationFn: () => call('profiles.update', { id: profile.id, name }),
    onSuccess: async () => {
      await invalidateEntities(qc, ['browser', 'activity']);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('browser.rename')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-profile"
            disabled={!name.trim() || save.isPending}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="rename-profile"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-3"
      >
        {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
        <Field label={t('browser.name')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
      </form>
    </Modal>
  );
}

/** Deleting destroys the signed-in browser state: the user types the name to confirm (docs/08). */
function DeleteProfile({ profile, onClose }: { profile: BrowserProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmName, setConfirmName] = useState('');
  const remove = useMutation({
    mutationFn: () => call('profiles.delete', { id: profile.id, confirmName }),
    onSuccess: async () => {
      toast(t('browser.deleted'));
      await invalidateEntities(qc, ['browser', 'activity']);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('browser.deleteTitle', { name: profile.name })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            type="submit"
            form="delete-profile"
            disabled={confirmName.trim() !== profile.name || remove.isPending}
          >
            {t('browser.delete')}
          </Button>
        </>
      }
    >
      <form
        id="delete-profile"
        onSubmit={(e) => {
          e.preventDefault();
          remove.mutate();
        }}
        className="grid gap-3 text-[13px]"
      >
        <p>{t('browser.deleteWarning')}</p>
        {remove.isError ? <Alert>{errorMessage(t, remove.error)}</Alert> : null}
        <Field
          label={t('browser.typeName', { name: profile.name })}
          errorKey={fieldErrors(remove.error).confirmName}
        >
          {(id) => (
            <Input
              id={id}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
