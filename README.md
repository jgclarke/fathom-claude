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
- **Auth codes are single-use and expire in 5 minutes.** They are deleted immediately upon exchange.
- **Access tokens expire after 90 days.** Users can revoke them at any time via Claude's connector settings.
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

### Step 2: Add the KV ID to wrangler.toml

Open `wrangler.toml` and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with the ID you just copied:

```toml
[[kv_namespaces]]
binding = "FATHOM_KV"
id = "your-actual-namespace-id-here"
```

### Step 3: Deploy

```bash
npm install
npm run deploy
```

Wrangler will output your Worker URL. Share it privately with team members — do not put it in this README.

### Testing locally

```bash
npm run dev
```

Local dev doesn't have access to production KV. To test OAuth locally, create a preview KV namespace in the Cloudflare dashboard and add it to wrangler.toml:

```toml
[[kv_namespaces]]
binding = "FATHOM_KV"
id = "your-production-id"
preview_id = "your-preview-id"
```

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

**"Unauthorized"** in Claude — Your token may have expired (90 days) or been revoked. Remove and re-add the connector.

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
