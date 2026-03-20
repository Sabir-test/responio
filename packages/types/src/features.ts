/**
 * Feature flags by plan tier.
 * Used for gating features in services and UI.
 */

export interface FeatureFlags {
  ai_agents: boolean;
  workflows: boolean;
  broadcasts: boolean;
  voice_ai: boolean;
  multi_workspace: boolean;
  sso: boolean;
  http_in_workflows: boolean;
  custom_channels: boolean;
  advanced_reports: boolean;
  mac_metering: boolean;
}

export const PLAN_FEATURES: Record<string, FeatureFlags> = {
  starter: {
    ai_agents: false,
    workflows: false,
    broadcasts: false,
    voice_ai: false,
    multi_workspace: false,
    sso: false,
    http_in_workflows: false,
    custom_channels: false,
    advanced_reports: false,
    mac_metering: false,
  },
  growth: {
    ai_agents: true,
    workflows: true,
    broadcasts: true,
    voice_ai: false,
    multi_workspace: false,
    sso: false,
    http_in_workflows: false,
    custom_channels: false,
    advanced_reports: true,
    mac_metering: true,
  },
  advanced: {
    ai_agents: true,
    workflows: true,
    broadcasts: true,
    voice_ai: true,
    multi_workspace: true,
    sso: true,
    http_in_workflows: true,
    custom_channels: true,
    advanced_reports: true,
    mac_metering: true,
  },
  enterprise: {
    ai_agents: true,
    workflows: true,
    broadcasts: true,
    voice_ai: true,
    multi_workspace: true,
    sso: true,
    http_in_workflows: true,
    custom_channels: true,
    advanced_reports: true,
    mac_metering: true,
  },
};
