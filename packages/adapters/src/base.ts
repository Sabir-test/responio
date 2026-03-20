/**
 * Channel Adapter Interface
 *
 * Every channel (WhatsApp, Telegram, Email, SMS, etc.) implements this interface.
 * New channels are added by implementing this interface — no core inbox modification needed.
 *
 * See ADR-002 for Chatwoot fork strategy.
 */

import type { ChannelType, MessageContentType, MessageDeliveryStatus } from '@responio/events';

export interface NormalizedMessage {
  /** Provider-assigned message ID (used for deduplication) */
  channel_message_id: string;
  /** Sender's channel-specific identifier (phone number, user ID, etc.) */
  sender_id: string;
  /** Display name if available */
  sender_name: string | null;
  /** Message content */
  content: string;
  content_type: MessageContentType;
  /** Additional type-specific content (image URL, document metadata, etc.) */
  media_url?: string;
  media_mime_type?: string;
  media_size_bytes?: number;
  /** Original raw payload for audit purposes */
  raw_payload: Record<string, unknown>;
  /** When the message was sent (ISO 8601) */
  sent_at: string;
  /** Channel-specific metadata */
  metadata: Record<string, unknown>;
}

export interface SendMessageRequest {
  /** Recipient's channel-specific identifier */
  recipient_id: string;
  content: string;
  content_type: MessageContentType;
  media_url?: string;
  /** For template messages (WhatsApp) */
  template_name?: string;
  template_language?: string;
  template_variables?: Record<string, string>;
  /** Platform message ID for correlation */
  correlation_id: string;
}

export interface SendMessageResponse {
  /** Provider-assigned message ID */
  channel_message_id: string;
  status: 'sent' | 'queued' | 'failed';
  error_message?: string;
}

export interface DeliveryStatusUpdate {
  channel_message_id: string;
  status: MessageDeliveryStatus;
  timestamp: string;
  error_code?: string;
  error_message?: string;
}

export interface ChannelCapabilities {
  supports_templates: boolean;
  supports_media: boolean;
  supports_read_receipts: boolean;
  supports_typing_indicators: boolean;
  supports_reactions: boolean;
  max_message_length: number;
  rate_limit_per_second: number;
}

/**
 * Base channel adapter interface.
 * Implement this for each messaging channel.
 */
export interface ChannelAdapter {
  readonly channel_type: ChannelType;
  readonly capabilities: ChannelCapabilities;

  /**
   * Parse a raw inbound webhook payload into a normalized message.
   * Returns null if the payload is not a message (e.g., delivery receipt).
   */
  parseInboundWebhook(rawPayload: unknown): NormalizedMessage | null;

  /**
   * Parse a delivery status update from a webhook payload.
   * Returns null if the payload is not a delivery update.
   */
  parseDeliveryUpdate(rawPayload: unknown): DeliveryStatusUpdate | null;

  /**
   * Verify the webhook signature from the provider.
   * MUST be called before parseInboundWebhook.
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean;

  /**
   * Send a message via this channel.
   */
  sendMessage(request: SendMessageRequest): Promise<SendMessageResponse>;

  /**
   * Get delivery status of a previously sent message.
   */
  getDeliveryStatus(channelMessageId: string): Promise<MessageDeliveryStatus>;
}
