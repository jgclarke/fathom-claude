#!/usr/bin/env bash
# Local MCP test script.
# Usage: FATHOM_KEY=your_key ./test.sh [tool] [args]
#
# Prerequisites: wrangler dev must be running in another terminal:
#   npm run dev
#
# Simple named-arg form (recommended — avoids JSON quoting issues):
#   FATHOM_KEY=xxx ./test.sh list_meetings
#   FATHOM_KEY=xxx ./test.sh list_meetings --query "National Catholic Reporter"
#   FATHOM_KEY=xxx ./test.sh list_meetings --query "acme" --limit 5
#   FATHOM_KEY=xxx ./test.sh list_meetings --after 2025-01-01 --before 2025-03-31
#   FATHOM_KEY=xxx ./test.sh get_transcript --id abc123
#   FATHOM_KEY=xxx ./test.sh get_summary --id abc123
#
# Raw JSON form:
#   FATHOM_KEY=xxx ./test.sh list_meetings '{"limit":5}'

set -euo pipefail

BASE="http://localhost:8787/mcp"
KEY="${FATHOM_KEY:?Set FATHOM_KEY=your_fathom_api_key}"
TOOL="${1:-}"
shift || true

# Parse remaining args: either a single JSON blob or named flags
ARGS='{}'
if [[ $# -gt 0 ]]; then
  first="$1"
  if [[ "$first" == --* ]]; then
    # Named-flag mode: build JSON from --key value pairs
    ARGS=$(node -e "
      const argv = process.argv.slice(1);
      const obj = {};
      for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        const val = argv[i+1];
        // Map short names to API field names
        const fieldMap = { id: 'recording_id', after: 'created_after', before: 'created_before' };
        const field = fieldMap[key] || key;
        // Coerce numeric values
        obj[field] = isNaN(val) ? val : Number(val);
      }
      console.log(JSON.stringify(obj));
    " -- "$@")
  else
    # Raw JSON — strip control characters that sneak in via copy-paste
    ARGS=$(printf '%s' "$first" | tr -d '\n\r\t')
  fi
fi

# Use node for JSON construction — avoids jq --argjson quirks
make_body() {
  node -e "
    const method = process.argv[1];
    const params = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));
  " "$1" "$2"
}

mcp_call() {
  local method="$1"
  local params_json="$2"
  local body
  body=$(make_body "$method" "$params_json")
  echo "Sending: $(echo "$body" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.stringify(JSON.parse(d),null,2))")" >&2
  curl -s --max-time 30 -X POST "$BASE" \
    -H "Content-Type: application/json" \
    -H "X-Fathom-Key: $KEY" \
    -d "$body" \
    | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.stringify(JSON.parse(d),null,2))"
}

echo "=== initialize ==="
mcp_call "initialize" '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}'

echo ""
echo "=== tools/list ==="
mcp_call "tools/list" '{}'

if [[ -n "$TOOL" ]]; then
  echo ""
  echo "=== tools/call: $TOOL ==="
  tool_params=$(node -e "
    const name = process.argv[1];
    const args = JSON.parse(process.argv[2]);
    console.log(JSON.stringify({name, arguments:args}));
  " "$TOOL" "$ARGS")
  mcp_call "tools/call" "$tool_params"
fi
