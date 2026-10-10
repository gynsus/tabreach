import Papa from 'papaparse';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

/** Campaign status CSV export for hand-off to a CRM (FR-PROS-007, docs/17 "Status export"). */
describe('campaign status export', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const parse = (csv: string) => {
    expect(csv.startsWith('﻿')).toBe(true);
    return Papa.parse<Record<string, string>>(csv.slice(1), { header: true, skipEmptyLines: true }).data;
  };

  it('one row per person: where they are, what was sent, whether they replied', async () => {
    const { campaign } = await h.campaignTo('bob@beta.test');
    h.approve();
    await h.run();
    expect(h.ledger()).toMatchObject([{ status: 'completed' }]);

    const acme = h.services.prospects.createCompany(
      { name: 'Acme', website: 'https://acme.test/' },
      ctx(),
    ).id;
    const ann = h.services.prospects.createContact(
      {
        firstName: 'Ann',
        lastName: 'Kim',
        email: 'ann@acme.test',
        jobTitle: 'CTO',
        companyId: acme,
        linkedinUrl: 'https://www.linkedin.com/in/ann-kim/',
      },
      ctx(),
    ).id;
    h.services.campaigns.enroll(campaign, [ann], ctx());
    const sentAt = (h.db.prepare(`SELECT updated_at FROM side_effects`).get() as { updated_at: string })
      .updated_at;

    const result = h.services.exports.exportCampaign(campaign, ctx());
    expect(result.filename).toBe('tabreach-campaign-email-2026-09-28.csv');
    expect(result.rows).toBe(2);
    const [bob, annRow] = parse(result.csv);
    expect(bob).toMatchObject({
      campaign: 'Email',
      campaign_version: '1',
      first_name: 'Bob',
      last_name: 'Lee',
      email: 'bob@beta.test',
      status: 'completed',
      stop_reason: '',
      steps_total: '1',
      messages_sent: '1',
      outcome_unknown: '0',
      last_sent_at: sentAt,
      last_sent_channel: 'email',
      last_reply_at: '',
      next_action_at: '',
    });
    expect(annRow).toMatchObject({
      first_name: 'Ann',
      job_title: 'CTO',
      linkedin_url: 'https://www.linkedin.com/in/ann-kim/',
      company_name: 'Acme',
      company_website: 'https://acme.test/',
      status: 'active',
      step: '1',
      messages_sent: '0',
      last_sent_at: '',
      enrolled_at: h.clock.now().toISOString(),
    });
    expect(annRow!.next_action_at).not.toBe('');

    expect(
      h.db.prepare(`SELECT payload_redacted FROM action_events WHERE action_type = 'export.created'`).get(),
    ).toEqual({ payload_redacted: JSON.stringify({ rows: 2, campaignId: campaign }) });
  });

  it('a campaign name that is not Latin keeps its letters in the file name; an unknown campaign is refused', () => {
    const id = h.services.campaigns.create({ name: 'Весна / 2026' }, ctx()).id;
    const result = h.services.exports.exportCampaign(id, ctx());
    expect(result).toMatchObject({ filename: 'tabreach-campaign-весна-2026-2026-09-28.csv', rows: 0 });
    expect(parse(result.csv)).toEqual([]);
    expect(result.csv.slice(1).split('\n')[0]).toContain('campaign,campaign_version,first_name');
    expect(() => h.services.exports.exportCampaign('00000000-0000-7000-8000-000000000000', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    );
  });
});
