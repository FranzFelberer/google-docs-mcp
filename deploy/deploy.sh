#!/usr/bin/env bash
#
# Deploy geminicap-docs-mcp to Cloud Run
#
# Usage:
#   ./deploy/deploy.sh          # Deploy to production
#
set -euo pipefail

PROJECT_ID="invoice-handling-473908"
REGION="europe-west1"
SERVICE_NAME="geminicap-docs-mcp"
REPO="europe-west1-docker.pkg.dev/${PROJECT_ID}/geminicap-docs-mcp"
IMAGE="${REPO}/server"
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "=== Deploying ${SERVICE_NAME} (commit: ${GIT_COMMIT}) ==="

# 1. Build with Cloud Build
echo "--- Building image ---"
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --substitutions="SHORT_SHA=${GIT_COMMIT}" \
  .

# 2. Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"

# Get the service URL (if already deployed) for SERVER_URL env var
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)' 2>/dev/null || echo "")

if [ -z "${SERVICE_URL}" ]; then
  echo "WARNING: First deploy — SERVER_URL unknown. Deploy once, then run again."
  echo "You can also set SERVICE_URL env var manually before running."
fi

# Secrets mapping:
#   invoice-mcp-oauth-client-id     → reused from invoice-match-mcp
#   invoice-mcp-oauth-client-secret → reused from invoice-match-mcp
#   dwd-sa-key-json                 → reused DWD service account
#   google-docs-mcp-jwt-signing-key → new, for JWT token signing
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}:${GIT_COMMIT}" \
  --set-secrets="\
GOOGLE_DOCS_MCP_OAUTH_CLIENT_ID=invoice-mcp-oauth-client-id:latest,\
GOOGLE_DOCS_MCP_OAUTH_CLIENT_SECRET=invoice-mcp-oauth-client-secret:latest,\
GOOGLE_DOCS_MCP_SA_KEY_JSON=dwd-sa-key-json:latest,\
GOOGLE_DOCS_MCP_JWT_SIGNING_KEY=google-docs-mcp-jwt-signing-key:latest" \
  --set-env-vars="\
MCP_TRANSPORT=http,\
GOOGLE_IMPERSONATE_USER=franz@geminicap.co,\
GOOGLE_DOCS_MCP_SERVER_URL=${SERVICE_URL},\
NODE_ENV=production" \
  --allow-unauthenticated \
  --memory=512Mi \
  --cpu=1 \
  --port=8080 \
  --min-instances=1 \
  --max-instances=2 \
  --timeout=300

# 3. Update SERVER_URL if this is a first deploy
NEW_SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)')

if [ "${SERVICE_URL}" != "${NEW_SERVICE_URL}" ] || [ -z "${SERVICE_URL}" ]; then
  echo "--- Updating SERVER_URL to ${NEW_SERVICE_URL} ---"
  gcloud run services update "${SERVICE_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --update-env-vars="GOOGLE_DOCS_MCP_SERVER_URL=${NEW_SERVICE_URL}"
fi

echo ""
echo "=== Deployed successfully ==="
echo "Service URL: ${NEW_SERVICE_URL}"
echo "MCP endpoint: ${NEW_SERVICE_URL}/mcp"
echo "Health check: ${NEW_SERVICE_URL}/health"
echo "OAuth metadata: ${NEW_SERVICE_URL}/.well-known/oauth-authorization-server"
echo ""
echo "NOTE: Add ${NEW_SERVICE_URL}/oauth/callback as an authorized redirect URI"
echo "      in the Google Cloud Console OAuth client configuration."
