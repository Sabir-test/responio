/**
 * WhatsApp inbound webhook endpoint.
 *
 * POST /webhooks/whatsapp/:tenantId   — 360dialog sends inbound messages here
 * GET  /webhooks/whatsapp/:tenantId   — webhook verification challenge (Meta)
 *
 * Flow:
 *   1. Verify X-Hub-Signature-256 header (HMAC-SHA256 of raw body)
 *   2. Parse payload via WhatsApp360DialogAdapter
 *   3. Upsert contact + conversation in DB (or fire NATS event for inbox service)
 *   4. Emit message.inbound NATS event
 *   5. Return 200 immediately (Whatsapp requires < 15s)
 *
 * Security: webhook secret per inbox is stored in inboxes.channel_config (encrypted at rest).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Knex } from 'knex';
import type { EventPublisher } from '@responio/events';
import { Subjects } from '@responio/events';
import { WhatsApp360DialogAdapter } from '@responio/adapters';

export function registerWhatsAppWebhook(
  app: FastifyInstance,
  db: Knex,
  publisher: EventPublisher
): void {
  // Fastify parses JSON by default; we need raw body for signature verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString()));
    } catch (err) {
      done(err as Error);
    }
  });

  // ── GET /webhooks/whatsapp/:tenantId — Meta verification challenge ─────────
  app.get('/webhooks/whatsapp/:tenantId', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return reply.send(challenge);
    }

    return reply.status(403).send({ error: 'Verification failed' });
  });

  // ── POST /webhooks/whatsapp/:tenantId — inbound messages & status updates ──
  app.post('/webhooks/whatsapp/:tenantId', async (request: FastifyRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    // Validate UUID to prevent enumeration
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
      return reply.status(400).send({ error: 'Invalid tenant ID' });
    }

    // Look up the inbox by tenant to get the webhook secret
    const inbox = await db('inboxes')
      .where({ tenant_id: tenantId, channel_type: 'whatsapp', is_active: true })
      .first();

    if (!inbox) {
      // Return 200 to prevent enumeration — don't reveal that tenant doesn't exist
      return reply.send({ ok: true });
    }

    const channelConfig = inbox.channel_config as { api_key?: string; webhook_secret?: string };
    const adapter = new WhatsApp360DialogAdapter(channelConfig.api_key ?? '');

    // Verify signature
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const secret = channelConfig.webhook_secret ?? process.env.WHATSAPP_WEBHOOK_SECRET ?? '';

    if (rawBody && signature && secret) {
      const sigValue = signature.replace('sha256=', '');
      const isValid = adapter.verifyWebhookSignature(rawBody.toString(), sigValue, secret);
      if (!isValid) {
        request.log.warn({ tenant_id: tenantId }, 'WhatsApp webhook signature verification failed');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    const payload = request.body as unknown;

    // Handle delivery status updates
    const deliveryUpdate = adapter.parseDeliveryUpdate(payload);
    if (deliveryUpdate) {
      await publisher.publish(Subjects.MESSAGE_DELIVERED, {
        tenant_id: tenantId,
        workspace_id: inbox.workspace_id,
        source_service: 'gateway',
        payload: {
          message_id: '',  // Resolved by inbox service via channel_message_id lookup
          conversation_id: '',
          channel_message_id: deliveryUpdate.channel_message_id,
          status: deliveryUpdate.status,
          timestamp: deliveryUpdate.timestamp,
        },
      });
      return reply.send({ ok: true });
    }

    // Handle inbound messages
    const inboundMsg = adapter.parseInboundWebhook(payload);
    if (!inboundMsg) {
      return reply.send({ ok: true }); // Unknown payload type — ack and ignore
    }

    const messageId = crypto.randomUUID();

    await publisher.publish(Subjects.MESSAGE_INBOUND, {
      tenant_id: tenantId,
      workspace_id: inbox.workspace_id,
      source_service: 'gateway',
      payload: {
        message_id: messageId,
        conversation_id: '',   // Resolved by inbox service (contact lookup → conversation)
        contact_id: '',        // Resolved by inbox service (phone → contact)
        channel_type: 'whatsapp',
        content: inboundMsg.content,
        content_type: inboundMsg.content_type,
        channel_message_id: inboundMsg.channel_message_id,
        metadata: {
          sender_id: inboundMsg.sender_id,
          sender_name: inboundMsg.sender_name,
          media_url: inboundMsg.media_url,
          inbox_id: inbox.id,
          raw: inboundMsg.raw_payload,
        },
      },
    });

    request.log.info(
      { tenant_id: tenantId, inbox_id: inbox.id, channel_msg_id: inboundMsg.channel_message_id },
      'WhatsApp inbound message received'
    );

    return reply.send({ ok: true });
  });
}
