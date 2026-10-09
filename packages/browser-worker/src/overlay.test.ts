import { describe, expect, it } from 'vitest';
import { overlayContextFor } from './overlay.js';

const manual = {
  title: 'Send this message yourself',
  detail: null,
  lang: 'en' as const,
  content: 'Hello Ann.',
  contentOrigin: 'https://www.linkedin.com',
};

describe('overlay context per page (docs/12, ADR 015)', () => {
  it('shows the prepared text only on the site it is meant for', () => {
    expect(overlayContextFor(manual, 'https://www.linkedin.com/messaging/compose/?x=1')?.content).toBe(
      'Hello Ann.',
    );
    expect(overlayContextFor(manual, 'https://evil.test/?https://www.linkedin.com')?.content).toBeNull();
    expect(overlayContextFor(manual, 'http://www.linkedin.com/')?.content).toBeNull();
    expect(overlayContextFor(manual, 'about:blank')?.content).toBeNull();
    expect(
      overlayContextFor({ ...manual, contentOrigin: null }, 'https://www.linkedin.com/')?.content,
    ).toBeNull();
  });

  it('leaves a context without text as it is', () => {
    const label = { ...manual, content: null, contentOrigin: null };
    expect(overlayContextFor(label, 'https://example.test/')).toBe(label);
    expect(overlayContextFor(null, 'https://example.test/')).toBeNull();
  });
});
