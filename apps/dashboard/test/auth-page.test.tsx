import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import AuthPage from '../src/marketing/AuthPage';

describe.each([
  ['signup' as const, 'Start with Facebook'],
  ['signin' as const, 'Continue with Facebook'],
])('%s page', (mode, heading) => {
  it('offers Facebook OAuth without collecting credentials', () => {
    const markup = renderToStaticMarkup(createElement(AuthPage, { mode }));

    expect(markup).toContain(heading);
    expect(markup).toContain('auth-facebook-button');
    expect(markup).toContain('Continue with Facebook');
    expect(markup).not.toMatch(/type="(?:email|password)"/u);
    expect(markup).not.toMatch(/name="(?:email|password)"/u);
  });
});
