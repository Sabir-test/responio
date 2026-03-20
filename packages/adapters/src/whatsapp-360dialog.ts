import { createHmac } from 'crypto';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  NormalizedMessage,
  SendMessageRequest,
  SendMessageResponse,
  DeliveryStatusUpdate,
} from './base';
import type { MessageDeliveryStatus } from '@responio/events';

/**
 * WhatsApp Business API adapter via 360dialog BSP.
 *
 * ⚠️  PRODUCTION ONLY adapter. Use Evolution API for dev/testing.
 * Requires 360dialog API key and Meta Business verification.
 *
 * API docs: https://docs.360dialog.com/whatsapp-api
 */
export class WhatsApp360DialogAdapter implements ChannelAdapter {
  readonly channel_type = 'whatsapp' as const;

  readonly capabilities: ChannelCapabilities = {
    supports_templates: true,
    supports_media: true,
    supports_read_receipts: true,
    supports_typing_indicators: false,
    supports_reactions: true,
    max_message_length: 4096,
    rate_limit_per_second: 80,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://waba.360dialog.io/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');
    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(signature, expectedSig);
  }

  parseInboundWebhook(rawPayload: unknown): NormalizedMessage | null {
    const payload = rawPayload as Dialog360WebhookPayload;

    if (!payload?.messages?.length) return null;

    const msg = payload.messages[0];
    const contact = payload.contacts?.[0];

    const contentType = this.mapContentType(msg.type);
    const content = this.extractContent(msg);

    if (!content) return null;

    return {
      channel_message_id: msg.id,
      sender_id: msg.from,
      sender_name: contact?.profile?.name ?? null,
      content,
      content_type: contentType,
      media_url: this.extractMediaUrl(msg),
      raw_payload: payload as Record<string, unknown>,
      sent_at: new Date(Number(msg.timestamp) * 1000).toISOString(),
      metadata: {
        whatsapp_business_account_id: payload.entry?.[0]?.id,
        phone_number_id: payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id,
      },
    };
  }

  parseDeliveryUpdate(rawPayload: unknown): DeliveryStatusUpdate | null {
    const payload = rawPayload as Dialog360WebhookPayload;
    const statuses = payload?.statuses;

    if (!statuses?.length) return null;

    const status = statuses[0];

    return {
      channel_message_id: status.id,
      status: this.mapDeliveryStatus(status.status),
      timestamp: new Date(Number(status.timestamp) * 1000).toISOString(),
      error_code: status.errors?.[0]?.code?.toString(),
      error_message: status.errors?.[0]?.title,
    };
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResponse> {
    const body = this.buildMessageBody(request);

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'D360-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: error,
      };
    }

    const result = await response.json() as { messages: Array<{ id: string }> };

    return {
      channel_message_id: result.messages[0].id,
      status: 'sent',
    };
  }

  async getDeliveryStatus(channelMessageId: string): Promise<MessageDeliveryStatus> {
    // 360dialog does not have a status polling endpoint — status comes via webhooks
    // Return 'sent' as fallback and rely on delivery webhook updates
    void channelMessageId;
    return 'sent';
  }

  private buildMessageBody(request: SendMessageRequest): Record<string, unknown> {
    if (request.template_name) {
      return {
        messaging_product: 'whatsapp',
        to: request.recipient_id,
        type: 'template',
        template: {
          name: request.template_name,
          language: { code: request.template_language ?? 'en' },
          components: request.template_variables
            ? [{
                type: 'body',
                parameters: Object.values(request.template_variables).map((v) => ({
                  type: 'text',
                  text: v,
                })),
              }]
            : [],
        },
      };
    }

    if (request.content_type === 'text') {
      return {
        messaging_product: 'whatsapp',
        to: request.recipient_id,
        type: 'text',
        text: { body: request.content },
      };
    }

    if (request.media_url) {
      return {
        messaging_product: 'whatsapp',
        to: request.recipient_id,
        type: request.content_type,
        [request.content_type]: { link: request.media_url, caption: request.content },
      };
    }

    return {
      messaging_product: 'whatsapp',
      to: request.recipient_id,
      type: 'text',
      text: { body: request.content },
    };
  }

  private mapContentType(type: string): NormalizedMessage['content_type'] {
    const map: Record<string, NormalizedMessage['content_type']> = {
      text: 'text',
      image: 'image',
      video: 'video',
      audio: 'audio',
      document: 'document',
      location: 'location',
      sticker: 'sticker',
      interactive: 'interactive',
      template: 'template',
    };
    return map[type] ?? 'text';
  }

  private extractContent(msg: Dialog360Message): string {
    if (msg.type === 'text') return msg.text?.body ?? '';
    if (msg.type === 'image') return msg.image?.caption ?? '[Image]';
    if (msg.type === 'video') return msg.video?.caption ?? '[Video]';
    if (msg.type === 'audio') return '[Voice message]';
    if (msg.type === 'document') return msg.document?.filename ?? '[Document]';
    if (msg.type === 'location') return `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
    if (msg.type === 'sticker') return '[Sticker]';
    return '';
  }

  private extractMediaUrl(msg: Dialog360Message): string | undefined {
    return (msg.image?.id || msg.video?.id || msg.audio?.id || msg.document?.id)
      ? `${this.baseUrl}/media/${msg.image?.id ?? msg.video?.id ?? msg.audio?.id ?? msg.document?.id}`
      : undefined;
  }

  private mapDeliveryStatus(status: string): MessageDeliveryStatus {
    const map: Record<string, MessageDeliveryStatus> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
    };
    return map[status] ?? 'sent';
  }
}

// ─── 360dialog Webhook Types ──────────────────────────────────────────────────

interface Dialog360Message {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type?: string; sha256?: string };
  video?: { id: string; caption?: string; mime_type?: string };
  audio?: { id: string; mime_type?: string };
  document?: { id: string; filename?: string; mime_type?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  sticker?: { id: string; mime_type?: string };
  interactive?: Record<string, unknown>;
}

interface Dialog360WebhookPayload {
  messages?: Dialog360Message[];
  contacts?: Array<{ wa_id: string; profile: { name: string } }>;
  statuses?: Array<{
    id: string;
    status: string;
    timestamp: string;
    recipient_id: string;
    errors?: Array<{ code: number; title: string }>;
  }>;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id: string; display_phone_number: string };
      };
    }>;
  }>;
}

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
