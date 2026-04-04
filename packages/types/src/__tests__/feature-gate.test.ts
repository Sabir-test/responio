/**
 * Tests for PLAN_FEATURES feature gate map.
 * Verifies that each plan tier gates the correct features.
 */

import { describe, it, expect } from 'vitest';
import { PLAN_FEATURES } from '../features';

describe('PLAN_FEATURES — starter plan', () => {
  const starter = PLAN_FEATURES['starter'];

  it('blocks workflows', () => expect(starter.workflows).toBe(false));
  it('blocks broadcasts', () => expect(starter.broadcasts).toBe(false));
  it('blocks ai_agents', () => expect(starter.ai_agents).toBe(false));
  it('blocks http_in_workflows', () => expect(starter.http_in_workflows).toBe(false));
  it('blocks voice_ai', () => expect(starter.voice_ai).toBe(false));
  it('blocks multi_workspace', () => expect(starter.multi_workspace).toBe(false));
  it('blocks sso', () => expect(starter.sso).toBe(false));
});

describe('PLAN_FEATURES — growth plan', () => {
  const growth = PLAN_FEATURES['growth'];

  it('allows workflows', () => expect(growth.workflows).toBe(true));
  it('allows broadcasts', () => expect(growth.broadcasts).toBe(true));
  it('allows ai_agents', () => expect(growth.ai_agents).toBe(true));
  it('blocks http_in_workflows', () => expect(growth.http_in_workflows).toBe(false));
  it('blocks voice_ai', () => expect(growth.voice_ai).toBe(false));
  it('blocks multi_workspace', () => expect(growth.multi_workspace).toBe(false));
});

describe('PLAN_FEATURES — advanced plan', () => {
  const advanced = PLAN_FEATURES['advanced'];

  it('allows http_in_workflows', () => expect(advanced.http_in_workflows).toBe(true));
  it('allows voice_ai', () => expect(advanced.voice_ai).toBe(true));
  it('allows multi_workspace', () => expect(advanced.multi_workspace).toBe(true));
  it('allows sso', () => expect(advanced.sso).toBe(true));
  it('allows custom_channels', () => expect(advanced.custom_channels).toBe(true));
});

describe('PLAN_FEATURES — enterprise plan', () => {
  const enterprise = PLAN_FEATURES['enterprise'];

  it('allows all features', () => {
    for (const [key, value] of Object.entries(enterprise)) {
      expect(value, `enterprise.${key} should be true`).toBe(true);
    }
  });
});

describe('PLAN_FEATURES — unknown plan tier', () => {
  it('returns undefined for unknown tier (caller should default to starter)', () => {
    expect(PLAN_FEATURES['unknown_tier']).toBeUndefined();
  });
});
