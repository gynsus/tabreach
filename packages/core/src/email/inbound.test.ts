import { describe, expect, it } from 'vitest';
import { parseInbound } from './inbound.js';

const crlf = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'));

const reply = crlf(`From: Bob Lee <Bob@Beta.test>
To: me@acme.test
Subject: Re: Hello Bob
Message-ID: <r-1@beta.test>
In-Reply-To: <abc@acme.test>
References: <first@acme.test> <abc@acme.test>
Date: Mon, 28 Sep 2026 12:00:00 +0000
Content-Type: text/plain; charset=utf-8

Sounds good, let's talk.

> Hello Bob
`);

const ooo = crlf(`From: bob@beta.test
To: me@acme.test
Subject: Automatic reply: Hello Bob
Auto-Submitted: auto-replied
Message-ID: <o-1@beta.test>
Content-Type: text/plain

I am away until Monday.
`);

const list = crlf(`From: news@beta.test
To: me@acme.test
Subject: Our newsletter
List-Id: <news.beta.test>
Message-ID: <n-1@beta.test>
Content-Type: text/plain

News.
`);

const dsn = crlf(`From: Mail Delivery Subsystem <MAILER-DAEMON@mx.acme.test>
To: me@acme.test
Subject: Undelivered Mail Returned to Sender
Message-ID: <d-1@mx.acme.test>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain

Your message could not be delivered.
--B
Content-Type: message/delivery-status

Reporting-MTA: dns; mx.acme.test

Final-Recipient: rfc822; nobody@beta.test
Action: failed
Status: 5.1.1

--B
Content-Type: text/rfc822-headers

From: me@acme.test
To: nobody@beta.test
Subject: Hello
Message-ID: <abc@acme.test>

--B--
`);

const gmailBounce = crlf(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: me@gmail.com
Subject: Delivery Status Notification (Delay)
X-Failed-Recipients: slow@beta.test
Content-Type: multipart/report; report-type=delivery-status; boundary="C"

--C
Content-Type: text/plain

Delivery is delayed.
--C
Content-Type: message/delivery-status

Final-Recipient: rfc822; slow@beta.test
Action: delayed
Status: 4.4.1

--C--
`);

describe('parseInbound', () => {
  it('reads a human reply with its thread references', async () => {
    const m = await parseInbound(reply);
    expect(m).toMatchObject({
      rfcMessageId: '<r-1@beta.test>',
      inReplyTo: '<abc@acme.test>',
      references: ['<abc@acme.test>', '<first@acme.test>'],
      from: 'bob@beta.test',
      fromName: 'Bob Lee',
      subject: 'Re: Hello Bob',
      automatic: false,
      outOfOffice: false,
      bounce: null,
    });
    expect(m.text).toContain("Sounds good, let's talk.");
  });

  it('recognises out-of-office and list mail as automatic', async () => {
    expect(await parseInbound(ooo)).toMatchObject({ automatic: true, outOfOffice: true });
    expect(await parseInbound(list)).toMatchObject({ automatic: true, outOfOffice: false });
  });

  it('reads a hard bounce: recipient, permanence, original Message-ID', async () => {
    expect((await parseInbound(dsn)).bounce).toEqual({
      recipients: ['nobody@beta.test'],
      permanent: true,
      originalMessageId: '<abc@acme.test>',
    });
  });

  it('a delay notice is not permanent', async () => {
    expect((await parseInbound(gmailBounce)).bounce).toMatchObject({
      recipients: ['slow@beta.test'],
      permanent: false,
    });
  });
});
