import { describe, expect, it } from 'vitest';
import { detectClientPlatform } from '@/server/http/client-platform';

const detect = (ua: string, hints: Record<string, string> = {}) => {
  const { os, device } = detectClientPlatform(new Headers({ 'user-agent': ua, ...hints }));
  return { os, device };
};

describe('detectClientPlatform', () => {
  it('reads the OS and device class from the User-Agent', () => {
    expect(detect('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toEqual({ os: 'Windows', device: 'desktop' });
    expect(detect('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toEqual({ os: 'macOS', device: 'desktop' });
    expect(detect('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toEqual({ os: 'Linux', device: 'desktop' });
    expect(detect('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toEqual({ os: 'ChromeOS', device: 'desktop' });
    expect(detect('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toEqual({ os: 'iOS', device: 'mobile' });
    expect(detect('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toEqual({ os: 'iPadOS', device: 'tablet' });
    expect(detect('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toEqual({ os: 'Android', device: 'mobile' });
    expect(detect('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toEqual({ os: 'Android', device: 'tablet' });
    expect(detect('curl/8.0')).toEqual({ os: 'Other', device: 'desktop' });
  });

  it('prefers client hints over the frozen User-Agent', () => {
    const reduced = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    expect(detect(reduced, { 'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-mobile': '?0' })).toEqual({ os: 'Windows', device: 'desktop' });
    expect(detect(reduced, { 'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-mobile': '?1' })).toEqual({ os: 'Android', device: 'mobile' });
  });

  it('copes with a missing User-Agent', () => {
    expect(detectClientPlatform(new Headers())).toEqual({ os: 'Other', device: 'desktop', userAgent: null });
  });
});
