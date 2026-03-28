#!/usr/bin/env node

// src/index.ts
//
// Single entry point for the Google Docs MCP Server.
//
// Usage:
//   @a-bonus/google-docs-mcp          Start the MCP server (default, stdio)
//   @a-bonus/google-docs-mcp auth     Run the interactive OAuth flow
//
// Remote mode (env vars):
//   MCP_TRANSPORT=httpStream           Use Streamable HTTP instead of stdio (GoogleProvider auth)
//   MCP_TRANSPORT=http                 Use HTTP mode with OAuth proxy
//   BASE_URL=https://...               Public URL for OAuth redirects
//   ALLOWED_DOMAINS=scio.cz,...        Restrict to specific Google Workspace domains

import { FastMCP, GoogleProvider } from 'fastmcp';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildCachedToolsListPayload,
  collectToolsWhileRegistering,
  installCachedToolsListHandler,
} from './cachedToolsList.js';
import { initializeGoogleClient } from './clients.js';
import { registerAllTools } from './tools/index.js';
import { wrapServerForRemote } from './remoteWrapper.js';
import { registerLandingPage } from './landingPage.js';
import { FirestoreTokenStorage } from './firestoreTokenStorage.js';
import { logger } from './logger.js';
import { config } from './config.js';

// Per-request auth context for remote/HTTP mode
export const authStore = new AsyncLocalStorage<{ accessToken: string }>();

// --- Auth subcommand ---
if (process.argv[2] === 'auth') {
  const { runAuthFlow } = await import('./auth.js');
  try {
    await runAuthFlow();
    logger.info('Authorization complete. You can now start the MCP server.');
    process.exit(0);
  } catch (error: any) {
    logger.error('Authorization failed:', error.message || error);
    process.exit(1);
  }
}

// --- Server startup ---

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

const isRemote = process.env.MCP_TRANSPORT === 'httpStream';
const isHttpMode = config.transport === 'http' || process.env.FASTMCP_TRANSPORT === 'http-stream';

// Build server options based on mode
const serverOptions: ConstructorParameters<typeof FastMCP>[0] = {
  name: 'Ultimate Google Docs & Sheets MCP Server',
  version: '1.0.0',
};

if (isRemote) {
  // Native MCP OAuth 2.1 via GoogleProvider (upstream)
  const missing = ['BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    logger.error(`FATAL: Missing required env vars for httpStream mode: ${missing.join(', ')}`);
    process.exit(1);
  }

  serverOptions.auth = new GoogleProvider({
    allowedRedirectUriPatterns: ['http://localhost:*', `${process.env.BASE_URL}/*`, 'cursor://*'],
    baseUrl: process.env.BASE_URL!,
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/script.external_request',
    ],
    ...(process.env.JWT_SIGNING_KEY && { jwtSigningKey: process.env.JWT_SIGNING_KEY }),
    ...(process.env.REFRESH_TOKEN_TTL && {
      refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL),
    }),
    ...(process.env.TOKEN_STORE === 'firestore' && {
      tokenStorage: new FirestoreTokenStorage(process.env.GCLOUD_PROJECT),
    }),
  });
} else if (isHttpMode) {
  // OAuth proxy mode for Claude.ai remote connector
  const { OAuthProxy } = await import('fastmcp/auth');

  if (!config.oauthClientId || !config.oauthClientSecret) {
    logger.error(
      'FATAL: HTTP mode requires GOOGLE_DOCS_MCP_OAUTH_CLIENT_ID and GOOGLE_DOCS_MCP_OAUTH_CLIENT_SECRET'
    );
    process.exit(1);
  }

  if (!config.serverUrl) {
    logger.error('FATAL: HTTP mode requires GOOGLE_DOCS_MCP_SERVER_URL');
    process.exit(1);
  }

  const googleScopes = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ];

  const proxy = new OAuthProxy({
    baseUrl: config.serverUrl,
    upstreamClientId: config.oauthClientId,
    upstreamClientSecret: config.oauthClientSecret,
    upstreamAuthorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    upstreamTokenEndpoint: 'https://oauth2.googleapis.com/token',
    consentRequired: false,
    scopes: googleScopes,
    enableTokenSwap: true,
    jwtSigningKey: config.jwtSigningKey || undefined,
  });

  // Wrap authorize() to force Google scopes — Claude sends "claudeai" scope
  // which Google doesn't recognize. We always replace with our Google scopes.
  const originalAuthorize = proxy.authorize.bind(proxy);
  (proxy as any).authorize = async (params: any) => {
    params.scope = googleScopes.join(' ');
    return originalAuthorize(params);
  };

  serverOptions.authenticate = async (request: import('http').IncomingMessage) => {
    logger.info(`[AUTH] ${request.method} ${request.url} session=${request.headers['mcp-session-id'] || 'NONE'} auth=${request.headers.authorization ? 'Bearer ...' : 'NONE'} proto=${request.headers['mcp-protocol-version'] || 'NONE'} accept=${request.headers.accept || 'NONE'}`);
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Unauthorized: missing or invalid bearer token');
    }
    const fastmcpJwt = authHeader.slice(7);
    const upstreamTokens = await proxy.loadUpstreamTokens(fastmcpJwt);
    if (!upstreamTokens) {
      throw new Error('Could not resolve upstream tokens - token may be expired');
    }
    // Thread the access token through AsyncLocalStorage for per-request auth
    authStore.enterWith({ accessToken: upstreamTokens.accessToken });
    return { accessToken: upstreamTokens.accessToken };
  };

  serverOptions.oauth = {
    enabled: true,
    proxy,
    authorizationServer: {
      issuer: config.serverUrl,
      authorizationEndpoint: `${config.serverUrl}/oauth/authorize`,
      tokenEndpoint: `${config.serverUrl}/oauth/token`,
      registrationEndpoint: `${config.serverUrl}/oauth/register`,
      responseTypesSupported: ['code'],
      grantTypesSupported: ['authorization_code', 'refresh_token'],
      codeChallengeMethodsSupported: ['S256'],
      tokenEndpointAuthMethodsSupported: ['client_secret_post'],
      scopesSupported: googleScopes,
    },
    protectedResource: {
      resource: config.serverUrl,
      authorizationServers: [config.serverUrl],
    },
  };
}

const server = new FastMCP(serverOptions);

const registeredTools: Parameters<FastMCP['addTool']>[0][] = [];
collectToolsWhileRegistering(server, registeredTools);
if (isRemote) wrapServerForRemote(server);
registerAllTools(server);

try {
  if (isRemote) {
    logger.info('Starting in remote mode (httpStream + MCP OAuth 2.1)...');
    registerLandingPage(server, registeredTools.length);

    const port = parseInt(process.env.PORT || '8080');
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port,
        host: '0.0.0.0',
      },
    });

    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info(`MCP Server running at ${process.env.BASE_URL || `http://0.0.0.0:${port}`}/mcp`);
  } else if (isHttpMode) {
    await initializeGoogleClient();
    logger.info('Starting Google Docs & Sheets MCP server in HTTP mode...');

    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);

    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port: config.port,
        host: config.host,
        stateless: true,
        enableJsonResponse: true,
      },
    });
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info(
      `MCP Server running on http://${config.host}:${config.port}/mcp (HTTP stream, stateless+JSON)`
    );
  } else {
    await initializeGoogleClient();
    logger.info('Starting Ultimate Google Docs & Sheets MCP server...');

    const cachedToolsList = await buildCachedToolsListPayload(registeredTools);
    await server.start({ transportType: 'stdio' as const });
    installCachedToolsListHandler(server, cachedToolsList);
    logger.info('MCP Server running using stdio. Awaiting client connection...');
  }

  logger.info('Process-level error handling configured to prevent crashes from timeout errors.');
} catch (startError: any) {
  logger.error('FATAL: Server failed to start:', startError.message || startError);
  process.exit(1);
}
