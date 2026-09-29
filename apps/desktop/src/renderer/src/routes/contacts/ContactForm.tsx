import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Contact } from '@tabreach/protocol';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CompanyPicker, type PickedCompany } from '../../components/CompanyPicker';
import { Alert, Button, Field, Input, Modal, useDiscardGuard } from '../../components/ui';
import { call, fieldErrors, formAlert } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const splitTags = (value: string) =>
  value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/** Create or edit a contact. `company` pre-selects a company when adding from a company page. */
export function ContactForm(props: {
  open: boolean;
  onClose: () => void;
  contact?: Contact;
  company?: PickedCompany;
  onSaved?: (contact: Contact) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const c = props.contact;
  const [form, setForm] = useState({
    firstName: c?.firstName ?? '',
    lastName: c?.lastName ?? '',
    fullName: c?.fullName ?? '',
    email: c?.email ?? '',
    jobTitle: c?.jobTitle ?? '',
    linkedinUrl: c?.linkedinUrl ?? '',
    tags: c?.tags.join(', ') ?? '',
  });
  const [company, setCompany] = useState<PickedCompany | null>(
    c?.companyId ? { id: c.companyId, name: c.companyName ?? '' } : (props.company ?? null),
  );
  // Closing with unsaved edits asks first (audit 4.5).
  const [initial] = useState(() => JSON.stringify({ form, company: company?.id ?? null }));
  const dirty = JSON.stringify({ form, company: company?.id ?? null }) !== initial;
  const { requestClose, confirmBar } = useDiscardGuard(dirty, props.onClose);

  // One key per opened form: retrying after a timeout cannot create a second contact (ADR 020).
  const [idempotencyKey] = useState(() => uuidv7());
  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, tags: splitTags(form.tags), companyId: company?.id ?? null };
      return c
        ? call('contacts.update', { id: c.id, ...payload })
        : call('contacts.create', payload, { idempotencyKey });
    },
    onSuccess: async (saved) => {
      await invalidateEntities(qc, ['contact', 'company', 'activity']);
      props.onSaved?.(saved);
      props.onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const alert = formAlert(t, save.error, [
    'firstName',
    'lastName',
    'fullName',
    'email',
    'jobTitle',
    'linkedinUrl',
    'companyId',
  ]);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const text = (key: keyof typeof form, label: string, type = 'text') => (
    <Field label={label} errorKey={errors[key]}>
      {(id, describedBy) => (
        <Input
          id={id}
          type={type}
          value={form[key]}
          onChange={set(key)}
          aria-invalid={errors[key] ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
    </Field>
  );

  return (
    <Modal
      open={props.open}
      onClose={requestClose}
      title={c ? t('contacts.edit') : t('contacts.new')}
      footer={
        <>
          {confirmBar}
          <Button onClick={requestClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="contact-form" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit} className="grid gap-3">
        {alert ? <Alert>{alert}</Alert> : null}
        <div className="grid grid-cols-2 gap-3">
          {text('firstName', t('contacts.firstName'))}
          {text('lastName', t('contacts.lastName'))}
        </div>
        {text('fullName', t('contacts.fullName'))}
        {text('email', t('contacts.email'), 'email')}
        {text('jobTitle', t('contacts.jobTitle'))}
        {text('linkedinUrl', t('contacts.linkedin'))}
        <Field label={t('contacts.company')} errorKey={errors.companyId}>
          {(id, describedBy) => (
            <CompanyPicker id={id} value={company} onChange={setCompany} describedBy={describedBy} />
          )}
        </Field>
        <Field label={t('contacts.tags')} hint={t('common.tagsHint')}>
          {(id, describedBy) => (
            <Input id={id} value={form.tags} onChange={set('tags')} aria-describedby={describedBy} />
          )}
        </Field>
      </form>
    </Modal>
  );
}
