/**
 * Fathom MCP Server — Cloudflare Worker
 *
 * A stateless remote MCP server that proxies Claude's tool calls
 * to the Fathom API.
 *
 * Authentication (two layers):
 *   1. WORKER_SECRET env var — a shared secret set at deploy time that gates
 *      access to the Worker itself. Set via `wrangler secret put WORKER_SECRET`.
 *      Clients send it as: Authorization: Bearer WORKER_SECRET:FATHOM_API_KEY
 *
 *   2. Fathom API key — embedded in the same Authorization header (after the
 *      colon), forwarded to Fathom on every upstream request. Never passed as
 *      a URL query parameter.
 *
 * Connector URL (no api_key in URL): https://your-worker.workers.dev/mcp
 * Authorization header:              Bearer <WORKER_SECRET>:<FATHOM_API_KEY>
 */

const FATHOM_BASE = "https://api.fathom.ai/external/v1";
const VERSION = "1.1.0";

// ── Cloudflare Worker env bindings ────────────────────────────────────────────

interface Env {
  // Set via: wrangler secret put WORKER_SECRET
  // Used to gate access to the Worker itself. Rotate this independently of
  // Fathom API keys. Keep it out of source control entirely.
  WORKER_SECRET: string;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Extracts and validates credentials from the Authorization header.
 *
 * Expected format: "Bearer <WORKER_SECRET>:<FATHOM_API_KEY>"
 *
 * Returns the Fathom API key on success, or null if auth fails.
 * Deliberately returns the same null for both missing and invalid credentials
 * to avoid leaking which part failed.
 */
function extractCredentials(
  request: Request,
  env: Env
): { fathomApiKey: string } | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7); // strip "Bearer "
  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) return null;

  const workerSecret = token.slice(0, colonIndex);
  const fathomApiKey = token.slice(colonIndex + 1);

  if (!workerSecret || !fathomApiKey) return null;

  // Constant-time comparison to prevent timing attacks on the secret
  const expected = env.WORKER_SECRET ?? "";
  if (expected.length === 0) return null; // fail closed if secret not configured
  if (!timingSafeEqual(workerSecret, expected)) return null;

  return { fathomApiKey };
}

/**
 * Constant-time string comparison. Prevents timing-based secret oracle attacks
 * where an attacker could measure response time to guess the secret character
 * by character.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate over `a` to keep timing consistent regardless of length mismatch
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ 0;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── Input validation ──────────────────────────────────────────────────────────

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$/;
const RECORDING_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type ValidationError = { field: string; message: string };

function validateIso8601(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO8601_RE.test(value)) {
    return { field, message: `${field} must be an ISO 8601 datetime (e.g. 2024-01-01T00:00:00Z)` };
  }
  return null;
}

function validateEmail(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !EMAIL_RE.test(value)) {
    return { field, message: `${field} must be a valid email address` };
  }
  return null;
}

function validateDomain(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DOMAIN_RE.test(value)) {
    return { field, message: `${field} must be a valid domain (e.g. acme.com)` };
  }
  return null;
}

function validateRecordingId(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "string" || !RECORDING_ID_RE.test(value)) {
    return { field, message: `${field} must be an alphanumeric ID (hyphens and underscores allowed, max 128 chars)` };
  }
  return null;
}

function validateSearchQuery(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { field, message: `${field} must be a non-empty string` };
  }
  if (value.length > 200) {
    return { field, message: `${field} must be 200 characters or fewer` };
  }
  return null;
}

// ── MCP protocol types ────────────────────────────────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_meetings",
    description:
      "List Fathom meetings with optional filters. Use this to find a meeting before fetching its transcript or summary. Returns meeting IDs, titles, dates, and attendees.",
    inputSchema: {
      type: "object",
      properties: {
        created_after: {
          type: "string",
          description: "ISO 8601 datetime, e.g. 2024-01-01T00:00:00Z",
        },
        created_before: {
          type: "string",
          description: "ISO 8601 datetime, e.g. 2024-12-31T23:59:59Z",
        },
        invitee_email: {
          type: "string",
          description: "Filter by attendee email address, e.g. john@acme.com",
        },
        invitee_domain: {
          type: "string",
          description: "Filter by attendee email domain, e.g. acme.com",
        },
        limit: {
          type: "number",
          description: "Number of meetings to return (default 10, max 50)",
        },
      },
    },
  },
  {
    name: "get_transcript",
    description:
      "Get the full transcript for a Fathom recording. Returns speaker-labeled, timestamped text. Use list_meetings first to find the recording_id.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "The recording ID from list_meetings",
        },
      },
      required: ["recording_id"],
    },
  },
  {
    name: "get_summary",
    description:
      "Get the AI-generated summary and action items for a Fathom recording. Use list_meetings first to find the recording_id.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "The recording ID from list_meetings",
        },
      },
      required: ["recording_id"],
    },
  },
  {
    name: "search_meetings",
    description:
      "Search for meetings by attendee name, email, or company domain. Returns matching meetings with their IDs and titles.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Name, email address, or domain to search for, e.g. 'John Smith', 'john@acme.com', or 'acme.com'",
        },
        created_after: {
          type: "string",
          description: "Optionally narrow by date range (ISO 8601)",
        },
        created_before: {
          type: "string",
          description: "Optionally narrow by date range (ISO 8601)",
        },
      },
      required: ["query"],
    },
  },
];

// ── Fathom API helpers ────────────────────────────────────────────────────────

/**
 * Fathom API error — wraps upstream failures with a sanitized message.
 * The raw upstream response body is intentionally NOT forwarded to the caller
 * to avoid leaking internal Fathom API details, stack traces, or token hints.
 */
class FathomAPIError extends Error {
  constructor(public readonly status: number) {
    super(`Fathom API request failed (HTTP ${status})`);
  }
}

async function fathomGet(
  path: string,
  params: Record<string, string>,
  apiKey: string
): Promise<unknown> {
  const url = new URL(`${FATHOM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { "X-Api-Key": apiKey },
  });

  if (!res.ok) {
    // Consume and discard the response body — we only surface the HTTP status.
    // Forwarding the raw body would leak Fathom's internal error messages.
    await res.text();
    throw new FathomAPIError(res.status);
  }

  return res.json();
}

// ── Meeting item type ─────────────────────────────────────────────────────────

interface FathomMeeting {
  id?: string | number;
  recording_id?: string | number;
  title: string;
  meeting_title?: string;
  created_at: string;
  scheduled_start_time?: string;
  calendar_invitees?: Array<{ name: string; email: string; is_external: boolean }>;
  recorded_by?: { name: string; email: string };
  transcript?: Array<{
    speaker: { display_name: string };
    text: string;
    timestamp: string;
  }>;
  default_summary?: {
    markdown_formatted_summary?: string;
    action_items?: Array<{
      text: string;
      assignee?: { display_name: string };
    }>;
  };
}

// ── Find a single meeting by ID, paginating through all results ───────────────

async function findMeetingById(
  id: string,
  extraParams: Record<string, string>,
  apiKey: string
): Promise<FathomMeeting | null> {
  let cursor: string | undefined;
  let pagesFetched = 0;
  const MAX_PAGES = 20;

  while (pagesFetched < MAX_PAGES) {
    const params: Record<string, string> = { limit: "50", ...extraParams };
    if (cursor) params.cursor = cursor;

    const data = (await fathomGet("/meetings", params, apiKey)) as {
      items: FathomMeeting[];
      next_cursor?: string;
    };

    if (!data.items?.length) break;

    const match = data.items.find(
      (m) => String(m.id) === id || String(m.recording_id) === id
    );

    if (match) return match;
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
    pagesFetched++;
  }

  return null;
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListMeetings(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const errors: ValidationError[] = [];
  const e1 = validateIso8601(args.created_after, "created_after");
  const e2 = validateIso8601(args.created_before, "created_before");
  const e3 = validateEmail(args.invitee_email, "invitee_email");
  const e4 = validateDomain(args.invitee_domain, "invitee_domain");
  if (e1) errors.push(e1);
  if (e2) errors.push(e2);
  if (e3) errors.push(e3);
  if (e4) errors.push(e4);
  if (errors.length) {
    return `Invalid arguments:\n${errors.map((e) => `- ${e.message}`).join("\n")}`;
  }

  const params: Record<string, string> = {};
  if (args.created_after) params.created_after = String(args.created_after);
  if (args.created_before) params.created_before = String(args.created_before);
  if (args.invitee_email) params["invitee_emails[]"] = String(args.invitee_email);
  if (args.invitee_domain) params["invitee_domains[]"] = String(args.invitee_domain);

  const rawLimit = Number(args.limit ?? 10);
  params.limit = String(Math.min(isNaN(rawLimit) ? 10 : rawLimit, 50));

  const data = (await fathomGet("/meetings", params, apiKey)) as {
    items: FathomMeeting[];
  };

  if (!data.items?.length) return "No meetings found matching those filters.";

  const lines = data.items.map((m) => {
    const id = String(m.recording_id ?? m.id ?? "unknown");
    const date = (m.scheduled_start_time ?? m.created_at).split("T")[0];
    const title = m.meeting_title ?? m.title ?? "Untitled";
    const attendees =
      m.calendar_invitees
        ?.filter((i) => i.is_external)
        .map((i) => `${i.name} <${i.email}>`)
        .join(", ") ?? "";
    return `• [${id}] ${title} — ${date}${attendees ? ` | External: ${attendees}` : ""}`;
  });

  return `Found ${data.items.length} meeting(s):\n\n${lines.join("\n")}`;
}

async function handleGetTranscript(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const idError = validateRecordingId(args.recording_id, "recording_id");
  if (idError) return `Invalid argument: ${idError.message}`;

  const id = String(args.recording_id);
  const meeting = await findMeetingById(id, { include_transcript: "true" }, apiKey);

  if (!meeting) {
    return `No meeting found with recording_id "${id}". Use list_meetings to find valid IDs.`;
  }

  if (!meeting.transcript?.length) {
    return `Meeting "${meeting.meeting_title ?? meeting.title}" was found but has no transcript yet. It may still be processing.`;
  }

  const date = (meeting.scheduled_start_time ?? meeting.created_at).split("T")[0];
  const title = meeting.meeting_title ?? meeting.title ?? "Untitled";
  const lines = meeting.transcript.map(
    (t) => `[${t.timestamp}] ${t.speaker.display_name}: ${t.text}`
  );

  return `# Transcript: ${title} (${date})\n\n${lines.join("\n")}`;
}

async function handleGetSummary(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const idError = validateRecordingId(args.recording_id, "recording_id");
  if (idError) return `Invalid argument: ${idError.message}`;

  const id = String(args.recording_id);
  const meeting = await findMeetingById(id, { include_summary: "true" }, apiKey);

  if (!meeting) {
    return `No meeting found with recording_id "${id}". Use list_meetings to find valid IDs.`;
  }

  if (!meeting.default_summary) {
    return `Meeting "${meeting.meeting_title ?? meeting.title}" was found but has no summary yet. It may still be processing.`;
  }

  const date = (meeting.scheduled_start_time ?? meeting.created_at).split("T")[0];
  const title = meeting.meeting_title ?? meeting.title ?? "Untitled";
  const summary = meeting.default_summary;

  let output = `# Summary: ${title} (${date})\n\n`;

  if (summary.markdown_formatted_summary) {
    output += summary.markdown_formatted_summary;
  }

  if (summary.action_items?.length) {
    output += "\n\n## Action Items\n";
    output += summary.action_items
      .map((a) => {
        const who = a.assignee ? ` _(${a.assignee.display_name})_` : "";
        return `- [ ] ${a.text}${who}`;
      })
      .join("\n");
  }

  return output;
}

async function handleSearchMeetings(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const errors: ValidationError[] = [];
  const qError = validateSearchQuery(args.query, "query");
  const e1 = validateIso8601(args.created_after, "created_after");
  const e2 = validateIso8601(args.created_before, "created_before");
  if (qError) errors.push(qError);
  if (e1) errors.push(e1);
  if (e2) errors.push(e2);
  if (errors.length) {
    return `Invalid arguments:\n${errors.map((e) => `- ${e.message}`).join("\n")}`;
  }

  const query = String(args.query).toLowerCase().trim();
  const params: Record<string, string> = { limit: "50" };
  if (args.created_after) params.created_after = String(args.created_after);
  if (args.created_before) params.created_before = String(args.created_before);

  // Only pass structured filter params when the query passes the relevant validator
  if (query.includes("@")) {
    if (!validateEmail(query, "query")) params["invitee_emails[]"] = query;
  } else if (query.includes(".") && !query.includes(" ")) {
    if (!validateDomain(query, "query")) params["invitee_domains[]"] = query;
  }

  const data = (await fathomGet("/meetings", params, apiKey)) as {
    items: FathomMeeting[];
  };

  if (!data.items?.length) return `No meetings found matching "${args.query}".`;

  const filtered =
    query.includes("@") || (query.includes(".") && !query.includes(" "))
      ? data.items
      : data.items.filter((m) => {
          const title = (m.meeting_title ?? m.title ?? "").toLowerCase();
          const attendees = (m.calendar_invitees ?? [])
            .map((i) => `${i.name} ${i.email}`.toLowerCase())
            .join(" ");
          return title.includes(query) || attendees.includes(query);
        });

  if (!filtered.length) return `No meetings found matching "${args.query}".`;

  const lines = filtered.map((m) => {
    const id = String(m.recording_id ?? m.id ?? "unknown");
    const date = (m.scheduled_start_time ?? m.created_at).split("T")[0];
    const title = m.meeting_title ?? m.title ?? "Untitled";
    const attendees =
      m.calendar_invitees
        ?.filter((i) => i.is_external)
        .map((i) => `${i.name} <${i.email}>`)
        .join(", ") ?? "";
    return `• [${id}] ${title} — ${date}${attendees ? ` | ${attendees}` : ""}`;
  });

  return `Found ${filtered.length} meeting(s) matching "${args.query}":\n\n${lines.join("\n")}`;
}

// ── MCP request router ────────────────────────────────────────────────────────

function ok(id: string | number | null, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string
): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMCP(req: MCPRequest, apiKey: string): Promise<MCPResponse> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fathom-mcp", version: VERSION },
      });

    case "notifications/initialized":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "list_meetings":
            text = await handleListMeetings(args, apiKey);
            break;
          case "get_transcript":
            text = await handleGetTranscript(args, apiKey);
            break;
          case "get_summary":
            text = await handleGetSummary(args, apiKey);
            break;
          case "search_meetings":
            text = await handleSearchMeetings(args, apiKey);
            break;
          default:
            return err(id, -32601, `Unknown tool: ${toolName}`);
        }
        return ok(id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Surface safe, normalized errors only — never leak raw upstream responses.
        if (e instanceof FathomAPIError) {
          const msg =
            e.status === 401
              ? "Fathom authentication failed. Check that your Fathom API key is valid."
              : e.status === 403
              ? "Fathom access denied. Your API key may not have permission for this resource."
              : e.status === 404
              ? "Fathom resource not found."
              : e.status === 429
              ? "Fathom rate limit exceeded. Please wait before retrying."
              : `Fathom API request failed (HTTP ${e.status}). Please try again.`;
          return ok(id, { content: [{ type: "text", text: msg }], isError: true });
        }
        return ok(id, {
          content: [{ type: "text", text: "An unexpected error occurred. Please try again." }],
          isError: true,
        });
      }
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ── CORS helpers ──────────────────────────────────────────────────────────────

/**
 * Returns restrictive CORS headers.
 *
 * This Worker is called server-to-server by Claude — there is no legitimate
 * browser cross-origin use case. We restrict to "null" origin rather than
 * the wildcard (*) that was here previously.
 *
 * If you ever need browser-based access, replace "null" with your specific
 * allowed origin (e.g. "https://claude.ai") rather than re-opening to *.
 */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ── Cloudflare Worker entry point ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — intentionally minimal. Returns only a liveness boolean.
    // No version, runtime info, or config hints that could aid reconnaissance.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    // OPTIONS preflight — no credentials required
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // All /mcp requests beyond OPTIONS require valid credentials
    const creds = extractCredentials(request, env);
    if (!creds) {
      return new Response(
        JSON.stringify({
          error:
            "Unauthorized. Set Authorization header: Bearer <WORKER_SECRET>:<FATHOM_API_KEY>",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const { fathomApiKey } = creds;

    if (request.method === "POST") {
      let body: MCPRequest;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const response = await handleMCP(body, fathomApiKey);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (request.method === "GET") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const send = async (data: unknown) => {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      (async () => {
        try {
          await send({
            jsonrpc: "2.0",
            method: "sse/connected",
            params: { serverInfo: { name: "fathom-mcp", version: VERSION } },
          });
          await new Promise((resolve) => setTimeout(resolve, 30000));
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
