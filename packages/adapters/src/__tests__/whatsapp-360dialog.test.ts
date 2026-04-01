/**
 * Unit tests for the WhatsApp 360dialog channel adapter.
 */

import { describe, it, expect } from 'vitest';
import { WhatsApp360DialogAdapter } from '../whatsapp-360dialog';

const adapter = new WhatsApp360DialogAdapter('test-api-key');

// ── verifyWebhookSignature ────────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  it('returns true for a correct HMAC-SHA256 signature', () => {
    const { createHmac } = require('crypto');
    const secret = 'test-secret';
    const payload = '{"test":"data"}';
    const sig = createHmac('sha256', secret).update(payload).digest('hex');

    expect(adapter.verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('returns false for an incorrect signature', () => {
    expect(adapter.verifyWebhookSignature('payload', 'bad-sig', 'secret')).toBe(false);
  });

  it('returns false when lengths differ (constant-time check)', () => {
    expect(adapter.verifyWebhookSignature('a', 'bb', 'secret')).toBe(false);
  });
});

// ── parseInboundWebhook ───────────────────────────────────────────────────────

describe('parseInboundWebhook', () => {
  it('returns null for empty payload', () => {
    expect(adapter.parseInboundWebhook({})).toBeNull();
    expect(adapter.parseInboundWebhook({ messages: [] })).toBeNull();
  });

  it('parses a text message correctly', () => {
    const payload = {
      messages: [
        {
          id: 'wam-123',
          from: '+14155552671',
          timestamp: '1704067200',
          type: 'text',
          text: { body: 'Hello!' },
        },
      ],
      contacts: [{ wa_id: '+14155552671', profile: { name: 'Alice' } }],
    };

    const result = adapter.parseInboundWebhook(payload);

    expect(result).not.toBeNull();
    expect(result!.channel_message_id).toBe('wam-123');
    expect(result!.sender_id).toBe('+14155552671');
    expect(result!.sender_name).toBe('Alice');
    expect(result!.content).toBe('Hello!');
    expect(result!.content_type).toBe('text');
    expect(result!.media_url).toBeUndefined();
  });

  it('parses an image message and sets content_type', () => {
    const payload = {
      messages: [
        {
          id: 'wam-img',
          from: '+1234567890',
          timestamp: '1704067200',
          type: 'image',
          image: { id: 'img-media-id', caption: 'Check this out', mime_type: 'image/jpeg' },
        },
      ],
    };

    const result = adapter.parseInboundWebhook(payload);

    expect(result).not.toBeNull();
    expect(result!.content_type).toBe('image');
    expect(result!.content).toBe('Check this out');
    expect(result!.media_url).toContain('img-media-id');
  });

  it('returns null when message content is empty', () => {
    const payload = {
      messages: [
        {
          id: 'wam-unknown',
          from: '+1234567890',
          timestamp: '1704067200',
          type: 'unsupported_type_xyz',
        },
      ],
    };

    const result = adapter.parseInboundWebhook(payload);
    expect(result).toBeNull();
  });
});

// ── parseDeliveryUpdate ───────────────────────────────────────────────────────

describe('parseDeliveryUpdate', () => {
  it('returns null when no statuses', () => {
    expect(adapter.parseDeliveryUpdate({})).toBeNull();
    expect(adapter.parseDeliveryUpdate({ statuses: [] })).toBeNull();
  });

  it('parses a delivered status correctly', () => {
    const payload = {
      statuses: [
        {
          id: 'wam-msg-123',
          status: 'delivered',
          timestamp: '1704067200',
          recipient_id: '+1234567890',
        },
      ],
    };

    const result = adapter.parseDeliveryUpdate(payload);

    expect(result).not.toBeNull();
    expect(result!.channel_message_id).toBe('wam-msg-123');
    expect(result!.status).toBe('delivered');
  });

  it('parses a failed status with error details', () => {
    const payload = {
      statuses: [
        {
          id: 'wam-failed',
          status: 'failed',
          timestamp: '1704067200',
          recipient_id: '+1234567890',
          errors: [{ code: 131026, title: 'Message Undeliverable' }],
        },
      ],
    };

    const result = adapter.parseDeliveryUpdate(payload);

    expect(result!.status).toBe('failed');
    expect(result!.error_code).toBe('131026');
    expect(result!.error_message).toBe('Message Undeliverable');
  });
});

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  it('builds correct text message body', async () => {
    let capturedBody: unknown;

    global.fetch = async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({ messages: [{ id: 'wam-sent-001' }] }),
      } as Response;
    };

    const result = await adapter.sendMessage({
      recipient_id: '+14155552671',
      content: 'Hello from Responio!',
      content_type: 'text',
    });

    expect(result.status).toBe('sent');
    expect(result.channel_message_id).toBe('wam-sent-001');
    expect((capturedBody as Record<string, unknown>)['type']).toBe('text');
    expect(((capturedBody as Record<string, unknown>)['text'] as Record<string, unknown>)['body']).toBe('Hello from Responio!');
  });

  it('returns failed status on API error', async () => {
    global.fetch = async () => ({
      ok: false,
      text: async () => 'Rate limit exceeded',
    } as Response);

    const result = await adapter.sendMessage({
      recipient_id: '+1234567890',
      content: 'Hi',
      content_type: 'text',
    });

    expect(result.status).toBe('failed');
    expect(result.error_message).toBe('Rate limit exceeded');
  });
});
