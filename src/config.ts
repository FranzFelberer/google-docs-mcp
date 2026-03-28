// src/config.ts
//
// Centralized configuration from environment variables.
// All remote-deployment settings use the GOOGLE_DOCS_MCP_ prefix.

export const config = {
  // Transport
  transport: (process.env.MCP_TRANSPORT || 'stdio') as 'http' | 'stdio',
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',

  // OAuth (for remote MCP connector)
  oauthClientId: process.env.GOOGLE_DOCS_MCP_OAUTH_CLIENT_ID || '',
  oauthClientSecret: process.env.GOOGLE_DOCS_MCP_OAUTH_CLIENT_SECRET || '',
  jwtSigningKey: process.env.GOOGLE_DOCS_MCP_JWT_SIGNING_KEY || '',
  serverUrl: process.env.GOOGLE_DOCS_MCP_SERVER_URL || '',

  // Google service account (for DWD — Domain-Wide Delegation)
  serviceAccountJson: process.env.GOOGLE_DOCS_MCP_SA_KEY_JSON || '',
  serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || '',
  impersonateUser: process.env.GOOGLE_IMPERSONATE_USER || '',

  // OAuth consent
  consentRequired: process.env.GOOGLE_DOCS_MCP_CONSENT_REQUIRED === 'true',
} as const;
