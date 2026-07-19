import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const headersFile = new URL('../public/_headers', import.meta.url);

describe('production security headers', () => {
  it('limits form submissions to the dashboard itself', async () => {
    const headers = await readFile(headersFile, 'utf8');

    expect(headers).toContain("form-action 'self'");
    expect(headers).not.toContain(
      "form-action 'self' https://api.inboxplease2.helloimabid.com",
    );
  });

  it('allows the Cloudflare Web Analytics script injected by Pages', async () => {
    const headers = await readFile(headersFile, 'utf8');

    expect(headers).toContain(
      "script-src 'self' https://static.cloudflareinsights.com",
    );
  });
});
