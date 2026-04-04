/**
 * Workflow DSL → n8n JSON Translator
 *
 * Translates our React Flow-compatible workflow graph (stored in DB as JSON)
 * into n8n workflow JSON that can be pushed to the n8n API.
 *
 * Our DSL is a superset of the UI representation — it adds execution metadata
 * that React Flow doesn't need (retry policies, action URLs, etc.)
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { N8nWorkflow, N8nNode, N8nConnections } from './client';

// ─── Our Workflow DSL types ───────────────────────────────────────────────────

export type DslTriggerType =
  | 'conversation_created'
  | 'message_inbound'
  | 'keyword_match'
  | 'contact_field_updated'
  | 'lifecycle_changed'
  | 'conversation_assigned'
  | 'conversation_resolved'
  | 'broadcast_reply'
  | 'ai_handoff'
  | 'scheduled'
  | 'external_webhook';

export type DslActionType =
  | 'send_message'
  | 'update_contact'
  | 'assign_conversation'
  | 'add_tag'
  | 'change_lifecycle'
  | 'close_conversation'
  | 'snooze_conversation'
  | 'invoke_ai_agent'
  | 'ai_classify'
  | 'ai_extract'
  | 'create_note'
  | 'http_request'      // Advanced tier only
  | 'wait_delay';

export type DslConditionType = 'if_else' | 'switch' | 'time_gate' | 'ab_split';

export interface DslNode {
  id: string;
  type: 'trigger' | 'action' | 'condition' | 'ai_step';
  /** React Flow position */
  position: { x: number; y: number };
  data: DslTriggerData | DslActionData | DslConditionData | DslAiStepData;
}

export interface DslEdge {
  id: string;
  source: string;
  target: string;
  /** For condition nodes: which output branch (0 = true/default, 1 = false/else) */
  sourceHandle?: string;
  label?: string;
}

export interface DslWorkflowGraph {
  nodes: DslNode[];
  edges: DslEdge[];
}

interface DslTriggerData {
  trigger_type: DslTriggerType;
  /** For keyword_match: keywords to match against */
  keywords?: string[];
  /** For scheduled: cron expression */
  cron?: string;
  /** For contact_field_updated: which field to watch */
  field_name?: string;
  /** For lifecycle_changed: which stage transition */
  from_stage?: string;
  to_stage?: string;
}

interface DslActionData {
  action_type: DslActionType;
  params: Record<string, unknown>;
  retry_count?: number;
  timeout_ms?: number;
}

interface DslConditionData {
  condition_type: DslConditionType;
  expression?: string;  // e.g. "{{$json.confidence}} > 0.8"
  /** For switch: map of value → output index */
  cases?: Record<string, number>;
  /** For time_gate: business hours config */
  business_hours?: { start: string; end: string; timezone: string; days: number[] };
  /** For ab_split: percentage for branch 0 (0-100) */
  split_pct?: number;
}

interface DslAiStepData {
  action_type: 'ai_respond' | 'ai_classify' | 'ai_extract';
  ai_agent_id?: string;
  categories?: string[];  // for ai_classify
  schema?: Record<string, string>;  // for ai_extract
  model?: string;
}

// ─── Zod validation schemas ───────────────────────────────────────────────────

export const DslTriggerDataSchema = z.object({
  trigger_type: z.enum([
    'conversation_created', 'message_inbound', 'keyword_match',
    'contact_field_updated', 'lifecycle_changed', 'conversation_assigned',
    'conversation_resolved', 'broadcast_reply', 'ai_handoff',
    'scheduled', 'external_webhook',
  ]),
  keywords: z.array(z.string()).optional(),
  cron: z.string().optional(),
  field_name: z.string().optional(),
  from_stage: z.string().optional(),
  to_stage: z.string().optional(),
});

export const DslActionDataSchema = z.object({
  action_type: z.enum([
    'send_message', 'update_contact', 'assign_conversation', 'add_tag',
    'change_lifecycle', 'close_conversation', 'snooze_conversation',
    'invoke_ai_agent', 'ai_classify', 'ai_extract', 'create_note',
    'http_request', 'wait_delay',
  ]),
  params: z.record(z.unknown()),
  retry_count: z.number().int().min(0).max(10).optional(),
  timeout_ms: z.number().min(1000).max(60000).optional(),
});

export const DslConditionDataSchema = z.object({
  condition_type: z.enum(['if_else', 'switch', 'time_gate', 'ab_split']),
  expression: z.string().optional(),
  cases: z.record(z.number()).optional(),
  business_hours: z.object({
    start: z.string(),
    end: z.string(),
    timezone: z.string(),
    days: z.array(z.number().int().min(0).max(6)),
  }).optional(),
  split_pct: z.number().min(0).max(100).optional(),
});

export const DslAiStepDataSchema = z.object({
  action_type: z.enum(['ai_respond', 'ai_classify', 'ai_extract']),
  ai_agent_id: z.string().uuid().optional(),
  categories: z.array(z.string()).optional(),
  schema: z.record(z.string()).optional(),
  model: z.string().optional(),
});

export const DslNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['trigger', 'action', 'condition', 'ai_step']),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.union([DslTriggerDataSchema, DslActionDataSchema, DslConditionDataSchema, DslAiStepDataSchema]),
});

export const DslEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  label: z.string().optional(),
});

export const DslWorkflowGraphSchema = z.object({
  nodes: z.array(DslNodeSchema).min(1),
  edges: z.array(DslEdgeSchema),
});

/**
 * Validate graph connectivity and trigger count after schema validation.
 * Returns an error message string, or null if the graph is valid.
 */
export function validateGraphConnectivity(graph: DslWorkflowGraph): string | null {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source)) {
      return `Edge source '${edge.source}' references a node that does not exist`;
    }
    if (!nodeIds.has(edge.target)) {
      return `Edge target '${edge.target}' references a node that does not exist`;
    }
  }

  const triggerCount = graph.nodes.filter((n) => n.type === 'trigger').length;
  if (triggerCount === 0) return 'Workflow must have exactly one trigger node';
  if (triggerCount > 1) return 'Workflow cannot have more than one trigger node';

  return null;
}

// ─── Translation constants ────────────────────────────────────────────────────

const PLATFORM_API_BASE = process.env.PLATFORM_API_BASE ?? 'http://workflow:3002';

/** Maps our trigger types to the webhook paths the NATS bridge fires */
const TRIGGER_WEBHOOK_PATHS: Record<DslTriggerType, string> = {
  conversation_created: 'conversation-created',
  message_inbound: 'message-inbound',
  keyword_match: 'keyword-match',
  contact_field_updated: 'contact-updated',
  lifecycle_changed: 'lifecycle-changed',
  conversation_assigned: 'conversation-assigned',
  conversation_resolved: 'conversation-resolved',
  broadcast_reply: 'broadcast-reply',
  ai_handoff: 'ai-handoff',
  scheduled: 'scheduled',
  external_webhook: 'external',
};

/** Maps our action types to platform REST endpoints */
const ACTION_ENDPOINTS: Record<string, string> = {
  send_message: '/api/v1/actions/send-message',
  update_contact: '/api/v1/actions/update-contact',
  assign_conversation: '/api/v1/actions/assign-conversation',
  add_tag: '/api/v1/actions/add-tag',
  change_lifecycle: '/api/v1/actions/change-lifecycle',
  close_conversation: '/api/v1/actions/close-conversation',
  snooze_conversation: '/api/v1/actions/snooze-conversation',
  invoke_ai_agent: '/api/v1/actions/invoke-ai-agent',
  ai_classify: '/api/v1/actions/ai-classify',
  ai_extract: '/api/v1/actions/ai-extract',
  create_note: '/api/v1/actions/create-note',
  http_request: '/api/v1/actions/trigger-webhook',
};

// ─── Main translator ──────────────────────────────────────────────────────────

export interface TranslationContext {
  tenantId: string;
  workflowId: string;
  workflowName: string;
  version: number;
  /** Internal API key for n8n → platform callbacks */
  internalApiKey: string;
}

export function translateWorkflow(
  dsl: DslWorkflowGraph,
  ctx: TranslationContext
): N8nWorkflow {
  const n8nNodes: N8nNode[] = [];
  const connections: N8nConnections = {};

  // Build a map of DSL node id → n8n node name for connection wiring
  const nodeNameMap = new Map<string, string>();

  for (const dslNode of dsl.nodes) {
    const n8nNode = translateNode(dslNode, ctx);
    nodeNameMap.set(dslNode.id, n8nNode.name);
    n8nNodes.push(n8nNode);
  }

  // Build connections
  for (const edge of dsl.edges) {
    const sourceName = nodeNameMap.get(edge.source);
    const targetName = nodeNameMap.get(edge.target);
    if (!sourceName || !targetName) continue;

    const outputIndex = edge.sourceHandle ? Number(edge.sourceHandle) : 0;

    if (!connections[sourceName]) connections[sourceName] = { main: [] };
    const main = connections[sourceName].main!;
    while (main.length <= outputIndex) main.push(null);
    if (!main[outputIndex]) main[outputIndex] = [];
    main[outputIndex]!.push({ node: targetName, type: 'main', index: 0 });
  }

  return {
    name: `[responio] ${ctx.workflowName} (${ctx.tenantId.slice(0, 8)}) v${ctx.version}`,
    active: false, // Activated separately after creation
    nodes: n8nNodes,
    connections,
    tags: [
      { name: `tenant:${ctx.tenantId}` },
      { name: `workflow:${ctx.workflowId}` },
      { name: `version:${ctx.version}` },
    ],
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: false,
      timezone: 'UTC',
    },
  };
}

function translateNode(node: DslNode, ctx: TranslationContext): N8nNode {
  const base = {
    id: randomUUID(),
    position: [node.position.x, node.position.y] as [number, number],
  };

  switch (node.type) {
    case 'trigger':
      return translateTrigger(base, node.data as DslTriggerData, ctx);
    case 'action':
      return translateAction(base, node.data as DslActionData, ctx);
    case 'condition':
      return translateCondition(base, node.data as DslConditionData);
    case 'ai_step':
      return translateAiStep(base, node.data as DslAiStepData, ctx);
    default:
      throw new Error(`Unknown DSL node type: ${(node as DslNode).type}`);
  }
}

function translateTrigger(
  base: Pick<N8nNode, 'id' | 'position'>,
  data: DslTriggerData,
  ctx: TranslationContext
): N8nNode {
  const name = `Trigger: ${data.trigger_type}`;

  if (data.trigger_type === 'scheduled') {
    return {
      ...base,
      name,
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1,
      parameters: {
        rule: {
          interval: [{ field: 'cronExpression', expression: data.cron ?? '0 * * * *' }],
        },
      },
    };
  }

  // All other triggers use webhook (fired by NATS bridge)
  const webhookPath = `${ctx.tenantId}/${TRIGGER_WEBHOOK_PATHS[data.trigger_type]}`;
  const params: Record<string, unknown> = {
    httpMethod: 'POST',
    path: webhookPath,
    responseMode: 'onReceived',
    responseData: 'noData',
  };

  // Keyword match: add a filter node inline via parameters
  if (data.trigger_type === 'keyword_match' && data.keywords?.length) {
    params['options'] = { rawBody: true };
    params['keywords'] = data.keywords;
  }

  return {
    ...base,
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    parameters: params,
  };
}

function translateAction(
  base: Pick<N8nNode, 'id' | 'position'>,
  data: DslActionData,
  ctx: TranslationContext
): N8nNode {
  const name = `Action: ${data.action_type}`;

  if (data.action_type === 'wait_delay') {
    return {
      ...base,
      name,
      type: 'n8n-nodes-base.wait',
      typeVersion: 1,
      parameters: {
        unit: (data.params.unit as string) ?? 'minutes',
        amount: (data.params.amount as number) ?? 5,
      },
    };
  }

  const endpoint = ACTION_ENDPOINTS[data.action_type];
  if (!endpoint) throw new Error(`Unknown action type: ${data.action_type}`);

  return {
    ...base,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    continueOnFail: false,
    retryOnFail: (data.retry_count ?? 0) > 0,
    maxTries: data.retry_count ?? 1,
    waitBetweenTries: 1000,
    parameters: {
      method: 'POST',
      url: `${PLATFORM_API_BASE}${endpoint}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-Internal-API-Key', value: ctx.internalApiKey },
          { name: 'X-Tenant-ID', value: ctx.tenantId },
        ],
      },
      sendBody: true,
      bodyParameters: {
        parameters: Object.entries(data.params).map(([name, value]) => ({ name, value })),
      },
      options: {
        timeout: data.timeout_ms ?? 30000,
        response: { response: { responseFormat: 'json' } },
      },
    },
  };
}

function translateCondition(
  base: Pick<N8nNode, 'id' | 'position'>,
  data: DslConditionData
): N8nNode {
  const name = `Condition: ${data.condition_type}`;

  if (data.condition_type === 'switch') {
    return {
      ...base,
      name,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3,
      parameters: {
        mode: 'expression',
        output: 'single',
        rules: {
          rules: Object.entries(data.cases ?? {}).map(([value, outputIdx]) => ({
            value2: value,
            renameOutput: true,
            outputKey: String(outputIdx),
          })),
        },
      },
    };
  }

  if (data.condition_type === 'time_gate') {
    const bh = data.business_hours ?? { start: '09:00', end: '17:00', timezone: 'UTC', days: [1, 2, 3, 4, 5] };
    return {
      ...base,
      name: `Time Gate: ${bh.start}–${bh.end}`,
      type: 'n8n-nodes-base.dateTime',
      typeVersion: 2,
      parameters: {
        operation: 'isInRange',
        startDate: bh.start,
        endDate: bh.end,
        timezone: bh.timezone,
      },
    };
  }

  if (data.condition_type === 'ab_split') {
    return {
      ...base,
      name: `A/B Split ${data.split_pct ?? 50}%`,
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      parameters: {
        batchSize: 1,
        options: {},
      },
    };
  }

  // Default: if/else
  return {
    ...base,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: randomUUID(),
            leftValue: `={{ ${data.expression ?? 'true'} }}`,
            rightValue: 'true',
            operator: { type: 'boolean', operation: 'equal' },
          },
        ],
        combinator: 'and',
      },
    },
  };
}

function translateAiStep(
  base: Pick<N8nNode, 'id' | 'position'>,
  data: DslAiStepData,
  ctx: TranslationContext
): N8nNode {
  const actionType = data.action_type === 'ai_respond'
    ? 'invoke_ai_agent'
    : data.action_type === 'ai_classify'
    ? 'ai_classify'
    : 'ai_extract';

  const endpoint = ACTION_ENDPOINTS[actionType];
  const params: Record<string, unknown> = {};

  if (data.action_type === 'ai_respond' && data.ai_agent_id) {
    params['ai_agent_id'] = data.ai_agent_id;
    params['conversation_id'] = '={{ $json.conversation_id }}';
  } else if (data.action_type === 'ai_classify') {
    params['text'] = '={{ $json.content }}';
    params['categories'] = data.categories ?? [];
    if (data.model) params['model'] = data.model;
  } else if (data.action_type === 'ai_extract') {
    params['text'] = '={{ $json.content }}';
    params['schema'] = data.schema ?? {};
    if (data.model) params['model'] = data.model;
  }

  return {
    ...base,
    name: `AI: ${data.action_type}`,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4,
    parameters: {
      method: 'POST',
      url: `${PLATFORM_API_BASE}${endpoint}`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-Internal-API-Key', value: ctx.internalApiKey },
          { name: 'X-Tenant-ID', value: ctx.tenantId },
        ],
      },
      sendBody: true,
      bodyParameters: {
        parameters: Object.entries(params).map(([name, value]) => ({ name, value })),
      },
      options: { timeout: 60000 },
    },
  };
}
