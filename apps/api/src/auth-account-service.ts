import { and, asc, eq, sql } from 'drizzle-orm';
import {
  hashPassword,
  normalizeEmail,
  throttleSubjectHash,
  verifyPassword,
  type PasswordDigest,
} from './auth-accounts';
import { createDatabase, type Database } from './db/client';
import {
  authLoginAttempts,
  authAccounts,
  merchantMemberships,
  merchants,
  users,
  type MembershipRole,
} from './db/schema';
import type { Bindings } from './env';
import { ApiError } from './errors';

const WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;
const DUMMY_DIGEST: PasswordDigest = {
  hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iterations: 600_000,
};

type ThrottleKeys = { email: string; ip: string };

export interface AccountIdentity {
  user: { id: string; name: string; email: string | null };
  merchant: {
    id: string;
    name: string;
    plan: 'free' | 'pro' | 'business' | 'enterprise';
  };
  role: MembershipRole;
}

type FacebookSellerUser = {
  id: string;
  name?: string | null | undefined;
};

function sellerDisplayName(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, ' ').slice(0, 120);
  return normalized || 'Facebook seller';
}

async function facebookMerchantId(userId: string): Promise<string> {
  const source = new TextEncoder().encode(`inboxplease:facebook-seller:${userId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  const suffix = [...digest]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `facebook-${suffix}`;
}

/**
 * Give a newly persisted Facebook identity its first tenant boundary.
 *
 * Auth.js invokes the JWT callback only after its adapter has created/loaded
 * the user and safely linked the provider account. A deterministic merchant
 * ID plus D1's atomic batch makes retries idempotent without collapsing the
 * application's normal many-merchant membership model. Existing revoked or
 * inactive memberships are never bypassed by silently creating a new tenant.
 */
export async function ensureFacebookSellerIdentity(
  env: Bindings,
  facebookUser: FacebookSellerUser,
): Promise<AccountIdentity> {
  const database = createDatabase(env.DB);
  const user = (await database.select({
    id: users.id,
    name: users.name,
    email: users.email,
    emailNormalized: users.emailNormalized,
    status: users.status,
  }).from(users).where(eq(users.id, facebookUser.id)).limit(1))[0];
  if (!user || user.status !== 'active') {
    throw new ApiError(403, 'ACCOUNT_INACTIVE', 'The account is unavailable');
  }
  const linkedFacebook = (await database.select({ id: authAccounts.id })
    .from(authAccounts)
    .where(and(
      eq(authAccounts.userId, user.id),
      eq(authAccounts.provider, 'facebook'),
    )).limit(1))[0];
  if (!linkedFacebook) {
    throw new ApiError(403, 'ACCOUNT_NOT_LINKED', 'The Facebook account is not linked');
  }

  const memberships = await database.select({
    merchantId: merchants.id,
    merchantName: merchants.name,
    merchantPlan: merchants.plan,
    merchantStatus: merchants.status,
    role: merchantMemberships.role,
    membershipStatus: merchantMemberships.status,
    createdAt: merchantMemberships.createdAt,
  }).from(merchantMemberships)
    .innerJoin(merchants, eq(merchants.id, merchantMemberships.merchantId))
    .where(eq(merchantMemberships.userId, user.id))
    .orderBy(asc(merchantMemberships.createdAt));

  const displayName = sellerDisplayName(user.name ?? facebookUser.name);
  const active = memberships.find((membership) =>
    membership.membershipStatus === 'active' && membership.merchantStatus === 'active');
  if (active) {
    return {
      user: {
        id: user.id,
        name: displayName,
        email: user.emailNormalized ?? user.email ?? null,
      },
      merchant: {
        id: active.merchantId,
        name: active.merchantName,
        plan: active.merchantPlan,
      },
      role: active.role,
    };
  }

  if (memberships.length > 0) {
    throw new ApiError(403, 'ACCOUNT_INACTIVE', 'The account or merchant is unavailable');
  }

  const merchantId = await facebookMerchantId(user.id);
  const merchantName = `${displayName}'s store`.slice(0, 160);
  await database.batch([
    database.update(users).set({
      name: displayName,
      updatedAt: sql`unixepoch()`,
    }).where(eq(users.id, user.id)),
    database.insert(merchants).values({
      id: merchantId,
      name: merchantName,
      plan: 'free',
      status: 'active',
    }).onConflictDoNothing(),
    database.insert(merchantMemberships).values({
      userId: user.id,
      merchantId,
      role: 'owner',
      status: 'active',
    }).onConflictDoNothing(),
  ] as const);

  const identity = await getActiveAccountIdentity(env, user.id, merchantId);
  if (!identity) {
    throw new ApiError(503, 'ACCOUNT_BOOTSTRAP_FAILED', 'Unable to initialize the seller account');
  }
  return identity;
}

async function throttleKeys(email: string, request: Request): Promise<ThrottleKeys> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return {
    email: await throttleSubjectHash('email', email),
    ip: await throttleSubjectHash('ip', ip),
  };
}

async function assertSigninAllowed(database: Database, keys: ThrottleKeys, now: number) {
  const [emailRows, ipRows] = await Promise.all([
    database.select().from(authLoginAttempts)
      .where(eq(authLoginAttempts.subjectHash, keys.email)).limit(1),
    database.select().from(authLoginAttempts)
      .where(eq(authLoginAttempts.subjectHash, keys.ip)).limit(1),
  ]);
  const email = emailRows[0];
  const ip = ipRows[0];
  if ((email?.lockedUntil ?? 0) > now || (ip?.lockedUntil ?? 0) > now) {
    throw new ApiError(429, 'AUTH_THROTTLED', 'Unable to sign in. Try again later');
  }
}

async function recordFailure(
  database: Database,
  subjectHash: string,
  threshold: number,
  now: number,
) {
  const current = (await database.select().from(authLoginAttempts)
    .where(eq(authLoginAttempts.subjectHash, subjectHash)).limit(1))[0];
  const expired = !current || current.windowStartedAt <= now - WINDOW_SECONDS;
  const failures = expired ? 1 : current.failures + 1;
  const windowStartedAt = expired ? now : current.windowStartedAt;
  const lockedUntil = failures >= threshold
    ? now + LOCK_SECONDS
    : (expired ? 0 : current.lockedUntil);
  await database.insert(authLoginAttempts).values({
    subjectHash,
    failures,
    windowStartedAt,
    lockedUntil,
  }).onConflictDoUpdate({
    target: authLoginAttempts.subjectHash,
    set: { failures, windowStartedAt, lockedUntil, updatedAt: sql`unixepoch()` },
  });
}

async function recordSigninFailure(
  database: Database,
  keys: ThrottleKeys,
  now: number,
) {
  await Promise.all([
    recordFailure(database, keys.email, 10, now),
    recordFailure(database, keys.ip, 30, now),
  ]);
}

export async function authenticatePasswordAccount(
  env: Bindings,
  rawEmail: string,
  password: string,
  request: Request,
): Promise<AccountIdentity> {
  const email = normalizeEmail(rawEmail);
  const now = Math.floor(Date.now() / 1000);
  const keys = await throttleKeys(email, request);
  const database = createDatabase(env.DB);
  await assertSigninAllowed(database, keys, now);

  const account = (await database.select({
    userId: users.id,
    userName: users.name,
    email: users.emailNormalized,
    passwordHash: users.passwordHash,
    passwordSalt: users.passwordSalt,
    passwordIterations: users.passwordIterations,
    userStatus: users.status,
    merchantId: merchantMemberships.merchantId,
    membershipRole: merchantMemberships.role,
    membershipStatus: merchantMemberships.status,
    merchantName: merchants.name,
    merchantPlan: merchants.plan,
    merchantStatus: merchants.status,
  }).from(users)
    .leftJoin(merchantMemberships, eq(merchantMemberships.userId, users.id))
    .leftJoin(merchants, eq(merchants.id, merchantMemberships.merchantId))
    .where(eq(users.emailNormalized, email))
    .orderBy(
      sql`CASE WHEN ${merchantMemberships.status} = 'active'
        AND ${merchants.status} = 'active' THEN 0 ELSE 1 END`,
      asc(merchantMemberships.createdAt),
    )
    .limit(1))[0];

  const digest = account?.passwordHash && account.passwordSalt && account.passwordIterations
    ? {
        hash: account.passwordHash,
        salt: account.passwordSalt,
        iterations: account.passwordIterations,
      }
    : DUMMY_DIGEST;
  const validPassword = await verifyPassword(password, digest);
  const validAccount = Boolean(
    account && validPassword && account.passwordHash && account.passwordSalt &&
    account.passwordIterations && account.userName && account.email &&
    account.userStatus === 'active' && account.membershipStatus === 'active' &&
    account.merchantStatus === 'active' && account.merchantId && account.merchantName &&
    account.merchantPlan && account.membershipRole,
  );
  if (!validAccount || !account || !account.userName || !account.email ||
      !account.merchantId || !account.merchantName || !account.merchantPlan ||
      !account.membershipRole) {
    await recordSigninFailure(database, keys, now);
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  await database.delete(authLoginAttempts)
    .where(eq(authLoginAttempts.subjectHash, keys.email));
  return {
    user: { id: account.userId, name: account.userName, email: account.email },
    merchant: {
      id: account.merchantId,
      name: account.merchantName,
      plan: account.merchantPlan,
    },
    role: account.membershipRole,
  };
}

export async function createPasswordAccount(
  env: Bindings,
  input: { name: string; businessName: string; email: string; password: string },
): Promise<AccountIdentity> {
  const email = normalizeEmail(input.email);
  const database = createDatabase(env.DB);
  // Always spend the password-derivation work before reporting an unavailable
  // signup, so an existing email is not exposed by a cheap timing oracle.
  const [password, existing] = await Promise.all([
    hashPassword(input.password),
    database.select({ id: users.id }).from(users)
      .where(eq(users.emailNormalized, email)).limit(1),
  ]);
  if (existing[0]) {
    throw new ApiError(409, 'SIGNUP_UNAVAILABLE', 'Unable to create an account with these details');
  }

  const userId = crypto.randomUUID();
  const merchantId = crypto.randomUUID();
  try {
    await database.batch([
      database.insert(users).values({
        id: userId,
        name: input.name,
        email,
        emailNormalized: email,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordIterations: password.iterations,
      }),
      database.insert(merchants).values({
        id: merchantId,
        name: input.businessName,
        plan: 'free',
        status: 'active',
      }),
      database.insert(merchantMemberships).values({
        userId,
        merchantId,
        role: 'owner',
        status: 'active',
      }),
    ] as const);
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      throw new ApiError(409, 'SIGNUP_UNAVAILABLE', 'Unable to create an account with these details');
    }
    throw error;
  }

  return {
    user: { id: userId, name: input.name, email },
    merchant: { id: merchantId, name: input.businessName, plan: 'free' },
    role: 'owner',
  };
}

export async function getActiveAccountIdentity(
  env: Bindings,
  userId: string,
  merchantId: string,
): Promise<AccountIdentity | null> {
  const database = createDatabase(env.DB);
  const account = (await database.select({
    userId: users.id,
    userName: users.name,
    email: users.emailNormalized,
    merchantId: merchants.id,
    merchantName: merchants.name,
    merchantPlan: merchants.plan,
    role: merchantMemberships.role,
  }).from(users)
    .innerJoin(merchantMemberships, eq(merchantMemberships.userId, users.id))
    .innerJoin(merchants, eq(merchants.id, merchantMemberships.merchantId))
    .where(and(
      eq(users.id, userId),
      eq(merchants.id, merchantId),
      eq(users.status, 'active'),
      eq(merchantMemberships.status, 'active'),
      eq(merchants.status, 'active'),
    )).limit(1))[0];
  if (!account?.userName) return null;
  return {
    user: { id: account.userId, name: account.userName, email: account.email },
    merchant: {
      id: account.merchantId,
      name: account.merchantName,
      plan: account.merchantPlan,
    },
    role: account.role,
  };
}
