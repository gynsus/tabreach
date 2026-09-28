import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Company } from '@tabreach/protocol';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Field, Input, Modal } from '../../components/ui';
import { call, fieldErrors, formAlert } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const splitTags = (value: string) =>
  value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export function CompanyForm(props: {
  open: boolean;
  onClose: () => void;
  company?: Company;
  onSaved?: (company: Company) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const c = props.company;
  const [form, setForm] = useState({
    name: c?.name ?? '',
    website: c?.websiteUrl ?? '',
    country: c?.country ?? '',
    city: c?.city ?? '',
    tags: c?.tags.join(', ') ?? '',
  });
  const [nameMissing, setNameMissing] = useState(false);

  const [idempotencyKey] = useState(() => uuidv7());
  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, tags: splitTags(form.tags) };
      return c
        ? call('companies.update', { id: c.id, ...payload })
        : call('companies.create', payload, { idempotencyKey });
    },
    onSuccess: async (saved) => {
      await invalidateEntities(qc, ['company', 'activity']);
      props.onSaved?.(saved);
      props.onClose();
    },
  });
  const errors: Record<string, string> = {
    ...fieldErrors(save.error),
    ...(nameMissing ? { name: 'name.required' } : {}),
  };
  const alert = formAlert(t, save.error, ['name', 'website', 'country', 'city', 'tags']);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    save.mutate();
  };

  const text = (key: keyof typeof form, label: string, hint?: string) => (
    <Field label={label} errorKey={errors[key]} {...(hint ? { hint } : {})}>
      {(id, describedBy) => (
        <Input
          id={id}
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
      onClose={props.onClose}
      title={c ? t('companies.edit') : t('companies.new')}
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" form="company-form" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id="company-form" onSubmit={submit} className="grid gap-3">
        {alert ? <Alert>{alert}</Alert> : null}
        {text('name', t('companies.name'))}
        {text('website', t('companies.website'))}
        <div className="grid grid-cols-2 gap-3">
          {text('country', t('companies.country'))}
          {text('city', t('companies.city'))}
        </div>
        {text('tags', t('companies.tags'), t('common.tagsHint'))}
      </form>
    </Modal>
  );
}
