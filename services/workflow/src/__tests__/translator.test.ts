/**
 * Unit tests for the DSL → n8n JSON translator.
 */

import { describe, it, expect } from 'vitest';
import { translateWorkflow, type DslWorkflowGraph } from '../n8n/translator';

const CTX = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  workflowId: '22222222-2222-2222-2222-222222222222',
  workflowName: 'Test Workflow',
  version: 1,
  internalApiKey: 'test-api-key',
};

describe('translateWorkflow', () => {
  it('names the workflow with tenant prefix', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { trigger_type: 'conversation_created' },
        },
      ],
      edges: [],
    };

    const result = translateWorkflow(dsl, CTX);

    expect(result.name).toContain('[responio]');
    expect(result.name).toContain('Test Workflow');
    expect(result.name).toContain('11111111'); // tenant prefix
    expect(result.name).toContain('v1');
  });

  it('sets workflow as inactive initially', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger_type: 'message_inbound' } },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    expect(result.active).toBe(false);
  });

  it('adds tenant/workflow/version tags', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger_type: 'message_inbound' } },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    const tagNames = result.tags?.map((t) => t.name) ?? [];
    expect(tagNames).toContain(`tenant:${CTX.tenantId}`);
    expect(tagNames).toContain(`workflow:${CTX.workflowId}`);
    expect(tagNames).toContain('version:1');
  });

  it('translates webhook trigger', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'trigger',
          position: { x: 100, y: 100 },
          data: { trigger_type: 'conversation_created' },
        },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    const node = result.nodes[0];

    expect(node.type).toBe('n8n-nodes-base.webhook');
    expect(node.parameters['httpMethod']).toBe('POST');
    expect(node.parameters['path']).toBe(`${CTX.tenantId}/conversation-created`);
  });

  it('translates scheduled trigger', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { trigger_type: 'scheduled', cron: '0 9 * * 1-5' },
        },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    const node = result.nodes[0];

    expect(node.type).toBe('n8n-nodes-base.scheduleTrigger');
  });

  it('translates send_message action with platform endpoint', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'trigger',
          position: { x: 0, y: 0 },
          data: { trigger_type: 'message_inbound' },
        },
        {
          id: 'n2',
          type: 'action',
          position: { x: 300, y: 0 },
          data: { action_type: 'send_message', params: { content: 'Hello!', content_type: 'text' } },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };

    const result = translateWorkflow(dsl, CTX);
    const actionNode = result.nodes.find((n) => n.name.startsWith('Action:'));

    expect(actionNode).toBeDefined();
    expect(actionNode!.type).toBe('n8n-nodes-base.httpRequest');
    expect(actionNode!.parameters['url']).toContain('/api/v1/actions/send-message');
    expect(actionNode!.parameters['method']).toBe('POST');
  });

  it('translates wait_delay action', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'action',
          position: { x: 0, y: 0 },
          data: { action_type: 'wait_delay', params: { unit: 'minutes', amount: 30 } },
        },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    const node = result.nodes[0];

    expect(node.type).toBe('n8n-nodes-base.wait');
    expect(node.parameters['unit']).toBe('minutes');
    expect(node.parameters['amount']).toBe(30);
  });

  it('translates if/else condition', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'condition',
          position: { x: 0, y: 0 },
          data: { condition_type: 'if_else', expression: '$json.confidence > 0.8' },
        },
      ],
      edges: [],
    };
    const result = translateWorkflow(dsl, CTX);
    const node = result.nodes[0];

    expect(node.type).toBe('n8n-nodes-base.if');
  });

  it('wires edges into connections', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger_type: 'message_inbound' } },
        {
          id: 'n2',
          type: 'action',
          position: { x: 300, y: 0 },
          data: { action_type: 'send_message', params: { content: 'Hi' } },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };

    const result = translateWorkflow(dsl, CTX);
    const connections = result.connections;

    // Find the trigger node's name
    const triggerNode = result.nodes.find((n) => n.name.startsWith('Trigger:'));
    const actionNode = result.nodes.find((n) => n.name.startsWith('Action:'));

    expect(triggerNode).toBeDefined();
    expect(actionNode).toBeDefined();

    const conn = connections[triggerNode!.name];
    expect(conn).toBeDefined();
    expect(conn.main?.[0]?.[0]?.node).toBe(actionNode!.name);
  });

  it('throws on unknown action type', () => {
    const dsl: DslWorkflowGraph = {
      nodes: [
        {
          id: 'n1',
          type: 'action',
          position: { x: 0, y: 0 },
          // @ts-expect-error — testing bad input
          data: { action_type: 'nonexistent_action', params: {} },
        },
      ],
      edges: [],
    };

    expect(() => translateWorkflow(dsl, CTX)).toThrow('Unknown action type');
  });
});
