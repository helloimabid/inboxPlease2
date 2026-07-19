import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv, SettingsCacheQueueJob } from '../env';
import { jsonOk } from '../errors';
import { dispatchOutboxAfterCommit, prepareOutboxInsert } from '../outbox';
import { updateSettingsSchema } from '../schemas';
import { validationHook } from '../validation';
import { MERCHANT_ADMIN_ROLES, requireRole } from '../auth';

interface SettingsRow {
  assistant_name: string;
  store_description: string;
  default_language: 'auto' | 'bn' | 'en' | 'banglish';
  tone: 'friendly' | 'professional' | 'concise';
  currency: string;
  business_hours_json: string;
  escalation_cart_threshold_minor: number;
  updated_at: number;
}

const defaults = {
  assistantName: 'InboxPlease',
  storeDescription: '',
  defaultLanguage: 'auto' as const,
  tone: 'friendly' as const,
  currency: 'BDT',
  businessHours: {},
  escalationCartThresholdMinor: 500_000,
  updatedAt: null,
};

function toSettings(row: SettingsRow | null) {
  if (!row) return defaults;
  return {
    assistantName: row.assistant_name,
    storeDescription: row.store_description,
    defaultLanguage: row.default_language,
    tone: row.tone,
    currency: row.currency,
    businessHours: JSON.parse(row.business_hours_json) as unknown,
    escalationCartThresholdMinor: row.escalation_cart_threshold_minor,
    updatedAt: row.updated_at,
  };
}

export const settingsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { merchantId } = c.get('auth');
    const row = await c.env.DB.prepare(
      `SELECT assistant_name, store_description, default_language, tone, currency,
              business_hours_json, escalation_cart_threshold_minor, updated_at
       FROM merchant_settings WHERE merchant_id = ?1`,
    ).bind(merchantId).first<SettingsRow>();
    return jsonOk(c, toSettings(row));
  })
  .put('/', requireRole(...MERCHANT_ADMIN_ROLES), zValidator('json', updateSettingsSchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const input = c.req.valid('json');
    const job: SettingsCacheQueueJob = {
      type: 'settings.cache.refresh',
      eventId: crypto.randomUUID(),
      merchantId,
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO merchant_settings
           (merchant_id, assistant_name, store_description, default_language, tone,
            currency, business_hours_json, escalation_cart_threshold_minor, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())
         ON CONFLICT(merchant_id) DO UPDATE SET
           assistant_name = excluded.assistant_name,
           store_description = excluded.store_description,
           default_language = excluded.default_language,
           tone = excluded.tone,
           currency = excluded.currency,
           business_hours_json = excluded.business_hours_json,
           escalation_cart_threshold_minor = excluded.escalation_cart_threshold_minor,
           updated_at = excluded.updated_at`,
      ).bind(
        merchantId,
        input.assistantName,
        input.storeDescription,
        input.defaultLanguage,
        input.tone,
        input.currency,
        JSON.stringify(input.businessHours),
        input.escalationCartThresholdMinor,
      ),
      prepareOutboxInsert(c.env.DB, job),
    ]);
    c.executionCtx.waitUntil(dispatchOutboxAfterCommit(c.env, job.eventId));
    return jsonOk(c, input);
  });
