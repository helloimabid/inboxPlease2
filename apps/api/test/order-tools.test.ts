import { afterEach, describe, expect, it } from 'vitest';
import { generateReply } from '../src/ai';
import type { Bindings } from '../src/env';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];

function fixture() {
  const database = migratedDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Tool Test Shop');
    INSERT INTO store_pages (id, merchant_id, name)
    VALUES ('page-1', 'merchant-1', 'Shop Page');
    INSERT INTO products (
      id, merchant_id, page_id, sku, name, price_minor, currency, stock, status
    ) VALUES (
      'product-1', 'merchant-1', 'page-1', 'HP-001', 'HeadPhone', 200000, 'BDT', 1000, 'active'
    );
  `);
  return database;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('order tool-calling loop', () => {
  it('creates a real order via the create_order tool and never fabricates a confirmation without one', async () => {
    const sqlite = fixture();
    const calls: Array<Record<string, unknown>> = [];
    const env = {
      AI_ENABLED: 'true',
      FRONTIER_AI_MODEL: 'anthropic/claude-haiku-4.5',
      DB: d1FromSqlite(sqlite),
      AI: {
        run: async (_model: string, input: Record<string, unknown>) => {
          calls.push(input);
          if (calls.length === 1) {
            // First call: model decides to place the order.
            return {
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'create_order',
                  input: {
                    items: [{ productId: 'product-1', quantity: 1 }],
                    customerName: 'Sadman Abid',
                    customerPhone: '01918742161',
                    deliveryAddress: '329/1, Shenpara, Mirpur 10, Dhaka 1216',
                  },
                },
              ],
            };
          }
          // Second call: model narrates the *real* tool result back to the customer.
          return { content: [{ type: 'text', text: 'অর্ডার নিশ্চিত হয়েছে!' }] };
        },
      },
    } as unknown as Bindings;

    const reply = await generateReply(env, {
      messages: [{ role: 'user', content: 'hea order korun' }],
      routing: { complaintDetected: false, checkoutIntentDetected: true, cartValueMinor: 0, consecutiveLowConfidenceReplies: 0 },
      language: 'banglish',
      merchantId: 'merchant-1',
      pageId: 'page-1',
      threadId: 'customer-1',
      commerce: {
        settings: { assistantName: 'CompStudy', tone: 'friendly' },
        catalog: [{
          id: 'product-1', sku: 'HP-001', name: 'HeadPhone', description: '',
          priceMinor: 200000, currency: 'BDT', stock: 1000,
        }],
      },
    });

    expect(calls).toHaveLength(2);
    expect(reply.orderCreated).toBeDefined();
    expect(reply.orderCreated?.totalMinor).toBe(200000);
    expect(reply.text).toBe('অর্ডার নিশ্চিত হয়েছে!');

    const order = await env.DB.prepare(
      'SELECT * FROM orders WHERE merchant_id = ?1',
    ).bind('merchant-1').first<{ id: string; total_minor: number; status: string }>();
    expect(order).not.toBeNull();
    expect(order?.total_minor).toBe(200000);

    const product = await env.DB.prepare(
      'SELECT stock FROM products WHERE id = ?1',
    ).bind('product-1').first<{ stock: number }>();
    expect(product?.stock).toBe(999);
  });

  it('surfaces insufficient stock as a tool_result instead of crashing or confirming', async () => {
    const sqlite = fixture();
    sqlite.exec("UPDATE products SET stock = 0 WHERE id = 'product-1'");
    const calls: Array<Record<string, unknown>> = [];
    const env = {
      AI_ENABLED: 'true',
      FRONTIER_AI_MODEL: 'anthropic/claude-haiku-4.5',
      DB: d1FromSqlite(sqlite),
      AI: {
        run: async (_model: string, input: Record<string, unknown>) => {
          calls.push(input);
          if (calls.length === 1) {
            return {
              content: [{
                type: 'tool_use',
                id: 'toolu_1',
                name: 'create_order',
                input: {
                  items: [{ productId: 'product-1', quantity: 1 }],
                  customerName: 'Sadman Abid',
                  customerPhone: '01918742161',
                  deliveryAddress: 'Mirpur, Dhaka',
                },
              }],
            };
          }
          const userMsg = input.messages as Array<{ role: string; content: unknown }>;
          const toolResult = userMsg[userMsg.length - 1]?.content;
          expect(JSON.stringify(toolResult)).toContain('INSUFFICIENT_STOCK');
          return { content: [{ type: 'text', text: 'দুঃখিত, এই মুহূর্তে স্টকে নেই।' }] };
        },
      },
    } as unknown as Bindings;

    const reply = await generateReply(env, {
      messages: [{ role: 'user', content: 'order korte chai' }],
      routing: { complaintDetected: false, checkoutIntentDetected: true, cartValueMinor: 0, consecutiveLowConfidenceReplies: 0 },
      language: 'banglish',
      merchantId: 'merchant-1',
      pageId: 'page-1',
      threadId: 'customer-1',
      commerce: { settings: {}, catalog: [] },
    });

    expect(reply.orderCreated).toBeUndefined();
    expect(reply.text).toBe('দুঃখিত, এই মুহূর্তে স্টকে নেই।');
    const order = await env.DB.prepare('SELECT * FROM orders WHERE merchant_id = ?1').bind('merchant-1').first();
    expect(order).toBeNull();
  });
});