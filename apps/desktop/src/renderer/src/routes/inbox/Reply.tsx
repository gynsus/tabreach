import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_REPLY_BODY,
  MAX_REPLY_SUBJECT,
  uuidv7,
  type Conversation,
  type ManualReply,
} from '@tabreach/protocol';
import { Reply as ReplyIcon, Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Field, Input } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const textarea =
  'min-h-40 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';

/**
 * Writing a reply in the inbox (ADR 031). It goes to the sender of the latest reply, in its thread,
 * from the conversation's account; pressing Send is the approval. Nothing is saved before that.
 */
export function ReplyComposer({ conversation }: { conversation: Conversation }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const target = conversation.replyTarget;
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(target?.subject ?? '');
  const [body, setBody] = useState('');
  const [key, setKey] = useState(uuidv7);
  const send = useMutation({
    mutationFn: () =>
      call(
        'conversations.reply',
        { conversationId: conversation.id, messageId: target?.messageId ?? '', subject, body },
        { idempotencyKey: key },
      ),
    onSuccess: async () => {
      toast(t('inbox.reply.sending'));
      setOpen(false);
      setBody('');
      setKey(uuidv7());
      await invalidateEntities(qc, ['conversation', 'activity']);
    },
  });
  if (!target) return null;
  const busy = conversation.replies.some((r) => r.status === 'sending' || r.status === 'unknown');
  if (!open) {
    return (
      <div>
        <Button
          onClick={() => setOpen(true)}
          disabled={busy}
          title={busy ? t('inbox.reply.busy') : undefined}
        >
          <ReplyIcon size={14} aria-hidden />
          {t('inbox.reply.action')}
        </Button>
      </div>
    );
  }
  const ready = subject.trim().length > 0 && body.trim().length > 0;
  return (
    <form
      aria-label={t('inbox.reply.title')}
      className="grid gap-3 rounded-md border border-rule bg-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !send.isPending) send.mutate();
      }}
    >
      <p className="text-[13px]">
        <span className="text-soft">{t('inbox.reply.to')}: </span>
        <span className="font-medium">{target.address}</span>
        <span className="text-faint"> · {t('inbox.via', { address: conversation.accountAddress })}</span>
      </p>
      <Field label={t('campaigns.subject')}>
        {(id) => (
          <Input
            id={id}
            value={subject}
            maxLength={MAX_REPLY_SUBJECT}
            onChange={(e) => setSubject(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('inbox.reply.body')}>
        {(id) => (
          <textarea
            id={id}
            className={textarea}
            value={body}
            maxLength={MAX_REPLY_BODY}
            autoFocus
            onChange={(e) => setBody(e.target.value)}
          />
        )}
      </Field>
      <p className="text-xs text-faint">{t('inbox.reply.hint')}</p>
      {send.isError ? <Alert>{errorMessage(t, send.error)}</Alert> : null}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={!ready || send.isPending}>
          <Send size={14} aria-hidden />
          {send.isPending ? t('inbox.reply.sendingShort') : t('inbox.reply.send')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={send.isPending}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

const statusTone = { sending: 'accent', failed: 'bad', unknown: 'warn', sent: 'ok' } as const;

/** A reply written here that is not known as sent yet: on its way, failed, or uncertain. */
export function PendingReply({ reply }: { reply: ManualReply }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () => call('conversations.retryReply', { id: reply.id }),
    onSuccess: () => invalidateEntities(qc, ['conversation', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  return (
    <section
      data-testid="pending-reply"
      data-status={reply.status}
      className="grid gap-2 rounded-md border border-dashed border-rule bg-sunken p-4"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{t('inbox.you')}</span>
        <Badge tone={statusTone[reply.status]}>{t(`inbox.reply.statuses.${reply.status}`)}</Badge>
      </div>
      <p className="text-[13px] font-semibold">{reply.subject}</p>
      <p className="text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{reply.body}</p>
      {reply.status === 'failed' ? (
        <div className="grid gap-2">
          <p className="text-xs text-bad">
            {translateKey(
              t,
              `inbox.reply.errors.${(reply.errorClass ?? '').replace(/\./g, '_')}`,
              t('inbox.reply.errors.other'),
            )}
          </p>
          <div>
            <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {t('inbox.reply.retry')}
            </Button>
          </div>
        </div>
      ) : null}
      {reply.status === 'unknown' ? (
        <p className="text-xs text-warn">
          {t('inbox.reply.unknownHint')}{' '}
          <Link to="/status" className="underline">
            {t('attention.title')}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
