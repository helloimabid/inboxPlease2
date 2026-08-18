import { DurableObject } from 'cloudflare:workers';
import {
  detectCheckoutIntent,
  detectComplaint,
  detectPreferredLanguage,
  findSimilarProducts,
  generateReply,
  matchProductFromImage,
  transcribeVoiceNote,
  type CatalogContextItem,
} from '../ai';
import { flag } from '../config';
import type { Bindings, MetaMessagingEvent } from '../env';
import {
  fetchMetaMedia,
  isPageAiAutomationActive,
  isPageAiMessagingEnabled,
  passThreadToHuman,
  sendAiReply,
} from '../integrations/meta';
import { storePageObjectName } from './tenant-names';

interface ThreadEventInput {
  eventId: string;
  merchantId: string;
  pageId: string;
  customerPsid: string;
  event: MetaMessagingEvent;
}

type ThreadMeta = {
  merchant_id: string;
  page_id: string;
  customer_psid: string;
  preferred_language: string;
  low_confidence_count: number;
  handed_off_to_human: number;
};

type DeliveryStatus =
  | 'preparing'
  | 'retryable'
  | 'reply_ready'
  | 'delivery_attempted'
  | 'delivery_uncertain'
  | 'delivered'
  | 'completed'
  | 'paused';

type ProcessedEventRow = {
  event_id: string;
  status: DeliveryStatus;
  reply_text: string | null;
  reply_model: string | null;
  language: string | null;
  complaint: number;
  low_confidence: number;
  post_state_applied: number;
  usage_counted: number;
  handoff_attempted: number;
};

function parseThreadInput(value: unknown): ThreadEventInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid thread event');
  const input = value as Record<string, unknown>;
  if (
    typeof input.eventId !== 'string' || typeof input.merchantId !== 'string' ||
    typeof input.pageId !== 'string' || typeof input.customerPsid !== 'string' ||
    !input.event || typeof input.event !== 'object'
  ) throw new Error('Invalid thread event');
  return input as unknown as ThreadEventInput;
}

export class CustomerThreadDO extends DurableObject<Bindings> {
  private processingTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS thread_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        merchant_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        customer_psid TEXT NOT NULL,
        preferred_language TEXT NOT NULL DEFAULT 'bn',
        low_confidence_count INTEGER NOT NULL DEFAULT 0,
        handed_off_to_human INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
        ON messages(external_id) WHERE external_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cart_items (
        product_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        unit_price_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        quantity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'preparing',
        reply_text TEXT,
        reply_model TEXT,
        language TEXT,
        complaint INTEGER NOT NULL DEFAULT 0,
        low_confidence INTEGER NOT NULL DEFAULT 0,
        post_state_applied INTEGER NOT NULL DEFAULT 0,
        usage_counted INTEGER NOT NULL DEFAULT 0,
        handoff_attempted INTEGER NOT NULL DEFAULT 0,
        delivery_attempted_at INTEGER,
        delivered_at INTEGER,
        last_error TEXT,
        processed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    this.ensureProcessedEventSchema();
  }

  private ensureProcessedEventSchema(): void {
    const columns = new Set(
      this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(processed_events)')
        .toArray()
        .map((column) => column.name),
    );
    // Existing DOs used a one-column tombstone table. The completed default
    // preserves those historical dedupe records during the in-place upgrade.
    const additions: Array<[string, string]> = [
      ['status', "TEXT NOT NULL DEFAULT 'completed'"],
      ['reply_text', 'TEXT'],
      ['reply_model', 'TEXT'],
      ['language', 'TEXT'],
      ['complaint', 'INTEGER NOT NULL DEFAULT 0'],
      ['low_confidence', 'INTEGER NOT NULL DEFAULT 0'],
      ['post_state_applied', 'INTEGER NOT NULL DEFAULT 0'],
      ['usage_counted', 'INTEGER NOT NULL DEFAULT 0'],
      ['handoff_attempted', 'INTEGER NOT NULL DEFAULT 0'],
      ['delivery_attempted_at', 'INTEGER'],
      ['delivered_at', 'INTEGER'],
      ['last_error', 'TEXT'],
      ['updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.ctx.storage.sql.exec(
          `ALTER TABLE processed_events ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }

  private bindOrAssert(input: ThreadEventInput): ThreadMeta {
    let meta = this.ctx.storage.sql.exec<ThreadMeta>(
      `SELECT merchant_id, page_id, customer_psid, preferred_language,
              low_confidence_count, handed_off_to_human
       FROM thread_meta WHERE singleton = 1`,
    ).toArray()[0];
    if (!meta) {
      this.ctx.storage.sql.exec(
        `INSERT INTO thread_meta
           (singleton, merchant_id, page_id, customer_psid)
         VALUES (1, ?1, ?2, ?3)`,
        input.merchantId,
        input.pageId,
        input.customerPsid,
      );
      meta = {
        merchant_id: input.merchantId,
        page_id: input.pageId,
        customer_psid: input.customerPsid,
        preferred_language: 'bn',
        low_confidence_count: 0,
        handed_off_to_human: 0,
      };
    }
    if (
      meta.merchant_id !== input.merchantId || meta.page_id !== input.pageId ||
      meta.customer_psid !== input.customerPsid
    ) throw new Error('Durable Object tenant identity mismatch');
    return meta;
  }

  private reserveEvent(eventId: string): ProcessedEventRow {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO processed_events (event_id, status, updated_at)
       VALUES (?1, 'preparing', unixepoch())`,
      eventId,
    );
    const event = this.ctx.storage.sql.exec<ProcessedEventRow>(
      `SELECT event_id, status, reply_text, reply_model, language, complaint,
              low_confidence, post_state_applied, usage_counted, handoff_attempted
       FROM processed_events WHERE event_id = ?1`,
      eventId,
    ).toArray()[0];
    if (!event) throw new Error('Unable to reserve thread event');
    return event;
  }

  private markEvent(
    eventId: string,
    status: DeliveryStatus,
    error: string | null = null,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE processed_events SET status = ?2, last_error = ?3,
         updated_at = unixepoch(),
         processed_at = CASE WHEN ?2 IN ('completed', 'paused') THEN unixepoch() ELSE processed_at END
       WHERE event_id = ?1`,
      eventId,
      status,
      error,
    );
  }

  private recentMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.ctx.storage.sql.exec<{ role: string; content: string }>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM messages ORDER BY id DESC LIMIT 12
       ) ORDER BY id ASC`,
    ).toArray().flatMap((row) =>
      row.role === 'user' || row.role === 'assistant'
        ? [{ role: row.role, content: row.content }]
        : [],
    );
  }

  private cartValueMinor(): number {
    const row = this.ctx.storage.sql.exec<{ total: number }>(
      'SELECT COALESCE(SUM(unit_price_minor * quantity), 0) AS total FROM cart_items',
    ).toArray()[0];
    return row?.total ?? 0;
  }

  private async catalog(input: ThreadEventInput): Promise<CatalogContextItem[]> {
    const objectName = await storePageObjectName(input.merchantId, input.pageId);
    const stub = this.env.STORE_PAGES.get(this.env.STORE_PAGES.idFromName(objectName));
    const url = new URL('https://do.internal/catalog');
    url.searchParams.set('merchantId', input.merchantId);
    url.searchParams.set('pageId', input.pageId);
    const response = await stub.fetch(url.toString());
    if (!response.ok) return [];
    const payload = await response.json<{ products?: CatalogContextItem[] }>();
    return payload.products ?? [];
  }

  private async settings(input: ThreadEventInput): Promise<{
    assistantName?: string;
    storeDescription?: string;
    defaultLanguage?: string;
    tone?: string;
    escalationCartThresholdMinor?: number;
  }> {
    const objectName = await storePageObjectName(input.merchantId, input.pageId);
    const stub = this.env.STORE_PAGES.get(this.env.STORE_PAGES.idFromName(objectName));
    const url = new URL('https://do.internal/settings');
    url.searchParams.set('merchantId', input.merchantId);
    url.searchParams.set('pageId', input.pageId);
    const response = await stub.fetch(url.toString());
    if (!response.ok) return {};
    const payload = await response.json<{ settings?: Record<string, unknown> }>();
    const settings = payload.settings ?? {};
    return {
      ...(typeof settings.assistantName === 'string'
        ? { assistantName: settings.assistantName }
        : {}),
      ...(typeof settings.storeDescription === 'string'
        ? { storeDescription: settings.storeDescription }
        : {}),
      ...(typeof settings.defaultLanguage === 'string'
        ? { defaultLanguage: settings.defaultLanguage }
        : {}),
      ...(typeof settings.tone === 'string' ? { tone: settings.tone } : {}),
      ...(typeof settings.escalationCartThresholdMinor === 'number'
        ? { escalationCartThresholdMinor: settings.escalationCartThresholdMinor }
        : {}),
    };
  }

  private async contentFromEvent(input: ThreadEventInput): Promise<string> {
    const message = input.event.message;
    if (message?.text) return message.text;
    if (input.event.postback?.payload) return input.event.postback.payload;
    const attachment = message?.attachments?.[0];
    const url = attachment?.payload?.url;
    if (!attachment?.type || !url) return '[Unsupported message]';
    const media = await fetchMetaMedia(this.env, input.merchantId, input.pageId, url);
    const mediaKey = `inbound/${input.merchantId}/${input.pageId}/${input.eventId}`;
    await this.env.MEDIA.put(mediaKey, media.bytes, {
      httpMetadata: { contentType: media.contentType },
      customMetadata: { merchant_id: input.merchantId, page_id: input.pageId },
    });
    if (attachment.type === 'audio') {
      return await transcribeVoiceNote(this.env, media.bytes);
    }
    if (attachment.type === 'image') {
      const catalog = await this.catalog(input);
      const match = await matchProductFromImage(this.env, media.bytes, catalog);
      if (match.productId && match.confidence >= 0.7) {
        return `[Customer image matched product ${match.productId} at confidence ${match.confidence.toFixed(2)}] ${match.description}`;
      }
      const similar = await findSimilarProducts(this.env, input.pageId, match.description);
      return `[Customer image: ${match.description}] Similar catalog IDs: ${similar.map((item) => item.id).join(', ') || 'none'}`;
    }
    return `[Customer sent ${attachment.type} media]`;
  }

  private applyReplyState(event: ProcessedEventRow, meta: ThreadMeta): void {
    if (event.post_state_applied) return;
    // Both synchronous writes occur before the next await and therefore commit
    // together in SQLite-backed Durable Object storage.
    this.ctx.storage.sql.exec(
      `UPDATE processed_events SET post_state_applied = 1, updated_at = unixepoch()
       WHERE event_id = ?1 AND post_state_applied = 0`,
      event.event_id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE thread_meta SET low_confidence_count = ?1, updated_at = unixepoch()
       WHERE singleton = 1`,
      event.low_confidence ? meta.low_confidence_count + 1 : 0,
    );
    event.post_state_applied = 1;
  }

  private async countUsageOnce(event: ProcessedEventRow, merchantId: string): Promise<void> {
    if (!flag(this.env.AI_ENABLED) || event.usage_counted) return;
    // Prefer a possible undercount after a cross-database crash to double
    // charging a merchant on retry.
    this.ctx.storage.sql.exec(
      `UPDATE processed_events SET usage_counted = 1, updated_at = unixepoch()
       WHERE event_id = ?1 AND usage_counted = 0`,
      event.event_id,
    );
    event.usage_counted = 1;
    try {
      const month = new Date().toISOString().slice(0, 7);
      await this.env.DB.prepare(
        `INSERT INTO monthly_usage (merchant_id, month, ai_messages)
         VALUES (?1, ?2, 1)
         ON CONFLICT(merchant_id, month) DO UPDATE SET ai_messages = ai_messages + 1`,
      ).bind(merchantId, month).run();
    } catch (error) {
      console.error('Unable to record AI usage without risking a double count', error);
    }
  }

  private async finishDeliveredEvent(
    input: ThreadEventInput,
    event: ProcessedEventRow,
  ): Promise<void> {
    let finalError: string | null = null;
    const shouldHandoff = Boolean(
      event.complaint && !event.handoff_attempted &&
      flag(this.env.MESSAGING_ENABLED) && flag(this.env.HANDOFF_ON_COMPLAINT) &&
      this.env.META_HANDOVER_TARGET_APP_ID,
    );
    if (shouldHandoff) {
      // Pause automation and reserve the handoff before the second external
      // effect. A crash can then never produce a duplicate handoff request.
      this.ctx.storage.sql.exec(
        `UPDATE processed_events SET handoff_attempted = 1, updated_at = unixepoch()
         WHERE event_id = ?1`,
        event.event_id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE thread_meta SET handed_off_to_human = 1, updated_at = unixepoch()
         WHERE singleton = 1`,
      );
      event.handoff_attempted = 1;
      try {
        await passThreadToHuman(
          this.env,
          input.merchantId,
          input.pageId,
          input.customerPsid,
          'Complaint detected by InboxPlease; review recent thread history.',
        );
      } catch (error) {
        finalError = `Handoff delivery uncertain: ${String(error).slice(0, 400)}`;
        console.error(finalError);
      }
    }
    this.markEvent(event.event_id, 'completed', finalError);
  }

  private async deliverPreparedReply(
    input: ThreadEventInput,
    meta: ThreadMeta,
    event: ProcessedEventRow,
  ): Promise<void> {
    if (!event.reply_text || !event.reply_model || !event.language) {
      this.markEvent(event.event_id, 'retryable', 'Prepared reply is incomplete');
      throw new Error('Prepared reply is incomplete');
    }
    if (!(await isPageAiMessagingEnabled(this.env, input.merchantId, input.pageId))) {
      this.markEvent(event.event_id, 'paused', 'AI messaging is not approved for this Page');
      return;
    }
    this.applyReplyState(event, meta);
    await this.countUsageOnce(event, input.merchantId);

    if (!flag(this.env.MESSAGING_ENABLED)) {
      this.markEvent(event.event_id, 'completed');
      return;
    }

    // This durable write is the external-delivery boundary. Once it commits,
    // no automatic retry is allowed to call Meta again: a fetch failure can be
    // ambiguous because Meta may have accepted the message before disconnect.
    this.ctx.storage.sql.exec(
      `UPDATE processed_events SET status = 'delivery_attempted',
         delivery_attempted_at = unixepoch(), last_error = NULL,
         updated_at = unixepoch() WHERE event_id = ?1`,
      event.event_id,
    );
    try {
      const sent = await sendAiReply(
        this.env,
        input.merchantId,
        input.pageId,
        input.customerPsid,
        event.reply_text,
      );
      if (!sent) {
        this.markEvent(event.event_id, 'paused', 'AI messaging was disabled before delivery');
        return;
      }
    } catch (error) {
      this.markEvent(
        event.event_id,
        'delivery_uncertain',
        `Meta reply delivery uncertain: ${String(error).slice(0, 400)}`,
      );
      console.error('Meta reply delivery is uncertain; suppressing automatic resend', error);
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE processed_events SET status = 'delivered', delivered_at = unixepoch(),
         last_error = NULL, updated_at = unixepoch() WHERE event_id = ?1`,
      event.event_id,
    );
    await this.finishDeliveredEvent(input, event);
  }

  private async processEvent(
    input: ThreadEventInput,
    meta: ThreadMeta,
    event: ProcessedEventRow,
  ): Promise<void> {
    if (event.status === 'completed' || event.status === 'paused' ||
        event.status === 'delivery_attempted' || event.status === 'delivery_uncertain') {
      return;
    }
    if (event.status === 'delivered') {
      await this.finishDeliveredEvent(input, event);
      return;
    }
    if (event.status === 'reply_ready') {
      await this.deliverPreparedReply(input, meta, event);
      return;
    }

    // Recheck at the point of work, not only when the Queue handed the event
    // off. A Page can be disabled, disconnected, or globally paused while a
    // message is waiting/retrying. Stop before media fetches, AI generation,
    // transcript/catalog work, and usage counting.
    if (!(await isPageAiAutomationActive(this.env, input.merchantId, input.pageId))) {
      this.markEvent(input.eventId, 'paused', 'AI messaging is not active for this Page');
      return;
    }

    this.markEvent(input.eventId, 'preparing');
    try {
      const content = await this.contentFromEvent(input);
      const language = detectPreferredLanguage(content);
      const externalId = input.event.message?.mid ?? input.event.postback?.mid ?? input.eventId;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO messages (external_id, role, content)
         VALUES (?1, 'user', ?2)`,
        externalId,
        content,
      );
      this.ctx.storage.sql.exec(
        `UPDATE thread_meta SET preferred_language = ?1, updated_at = unixepoch()
         WHERE singleton = 1`,
        language,
      );

      // Human-owned messages remain in history but become terminal no-reply
      // events. A take-control webhook only resumes automation for new events.
      if (meta.handed_off_to_human === 1) {
        this.markEvent(input.eventId, 'paused');
        return;
      }

      const complaint = detectComplaint(content);
      const checkoutIntent = detectCheckoutIntent(content);
      const [catalog, settings] = await Promise.all([
        this.catalog(input),
        this.settings(input),
      ]);
      let reply: {
        text: string;
        model: string;
        escalated: boolean;
        lowConfidence: boolean;
        orderCreated?: { orderId: string; totalMinor: number; currency: string } | undefined;
      };
      try {
        reply = await generateReply(this.env, {
          messages: this.recentMessages(),
          routing: {
            complaintDetected: complaint,
            checkoutIntentDetected: checkoutIntent,
            cartValueMinor: this.cartValueMinor(),
            consecutiveLowConfidenceReplies: meta.low_confidence_count,
            ...(settings.escalationCartThresholdMinor !== undefined
              ? { escalationCartThresholdMinor: settings.escalationCartThresholdMinor }
              : {}),
          },
          language,
          merchantId: input.merchantId,
          pageId: input.pageId,
          threadId: input.customerPsid,
          commerce: { settings, catalog },
        });
      } catch (error) {
        console.error('generateReply threw an error; using safe fallback', error);
        reply = {
          text: language === 'bn'
            ? 'দুঃখিত — বর্তমানে সাময়িক সমস্যা হচ্ছে; অনুগ্রহ করে পরে আবার চেষ্টা করুন।'
            : 'Sorry — there was a temporary problem generating a reply; please try again later.',
          model: 'ai-error',
          escalated: false,
          lowConfidence: true,
        };
      }
      if (reply.orderCreated) {
        // Chat-originated orders go through the exact same createOrderCore
        // path (and the same catalog.reindex outbox job) as a dashboard-
        // created order, so stock sync and downstream notifications already
        // work the same way. This is just a breadcrumb for debugging.
        console.log('Chat tool created order', input.merchantId, input.customerPsid, reply.orderCreated);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (external_id, role, content, model)
         VALUES (?1, 'assistant', ?2, ?3)
         ON CONFLICT DO UPDATE SET
           content = excluded.content, model = excluded.model`,
        `${input.eventId}:assistant`,
        reply.text,
        reply.model,
      );
      this.ctx.storage.sql.exec(
        `UPDATE processed_events SET status = 'reply_ready', reply_text = ?2,
           reply_model = ?3, language = ?4, complaint = ?5,
           low_confidence = ?6, last_error = NULL, updated_at = unixepoch()
         WHERE event_id = ?1`,
        input.eventId,
        reply.text,
        reply.model,
        language,
        complaint ? 1 : 0,
        reply.lowConfidence ? 1 : 0,
      );
      const prepared: ProcessedEventRow = {
        ...event,
        status: 'reply_ready',
        reply_text: reply.text,
        reply_model: reply.model,
        language,
        complaint: complaint ? 1 : 0,
        low_confidence: reply.lowConfidence ? 1 : 0,
      };
      await this.deliverPreparedReply(input, meta, prepared);
    } catch (error) {
      const current = this.ctx.storage.sql.exec<{ status: DeliveryStatus }>(
        'SELECT status FROM processed_events WHERE event_id = ?1',
        input.eventId,
      ).toArray()[0];
      if (current?.status === 'preparing' || current?.status === 'retryable') {
        this.markEvent(input.eventId, 'retryable', String(error).slice(0, 500));
      }
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/events/meta', '/events/handover'].includes(path)) {
      return new Response('Not found', { status: 404 });
    }
    const task = this.processingTail.then(async () => {
      try {
        const input = parseThreadInput(await request.json());
        const meta = this.bindOrAssert(input);
        if (path === '/events/handover') {
          const handedOff = input.event.take_thread_control ? 0 : 1;
          this.ctx.storage.sql.exec(
            `UPDATE thread_meta SET handed_off_to_human = ?1, updated_at = unixepoch()
             WHERE singleton = 1`,
            handedOff,
          );
          return Response.json({ ok: true, handedOff: Boolean(handedOff) });
        }
        const event = this.reserveEvent(input.eventId);
        const wasTerminal = [
          'completed', 'paused', 'delivery_attempted', 'delivery_uncertain', 'delivered',
        ]
          .includes(event.status);
        await this.processEvent(input, meta, event);
        const current = this.ctx.storage.sql.exec<{ status: DeliveryStatus }>(
          'SELECT status FROM processed_events WHERE event_id = ?1',
          input.eventId,
        ).toArray()[0];
        return Response.json({
          ok: true,
          duplicate: wasTerminal,
          deliveryStatus: current?.status ?? event.status,
        });
      } catch (error) {
        console.error('CustomerThreadDO event failed', error);
        return Response.json({ ok: false, error: 'Thread processing failed' }, { status: 500 });
      }
    });
    this.processingTail = task.then(() => undefined, () => undefined);
    return task;
  }
}