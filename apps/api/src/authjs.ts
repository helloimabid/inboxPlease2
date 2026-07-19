import type { AuthConfig, AuthUser } from '@hono/auth-js';
import { authHandler, getAuthUser, initAuthConfig } from '@hono/auth-js';
import Credentials from '@auth/core/providers/credentials';
import Facebook from '@auth/core/providers/facebook';
import type { User } from '@auth/core/types';
import { D1Adapter } from '@auth/d1-adapter';
import { Hono, type Context } from 'hono';
import {
  authenticatePasswordAccount,
  ensureFacebookSellerIdentity,
} from './auth-account-service';
import { signinSchema } from './auth-account-schemas';
import { isPasswordFallbackEnabled } from './config';
import type { AppEnv, AuthContext } from './env';
import { ApiError } from './errors';
import { optionalFacebookLoginCredentials } from './integrations/facebook-config';

export const AUTHJS_BASE_PATH = '/authjs';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

interface MerchantAuthUser extends User {
  merchantId: string;
  role: AuthContext['role'];
}

function validRole(value: unknown): value is AuthContext['role'] {
  return value === 'owner' || value === 'admin' || value === 'staff' || value === 'service';
}

function validFacebookAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}

function metaGraphVersion(value: string | undefined): string {
  return /^v\d+\.\d+$/.test(value ?? '') ? value as string : 'v21.0';
}

export function safeAuthRedirect(
  url: string,
  baseUrl: string,
  dashboardOrigins: string | undefined,
): string {
  const allowedOrigins = new Set<string>();
  try {
    allowedOrigins.add(new URL(baseUrl).origin);
  } catch {
    return baseUrl;
  }
  for (const value of (dashboardOrigins ?? '').split(',').map((entry) => entry.trim())) {
    if (!value) continue;
    try {
      const origin = new URL(value);
      if (origin.origin === value && (origin.protocol === 'https:' || origin.protocol === 'http:')) {
        allowedOrigins.add(origin.origin);
      }
    } catch {
      // Ignore a malformed optional origin. Production validation rejects it.
    }
  }

  try {
    const target = url.startsWith('/') && !url.startsWith('//')
      ? new URL(url, baseUrl)
      : new URL(url);
    if (target.username || target.password || !allowedOrigins.has(target.origin)) return baseUrl;
    return target.toString();
  } catch {
    return baseUrl;
  }
}

function passwordRecoveryProvider(c: Context<AppEnv>) {
  return Credentials({
    name: 'InboxPlease recovery password',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    authorize: async (credentials, request) => {
      const parsed = signinSchema.safeParse(credentials);
      if (!parsed.success) return null;
      try {
        const identity = await authenticatePasswordAccount(
          c.env,
          parsed.data.email,
          parsed.data.password,
          request,
        );
        const user: MerchantAuthUser = {
          id: identity.user.id,
          name: identity.user.name,
          email: identity.user.email,
          merchantId: identity.merchant.id,
          role: identity.role,
        };
        return user;
      } catch (error) {
        // Auth.js intentionally presents one credentials failure result.
        // Keep throttling and account-existence details out of redirects.
        if (error instanceof ApiError && (error.status === 401 || error.status === 429)) {
          return null;
        }
        throw error;
      }
    },
  });
}

export function createAuthJsConfig(c: Context<AppEnv>): AuthConfig {
  const graphVersion = metaGraphVersion(c.env.META_GRAPH_VERSION);
  const passwordFallback = isPasswordFallbackEnabled(c.env);
  const facebook = optionalFacebookLoginCredentials(c.env) ?? { appId: '', appSecret: '' };
  return {
    adapter: D1Adapter(c.env.DB),
    basePath: AUTHJS_BASE_PATH,
    ...(c.env.AUTH_SECRET ? { secret: c.env.AUTH_SECRET } : {}),
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_SECONDS },
    providers: [
      Facebook({
        clientId: facebook.appId,
        clientSecret: facebook.appSecret,
        allowDangerousEmailAccountLinking: false,
        checks: ['pkce', 'state'],
        authorization: {
          url: `https://www.facebook.com/${graphVersion}/dialog/oauth`,
          // Page-management and messaging grants belong to the separate,
          // explicit Page onboarding flow. Login requests identity only.
          params: { scope: 'public_profile' },
        },
        token: `https://graph.facebook.com/${graphVersion}/oauth/access_token`,
        userinfo: {
          url: `https://graph.facebook.com/${graphVersion}/me?fields=id,name,picture`,
        },
        // The login token is not a Page token and is not needed after profile
        // retrieval. Do not persist it in the Auth.js accounts table.
        account: () => ({}),
      }),
      ...(passwordFallback ? [passwordRecoveryProvider(c)] : []),
    ],
    callbacks: {
      redirect({ url, baseUrl }) {
        return safeAuthRedirect(url, baseUrl, c.env.DASHBOARD_ORIGIN);
      },
      signIn({ account }) {
        if (account?.provider === 'facebook' && account.type === 'oauth') return true;
        return Boolean(
          passwordFallback && account?.provider === 'credentials' && account.type === 'credentials',
        );
      },
      async jwt({ token, user, account }) {
        if (user?.id && account?.provider === 'facebook' && account.type === 'oauth') {
          const identity = await ensureFacebookSellerIdentity(c.env, {
            id: user.id,
            name: user.name,
          });
          token.sub = identity.user.id;
          token.merchantId = identity.merchant.id;
          token.role = identity.role;
          if (!validFacebookAccountId(account.providerAccountId)) {
            throw new ApiError(403, 'FACEBOOK_ACCOUNT_INVALID', 'The Facebook account is invalid');
          }
          token.facebookAccountId = account.providerAccountId;
          return token;
        }
        const merchantUser = user as MerchantAuthUser | undefined;
        if (merchantUser?.id && merchantUser.merchantId && validRole(merchantUser.role)) {
          token.sub = merchantUser.id;
          token.merchantId = merchantUser.merchantId;
          token.role = merchantUser.role;
        }
        return token;
      },
      session({ session, token }) {
        const merchantId = token.merchantId;
        const role = token.role;
        if (token.sub && typeof merchantId === 'string' && validRole(role)) {
          return {
            ...session,
            user: {
              ...session.user,
              id: token.sub,
              merchantId,
              role,
            },
          };
        }
        return session;
      },
    },
  };
}

export const initAuthJs = initAuthConfig((context) =>
  createAuthJsConfig(context as Context<AppEnv>));

export const authJsRoutes = new Hono<AppEnv>().all('*', authHandler());

export function authContextFromAuthJs(authUser: AuthUser | null): AuthContext | null {
  const token = authUser?.token;
  if (!token?.sub || typeof token.merchantId !== 'string' || !validRole(token.role)) return null;
  const facebookAccountId = validFacebookAccountId(token.facebookAccountId)
    ? token.facebookAccountId
    : undefined;
  return {
    subject: token.sub,
    merchantId: token.merchantId,
    role: token.role,
    source: 'session',
    ...(facebookAccountId ? { facebookAccountId } : {}),
  };
}

export async function resolveAuthJsContext(c: Context<AppEnv>): Promise<AuthContext | null> {
  return authContextFromAuthJs(await getAuthUser(c));
}
