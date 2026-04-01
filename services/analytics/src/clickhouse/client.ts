/**
 * ClickHouse client singleton.
 * Used for writing and querying analytics events.
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';

let _client: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!_client) {
    _client = createClient({
      url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      database: process.env.CLICKHOUSE_DB ?? 'responio_analytics',
      username: process.env.CLICKHOUSE_USER ?? 'responio',
      password: process.env.CLICKHOUSE_PASSWORD ?? '',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,  // Fire-and-forget inserts for high throughput
      },
    });
  }
  return _client;
}

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';
