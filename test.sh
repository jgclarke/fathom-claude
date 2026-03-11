#!/usr/bin/env bash
# Local MCP test script.
# Usage: FATHOM_KEY=your_key ./test.sh [tool] [args_json]
#
# Prerequisites: wrangler dev must be running in another terminal:
#   npm run dev
#
# Examples:
#   FATHOM_KEY=xxx ./test.sh
#   FATHOM_KEY=xxx ./test.sh list_meetings
#   FATHOM_KEY=xxx ./test.sh list_meetings '{"query":"acme","limit":5}'
#   FATHOM_KEY=xxx ./test.sh get_transcript '{"recording_id":"abc123"}'
#   FATHOM_KEY=xxx ./test.sh get_summary '{"recording_id":"abc123"}'

set -euo pipefail

BASE="http://localhost:8787/mcp"
KEY="${FATHOM_KEY:?Set FATHOM_KEY=your_fathom_api_key}"
TOOL="${1:-}"
ARGS="${2:-{}}"

mcp_call() {
  local method="$1"
  local params_json="$2"
  # Use jq to safely construct the body — avoids shell quoting issues
  local body
  body=$(jq -n \
    --arg method "$method" \
    --argjson params "$params_json" \
    '{"jsonrpc":"2.0","id":1,"method":$method,"params":$params}')
  echo "Sending: $body" >&2
  curl -s -X POST "$BASE" \
    -H "Content-Type: application/json" \
    -H "X-Fathom-Key: $KEY" \
    -d "$body" \
    | jq .
}

echo "=== initialize ==="
mcp_call "initialize" '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}'

echo ""
echo "=== tools/list ==="
mcp_call "tools/list" '{}'

if [[ -n "$TOOL" ]]; then
  echo ""
  echo "=== tools/call: $TOOL ==="
  # Use jq to build the params object safely
  tool_params=$(jq -n --arg name "$TOOL" --argjson args "$ARGS" \
    '{"name":$name,"arguments":$args}')
  mcp_call "tools/call" "$tool_params"
fi
