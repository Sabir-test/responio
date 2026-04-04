import { JetStreamClient, NatsConnection, StringCodec, ConsumerConfig, DeliverPolicy, AckPolicy, ReplayPolicy } from 'nats';
import { NatsEvent } from './envelope';

const sc = StringCodec();

export interface SubscriberOptions {
  /** Consumer group name — events delivered to ONE instance per group */
  consumerName: string;
  /** Which stream to consume from */
  streamName: string;
  /** Subject filter, e.g. "conversation.*" or "message.inbound" */
  filterSubject: string;
  /** Start from new messages only (default) or from beginning */
  deliverPolicy?: DeliverPolicy;
}

/**
 * Type-safe NATS JetStream subscriber with at-least-once delivery.
 * Uses push consumer with explicit acknowledgment.
 */
export class EventSubscriber {
  private js: JetStreamClient;

  constructor(nc: NatsConnection) {
    this.js = nc.jetstream();
  }

  async subscribe<P>(
    opts: SubscriberOptions,
    handler: (event: NatsEvent<P>, ack: () => void, nack: () => void) => Promise<void>
  ): Promise<void> {
    const consumerConfig: Partial<ConsumerConfig> = {
      durable_name: opts.consumerName,
      deliver_policy: opts.deliverPolicy ?? DeliverPolicy.New,
      ack_policy: AckPolicy.Explicit,
      replay_policy: ReplayPolicy.Instant,
      filter_subject: opts.filterSubject,
      max_deliver: 5,        // Retry up to 5 times before moving to DLQ
      ack_wait: 30 * 1e9,    // 30 seconds in nanoseconds
    };

    const sub = await this.js.subscribe(opts.filterSubject, {
      config: consumerConfig,
    });

    (async () => {
      for await (const msg of sub) {
        try {
          const event = JSON.parse(sc.decode(msg.data)) as NatsEvent<P>;

          await handler(
            event,
            () => msg.ack(),
            () => msg.nak()
          );
        } catch (err) {
          // NAK so NATS retries delivery up to max_deliver times
          process.stderr.write(JSON.stringify({ level: 'error', subject: opts.filterSubject, err: String(err) }) + '\n');
          msg.nak();
        }
      }
    })();
  }
}
