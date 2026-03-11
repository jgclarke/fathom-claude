# Fathom MCP Server

A remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude to your Fathom meeting recordings. Add it as a connector on claude.ai and ask Claude to pull transcripts, summaries, and action items from your meetings directly.

Runs on Cloudflare Workers + KV. Free tier is sufficient for normal usage.

---

## For team members: adding the connector to Claude

### Step 1: Get your Fathom API key

1. Go to [Fathom](https://fathom.video) and sign in
2. Click your avatar → **Settings** → **API Access**
3. Click **Generate API Key** and copy it

Your API key only accesses meetings recorded by you or shared with your team.

### Step 2: Add the connector on claude.ai

1. Go to **Settings → Connectors**
2. Click **Add custom connector**
3. Enter the Worker URL (ask your admin — not published in this README):
   ```
   https://YOUR-WORKER-SUBDOMAIN.workers.dev/mcp
   ```
4. Click **Add** — Claude will redirect you to a Fathom key entry form
5. Enter your Fathom API key and click **Connect**
6. Claude will confirm the connection

That's it. Your key is validated against Fathom before being stored, so you'll know immediately if something is wrong.

### Step 3: Try it

Ask Claude something like:

- _"List my recent Fathom meetings"_
- _"Get the transcript from my last call with acme.com"_
- _"Summarize the action items from my meeting with John on March 4th"_
- _"Search for meetings with sarah@prospect.com"_

### Revoking access

To disconnect Claude from your Fathom account, go to **Settings → Connectors** on claude.ai and remove the Fathom connector. Your token is deleted from the server.

---

## Available tools

| Tool | What it does |
|------|-------------|
| `list_meetings` | List your meetings, optionally filtered by date range or attendee email/domain |
| `search_meetings` | Search for meetings by attendee name, email, or company domain |
| `get_transcript` | Get the full speaker-labeled, timestamped transcript for a recording |
| `get_summary` | Get Fathom's AI-generated summary and action items for a recording |

---

## Security

- **OAuth 2.0 with PKCE.** Authentication follows the standard authorization code flow. PKCE prevents auth code interception attacks.
- **Fathom API keys are validated before storage.** An invalid key is rejected at the form — it is never stored.
- **Tokens are 256-bit random values** stored in Cloudflare KV. They are not guessable or derivable from any public information.
- **Fathom API keys are encrypted at rest** in KV using AES-256-GCM. The encryption key is stored as a Wrangler secret, separate from the data it protects.
- **Auth codes are single-use and expire in 5 minutes.** They are deleted only after PKCE verification succeeds.
- **Access tokens expire after 30 days.** Users can revoke them at any time via Claude's connector settings.
- **The Worker URL is not published in this README.** Distribute it privately to reduce the attack surface.
- **All input is validated** before being forwarded to Fathom's API.
- **Upstream error bodies are discarded.** Only safe, normalized error messages are returned to Claude.
- **CORS is restricted.** OAuth endpoints accept `claude.ai` only. MCP endpoints are server-to-server only.

---

## For whoever deploys this

### Prerequisites

- [Node.js](https://nodejs.org) 18 or higher
- A [Cloudflare account](https://cloudflare.com) (free)

### Step 1: Create a KV namespace

In the [Cloudflare dashboard](https://dash.cloudflare.com):

1. Go to **Workers & Pages → KV**
2. Click **Create namespace**
3. Name it `fathom-mcp-tokens` (or anything you like)
4. Copy the **Namespace ID**

### Step 2: Configure your KV namespace IDs

`wrangler.toml` contains placeholder values and is safe to commit. Your real namespace IDs go in a local file that is gitignored:

```bash
cp wrangler.local.toml.example wrangler.local.toml   # if the example exists
# or create wrangler.local.toml manually (see below)
```

Create `wrangler.local.toml` in the repo root (it is gitignored — never commit it):

```toml
name = "fathom-mcp"
main = "src/index.ts"
compatibility_date = "2025-03-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[kv_namespaces]]
binding = "FATHOM_KV"
id = "your-production-namespace-id"
preview_id = "your-preview-namespace-id"
```

For a preview namespace (used by `npm run dev`), create a second namespace in the Cloudflare dashboard named `fathom-mcp-tokens-preview` and paste its ID as `preview_id`.

### Step 3: Set the encryption key secret

Fathom API keys are encrypted at rest in KV using AES-256-GCM. Generate a key and store it as a Wrangler secret:

```bash
openssl rand -hex 32 | wrangler secret put KV_ENCRYPTION_KEY
```

This only needs to be done once. The key never appears in wrangler.toml or the repo.

For local dev, add the key to `.dev.vars` (gitignored):

```
KV_ENCRYPTION_KEY=<output of openssl rand -hex 32>
```

### Step 4: Deploy

```bash
npm install
npx wrangler deploy --config wrangler.local.toml
```

Wrangler will output your Worker URL. Share it privately with team members — do not put it in this README.

### Rate limiting

The `/oauth/authorize` form submission makes an outbound call to Fathom to validate each API key. Add a Cloudflare zone-level rate limiting rule to prevent abuse:

- **Path:** `/oauth/authorize`
- **Method:** POST
- **Threshold:** 5 requests per IP per 10 minutes
- **Action:** Block

This requires no code changes — configure it in **Security → WAF → Rate limiting rules** in the Cloudflare dashboard.

### Testing locally

```bash
npm run dev
```

This uses the `preview_id` from `wrangler.local.toml` and `KV_ENCRYPTION_KEY` from `.dev.vars`. The automated test suite (`npm test`) runs against an in-memory KV and does not require a live Cloudflare namespace.

### Rotating / revoking tokens

Individual tokens can be deleted from **Workers & Pages → KV → fathom-mcp-tokens** in the Cloudflare dashboard. Keys are prefixed `token:`.

To invalidate all tokens at once (e.g. security incident), delete all keys in the KV namespace. All users will need to re-authenticate.

### Updating

```bash
git pull
npm run deploy
```

Zero-downtime. Existing tokens continue to work after redeploy.

---

## Troubleshooting

**"That API key wasn't accepted"** — Check the key in Fathom Settings → API Access. Regenerate if needed.

**"Unauthorized"** in Claude — Your token may have expired (30 days) or been revoked. Remove and re-add the connector.

**Connector shows as disconnected** — Remove and re-add the connector in Claude Settings.

---

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com) — serverless hosting
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — token storage
- [Fathom API](https://developers.fathom.ai) — meeting data source
- [Model Context Protocol](https://modelcontextprotocol.io) — Claude integration standard

---

## Contributing

PRs welcome. The entire server is in `src/index.ts`. To add a new tool:

1. Add a definition to the `TOOLS` array
2. Add a handler function `handleYourTool()`
3. Add a `case` in the `tools/call` switch statement
