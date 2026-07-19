import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  authenticatePasswordAccount,
  createPasswordAccount,
  getActiveAccountIdentity,
  type AccountIdentity,
} from '../auth-account-service';
import { signSessionToken } from '../auth-accounts';
import { signinSchema, signupSchema } from '../auth-account-schemas';
import { isDevelopment, isPasswordFallbackEnabled } from '../config';
import type { AppEnv } from '../env';
import { ApiError, jsonOk } from '../errors';
import { validationHook } from '../validation';

function accountData(token: string, identity: AccountIdentity) {
  return { token, ...identity };
}

export const authAccountRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    if (!isPasswordFallbackEnabled(c.env)) {
      throw new ApiError(
        404,
        'AUTH_METHOD_DISABLED',
        'Password authentication is not available; continue with Facebook',
      );
    }
    await next();
  })
  .post(
    '/signup',
    async (c, next) => {
      if (!isDevelopment(c.env)) {
        throw new ApiError(
          404,
          'AUTH_METHOD_DISABLED',
          'Seller signup is available through Facebook only',
        );
      }
      await next();
    },
    zValidator('json', signupSchema, validationHook),
    async (c) => {
      const identity = await createPasswordAccount(c.env, c.req.valid('json'));
      const token = await signSessionToken(c.env, {
        userId: identity.user.id,
        merchantId: identity.merchant.id,
        role: identity.role,
      });
      return jsonOk(c, accountData(token, identity), 201);
    },
  )
  .post('/signin', zValidator('json', signinSchema, validationHook), async (c) => {
    const input = c.req.valid('json');
    const identity = await authenticatePasswordAccount(
      c.env,
      input.email,
      input.password,
      c.req.raw,
    );
    const token = await signSessionToken(c.env, {
      userId: identity.user.id,
      merchantId: identity.merchant.id,
      role: identity.role,
    });
    return jsonOk(c, accountData(token, identity));
  });

export const accountRoutes = new Hono<AppEnv>().get('/me', async (c) => {
  const auth = c.get('auth');
  if (auth.source === 'development') {
    const merchant = await c.env.DB.prepare(
      'SELECT id, name, plan FROM merchants WHERE id = ?1 AND status = \'active\'',
    ).bind(auth.merchantId).first<{ id: string; name: string; plan: string }>();
    if (!merchant) throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable');
    return jsonOk(c, {
      user: { id: auth.subject, name: 'Local Developer', email: 'local@development.invalid' },
      merchant,
      role: auth.role,
    });
  }

  const identity = await getActiveAccountIdentity(c.env, auth.subject, auth.merchantId);
  if (!identity) throw new ApiError(401, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable');
  return jsonOk(c, identity);
});
