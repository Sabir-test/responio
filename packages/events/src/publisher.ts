import { JetStreamClient, NatsConnection, StringCodec } from 'nats';
import { NatsEvent, createEvent } from './envelope';
import type { Subject } from './streams';

const sc = StringCodec();

/**
 * Type-safe NATS JetStream publisher.
 * Every service that publishes events uses this.
 */
export class EventPublisher {
  private js: JetStreamClient;

  constructor(nc: NatsConnection) {
    this.js = nc.jetstream();
  }

  async publish<P>(
    subject: Subject,
    params: Omit<NatsEvent<P>, 'timestamp' | 'correlation_id' | 'version' | 'event_type'> & {
      payload: P;
      correlation_id?: string;
    }
  ): Promise<string> {
    const event = createEvent<P>({
      event_type: subject,
      ...params,
    });

    const encoded = sc.encode(JSON.stringify(event));
    const ack = await this.js.publish(subject, encoded);

    return ack.seq.toString();
  }
}
