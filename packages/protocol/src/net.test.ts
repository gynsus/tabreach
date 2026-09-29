import { describe, expect, it } from 'vitest';
import { isPublicAddress, sameSite } from './net.js';

describe('public addresses (audit 5.5)', () => {
  it('refuses every way of writing a local address', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // how the URL parser writes ::ffff:127.0.0.1
      '::ffff:c0a8:101', // 192.168.1.1
      '0:0:0:0:0:ffff:7f00:1',
      '::7f00:1', // IPv4-compatible
      '::127.0.0.1',
      '64:ff9b::7f00:1', // NAT64
      '2002:c0a8:101::1', // 6to4 around 192.168.1.1
      'fc00::1',
      'fd12:3456::1',
      'fe80::1%en0',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      'not-an-address',
      '1:2:3',
      '1::2::3',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('accepts public IPv4 and IPv6, including 6to4 and mapped forms of public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:5db8:d822', '2002:5db8:d822::1'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('same site means the host or its subdomain', () => {
    expect(sameSite('www.acme.com', 'acme.com')).toBe(true);
    expect(sameSite('jobs.acme.com', 'www.acme.com')).toBe(true);
    expect(sameSite('acme.com.evil.test', 'acme.com')).toBe(false);
    expect(sameSite('notacme.com', 'acme.com')).toBe(false);
  });
});
