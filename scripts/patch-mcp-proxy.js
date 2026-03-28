#!/usr/bin/env node
/**
 * Patches mcp-proxy to auto-initialize MCP servers in stateless mode.
 *
 * Problem: In stateless mode, non-init requests (tools/list, etc.) create a
 * new MCP Server that hasn't been initialized, so the SDK rejects them with 400.
 *
 * Fix: Before handling the actual request, send a synthetic initialize through
 * a dummy response to warm up the server, then handle the real request.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpProxyPath = resolve(__dirname, '../node_modules/mcp-proxy/dist/stdio-DQCs94rj.js');

const original = readFileSync(mcpProxyPath, 'utf-8');

// The code we want to patch: the stateless non-init path
const searchStr = `server.connect(transport);
				if (onConnect) await onConnect(server);
				await transport.handleRequest(req, res, body);
				return true;
			} else {
				res.setHeader("Content-Type", "application/json");
				res.writeHead(400).end(createJsonRpcErrorResponse(-32e3, "Bad Request: No valid session ID provided"));`;

const replaceStr = `server.connect(transport);
				if (onConnect) await onConnect(server);
				// AUTO-INIT PATCH: Send synthetic initialize before the actual request
				const _initBody = {jsonrpc:"2.0",id:"_auto_init_",method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"stateless-auto",version:"1.0"}}};
				const _dummyRes = new (await import("stream")).PassThrough();
				_dummyRes.setHeader = () => _dummyRes;
				_dummyRes.writeHead = () => _dummyRes;
				_dummyRes.flushHeaders = () => {};
				_dummyRes.headersSent = false;
				Object.defineProperty(_dummyRes, 'headersSent', { get: () => false, set: () => {} });
				try { await transport.handleRequest(req, _dummyRes, _initBody); } catch(_e) { /* init errors are non-fatal */ }
				await transport.handleRequest(req, res, body);
				return true;
			} else {
				res.setHeader("Content-Type", "application/json");
				res.writeHead(400).end(createJsonRpcErrorResponse(-32e3, "Bad Request: No valid session ID provided"));`;

if (!original.includes(searchStr)) {
  // Try a more flexible search
  console.error('PATCH FAILED: Could not find target code in mcp-proxy. The file may have been updated.');
  console.error('Searching for alternative patterns...');

  // Check if already patched
  if (original.includes('_auto_init_')) {
    console.log('PATCH: Already applied.');
    process.exit(0);
  }

  process.exit(1);
}

const patched = original.replace(searchStr, replaceStr);
writeFileSync(mcpProxyPath, patched, 'utf-8');
console.log('PATCH: Successfully patched mcp-proxy for stateless auto-init.');
