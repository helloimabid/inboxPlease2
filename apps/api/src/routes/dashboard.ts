import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { jsonOk } from '../errors';
import { isPageCredentialReady, isReadyPageCredential } from '../integrations/meta';
import { flag } from '../config';

export const dashboardRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const { merchantId } = c.get('auth');
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [catalog, orders, revenue, usage, pages] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN stock = 0 AND status = 'active' THEN 1 ELSE 0 END) AS out_of_stock
       FROM products WHERE merchant_id = ?1 AND status <> 'archived'`,
    ).bind(merchantId).first<{ total: number; active: number; out_of_stock: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('pending', 'confirmed', 'processing') THEN 1 ELSE 0 END) AS open
       FROM orders WHERE merchant_id = ?1`,
    ).bind(merchantId).first<{ total: number; open: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(total_minor), 0) AS amount_minor, currency
       FROM orders
       WHERE merchant_id = ?1 AND payment_status = 'paid'
       GROUP BY currency ORDER BY amount_minor DESC`,
    ).bind(merchantId).all<{ amount_minor: number; currency: string }>(),
    c.env.DB.prepare(
      `SELECT month, ai_messages, vision_messages FROM monthly_usage
       WHERE merchant_id = ?1 AND month = ?2 LIMIT 1`,
    ).bind(merchantId, currentMonth)
      .first<{ month: string; ai_messages: number; vision_messages: number }>(),
    c.env.DB.prepare(
      `SELECT id, name, connected_at, meta_page_access_token,
              meta_subscription_status, meta_permissions_json, meta_tasks_json,
              messaging_ready_at, ai_messaging_enabled, ai_messaging_approved_at
       FROM store_pages
       WHERE merchant_id = ?1 ORDER BY created_at ASC`,
    ).bind(merchantId).all<{
      id: string;
      name: string;
      connected_at: number | null;
      meta_page_access_token: string | null;
      meta_subscription_status: string;
      meta_permissions_json: string;
      meta_tasks_json: string;
      messaging_ready_at: number | null;
      ai_messaging_enabled: number;
      ai_messaging_approved_at: number | null;
    }>(),
  ]);

  return jsonOk(c, {
    catalog: {
      total: catalog?.total ?? 0,
      active: catalog?.active ?? 0,
      outOfStock: catalog?.out_of_stock ?? 0,
    },
    orders: { total: orders?.total ?? 0, open: orders?.open ?? 0 },
    paidRevenue: revenue.results.map((row) => ({
      amountMinor: row.amount_minor,
      currency: row.currency,
    })),
    usage: [{
      month: currentMonth,
      aiMessages: usage?.ai_messages ?? 0,
      visionMessages: usage?.vision_messages ?? 0,
    }],
    platform: {
      aiEnabled: flag(c.env.AI_ENABLED),
      messagingEnabled: flag(c.env.MESSAGING_ENABLED),
      aiMessagingAvailable: flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
    },
    pages: pages.results.map((row) => ({
      id: row.id,
      name: row.name,
      connectedAt: row.connected_at,
      webhookSubscribed: row.meta_subscription_status === 'subscribed',
      aiMessagingReady: isPageCredentialReady(row),
      aiMessagingEnabled: row.ai_messaging_enabled === 1,
      aiMessagingEffective:
        isReadyPageCredential(row) &&
        flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
      aiMessagingApprovedAt: row.ai_messaging_approved_at,
    })),
  });
});
