# Fathom MCP Server

A remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude to your Fathom meeting recordings. Once added as a connector in Claude, you can ask Claude to pull transcripts, summaries, and action items from your Fathom meetings directly — no copy-pasting required.

Runs on Cloudflare Workers. Free tier is sufficient for any normal usage.

---

## For team members: adding the connector to Claude

You need two things: your Fathom API key, and the connector token provided by whoever deployed this server.

### Step 1: Get your Fathom API key

1. Go to [Fathom](https://fathom.video) and sign in
2. Click your avatar → **Settings** → **API Access**
3. Click **Generate API Key** and copy it

Your API key only accesses meetings recorded by you or shared with your team. It cannot access other users' private meetings.

### Step 2: Construct your connector token

Your connector token is:

```
WORKER_SECRET:YOUR_FATHOM_API_KEY
```

Where `WORKER_SECRET` is the shared secret distributed privately by whoever deployed this server (never committed to source control or shared in chat). Ask your admin for it if you don't have it.

**Treat this token like a password.** Do not paste it in Slack, commit it to version control, or include it in screenshots.

### Step 3: Add the connector to Claude

**On claude.ai (web):**

1. Go to **Settings → Connectors**
2. Click **Add custom connector**
3. Enter the Worker URL (ask your admin — it is not published in this README):
   ```
   https://YOUR-WORKER-SUBDOMAIN.workers.dev/mcp
   ```
4. When prompted for an Authorization header, enter:
   ```
   Bearer WORKER_SECRET:YOUR_FATHOM_API_KEY
   ```
5. Click **Add**

**On Claude Desktop:**

1. Open your Claude Desktop config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add this to the `mcpServers` section, substituting real values:
   ```json
   {
     "mcpServers": {
       "fathom": {
         "type": "http",
         "url": "https://YOUR-WORKER-SUBDOMAIN.workers.dev/mcp",
         "headers": {
           "Authorization": "Bearer WORKER_SECRET:YOUR_FATHOM_API_KEY"
         }
       }
     }
   }
   ```
3. Save and restart Claude Desktop

> **Note:** The `claude_desktop_config.json` file is stored unencrypted on disk. Do not back this file up to cloud storage (iCloud, Dropbox, GitHub dotfiles) while it contains credentials.

### Step 4: Try it

Ask Claude something like:

- _"List my recent Fathom meetings"_
- _"Get the transcript from my last call with acme.com"_
- _"Summarize the action items from my meeting with John on March 4th"_
- _"Search for meetings with sarah@prospect.com"_

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

- **API keys are never passed as URL query parameters.** All credentials travel in the `Authorization` header, which is not recorded in server logs, browser history, or proxy logs.
- **The Worker is gated by a shared secret (`WORKER_SECRET`)** stored as a Cloudflare secret (not in source control). Only callers who know the secret can use the Worker at all.
- **This server is stateless.** Every request forwards your Fathom API key directly to Fathom's API and returns the result. Nothing is logged or cached.
- **Your Fathom API key is scoped to your own meetings.** Fathom API keys are user-level — they cannot access other users' unshared recordings.
- **The Worker URL is not published in this README.** Distribute it privately to team members to reduce the attack surface.

---

## For whoever deploys this

### Prerequisites

- [Node.js](https://nodejs.org) 18 or higher
- A [Cloudflare account](https://cloudflare.com) (free)

### First-time setup

```bash
# Clone the repo
git clone https://github.com/YOUR_ORG/fathom-mcp.git
cd fathom-mcp

# Install dependencies
npm install

# Log in to Cloudflare (opens browser)
npx wrangler login
```

### Set the Worker secret

Before deploying, set the shared secret that gates access to the Worker. Generate a strong random value (e.g. `openssl rand -hex 32`):

```bash
wrangler secret put WORKER_SECRET
# Paste your generated secret at the prompt. It is stored encrypted in Cloudflare
# and never appears in wrangler.toml or source code.
```

Distribute this secret to team members privately (e.g. via a password manager or secure channel). Do **not** put it in this README, Slack, or any version-controlled file.

### Deploy

```bash
npm run deploy
```

Wrangler will output a URL like `https://fathom-mcp.YOUR-SUBDOMAIN.workers.dev`. Share this URL with team members through a private channel, not in this README.

### Test it locally

```bash
npm run dev
```

This starts the Worker locally at `http://localhost:8787`. Test with curl:

```bash
# Health check (no auth required)
curl http://localhost:8787/health

# List tools
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WORKER_SECRET:YOUR_FATHOM_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# List meetings
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WORKER_SECRET:YOUR_FATHOM_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_meetings","arguments":{"limit":5}}}'
```

### Rotating credentials

- **Fathom API key compromised:** The user regenerates their key in Fathom Settings and updates their connector header. No redeployment needed.
- **Worker secret compromised:** Run `wrangler secret put WORKER_SECRET` with a new value and redeploy. All team members must update their connector headers.

### Updating

```bash
git pull
npm run deploy
```

Cloudflare deploys are instant and zero-downtime.

---

## Troubleshooting

**"No meetings found"** — Your Fathom API key is valid but no meetings match the filters. Try without date filters first.

**401 / Unauthorized** — Either the Worker secret or Fathom API key in your Authorization header is wrong or missing. Check the header format: `Bearer WORKER_SECRET:FATHOM_API_KEY`.

**Connector shows as disconnected in Claude** — Remove and re-add the connector. Sometimes Claude Desktop needs a restart.

---

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com) — serverless hosting
- [Fathom API](https://developers.fathom.ai) — meeting data source
- [Model Context Protocol](https://modelcontextprotocol.io) — Claude integration standard

---

## Contributing

PRs welcome. The entire server is in `src/index.ts`. To add a new tool:

1. Add a definition to the `TOOLS` array
2. Add a handler function `handleYourTool()`
3. Add a `case` in the `tools/call` switch statement
