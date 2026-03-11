/**
 * Fathom MCP Server — Cloudflare Worker
 *
 * Implements OAuth 2.0 Authorization Code flow with PKCE so users can
 * authenticate via Claude's standard connector UI on claude.ai.
 *
 * Each user authenticates once by entering their Fathom API key into a
 * hosted form. The Worker validates the key against Fathom, then issues
 * an opaque access token stored in Cloudflare KV. Claude sends that token
 * on every subsequent MCP request; the Worker looks it up to get the
 * user's Fathom key.
 *
 * OAuth endpoints:
 *   GET  /.well-known/oauth-authorization-server  — metadata discovery
 *   POST /oauth/register                           — dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize                          — shows the auth form
 *   POST /oauth/authorize                          — processes form submission
 *   POST /oauth/token                              — exchanges code for token
 *   POST /oauth/revoke                             — revokes a token
 *
 * MCP endpoint:
 *   POST /mcp                                      — MCP JSON-RPC
 *   GET  /mcp                                      — SSE transport
 *
 * KV schema:
 *   auth_code:<code>   → JSON { fathomApiKey, codeChallenge, expiresAt }  TTL: 5 min
 *   token:<token>      → JSON { fathomApiKey, issuedAt }                  TTL: 30 days
 */

const FATHOM_BASE = "https://api.fathom.ai/external/v1";
const VERSION = "1.2.0";

// Token lifetimes
const AUTH_CODE_TTL_SECONDS = 300;        // 5 minutes
const ACCESS_TOKEN_TTL_SECONDS = 2592000; // 30 days

// ── Env bindings ──────────────────────────────────────────────────────────────

interface Env {
  // KV namespace bound in wrangler.toml as [[kv_namespaces]] binding = "FATHOM_KV"
  FATHOM_KV: KVNamespace;
  // 64-char hex (32-byte AES-256-GCM key). Set via: wrangler secret put KV_ENCRYPTION_KEY
  KV_ENCRYPTION_KEY: string;
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/** Generates a cryptographically random hex string of `bytes` bytes. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Prevents timing-based oracle attacks
 * where an attacker measures response latency to guess secret values
 * character by character.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  // Include length mismatch in diff so unequal-length strings always return false,
  // while still iterating over the full longer string to avoid timing leaks.
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Verifies a PKCE code_verifier against a stored code_challenge.
 * Claude uses S256 method: challenge = BASE64URL(SHA-256(verifier))
 */
async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return timingSafeEqual(base64url, challenge);
}

/**
 * AES-256-GCM encryption for Fathom API keys at rest in KV.
 * The encryption key is a Wrangler secret, never stored in KV itself.
 * Ciphertext format: base64(12-byte IV || GCM ciphertext || 16-byte auth tag).
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function encryptValue(plaintext: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  let binary = "";
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

async function decryptValue(encrypted: string, keyHex: string): Promise<string | null> {
  try {
    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null; // wrong key, corrupted data, or old plaintext token → treat as invalid
  }
}

// ── Input validation ──────────────────────────────────────────────────────────

// Accepts: 2024-01-01T00:00:00Z, 2024-01-01T00:00:00.000Z, 2024-01-01T00:00:00-05:00, 2024-01-01
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$/;
const RECORDING_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

type ValidationError = { field: string; message: string };

function validateIso8601(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO8601_RE.test(value))
    return { field, message: `${field} must be an ISO 8601 datetime (e.g. 2024-01-01T00:00:00Z)` };
  return null;
}

function validateEmail(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !EMAIL_RE.test(value))
    return { field, message: `${field} must be a valid email address` };
  return null;
}

function validateDomain(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DOMAIN_RE.test(value))
    return { field, message: `${field} must be a valid domain (e.g. acme.com)` };
  return null;
}

function validateRecordingId(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "string" || !RECORDING_ID_RE.test(value))
    return { field, message: `${field} must be an alphanumeric ID (hyphens and underscores allowed, max 128 chars)` };
  return null;
}

function validateSearchQuery(value: unknown, field: string): ValidationError | null {
  if (typeof value !== "string" || value.trim().length === 0)
    return { field, message: `${field} must be a non-empty string` };
  if (value.length > 200)
    return { field, message: `${field} must be 200 characters or fewer` };
  return null;
}

// ── Fathom API helpers ────────────────────────────────────────────────────────

/**
 * Wraps Fathom upstream failures. Carries only an HTTP status code —
 * the raw response body is discarded to prevent leaking internal details.
 */
class FathomAPIError extends Error {
  constructor(public readonly status: number) {
    super(`Fathom API request failed (HTTP ${status})`);
  }
}

const ALLOWED_FATHOM_PATH_PREFIXES = ["/meetings", "/recordings/"];

async function fathomGet(
  path: string,
  params: Record<string, string>,
  apiKey: string
): Promise<unknown> {
  if (!ALLOWED_FATHOM_PATH_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error(`Disallowed API path: ${path}`);
  }
  const url = new URL(`${FATHOM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let res = await fetch(url.toString(), { headers: { "X-Api-Key": apiKey } });

  // On 429, wait the Retry-After duration (or 2s) and retry once.
  if (res.status === 429) {
    const retryAfter = Math.min(Number(res.headers.get("Retry-After") ?? 2), 5);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    res = await fetch(url.toString(), { headers: { "X-Api-Key": apiKey } });
  }

  if (!res.ok) {
    await res.text(); // consume and discard
    throw new FathomAPIError(res.status);
  }
  return res.json();
}

/**
 * Validates a Fathom API key by making a cheap API call.
 * Returns true if the key is accepted, false if it's rejected (401/403),
 * throws for unexpected errors.
 */
async function validateFathomKey(apiKey: string): Promise<boolean> {
  try {
    await fathomGet("/meetings", { limit: "1" }, apiKey);
    return true;
  } catch (e) {
    if (e instanceof FathomAPIError && (e.status === 401 || e.status === 403)) {
      return false;
    }
    throw e;
  }
}

// ── Meeting types ─────────────────────────────────────────────────────────────

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

// ── Tool handlers ─────────────────────────────────────────────────────────────

/**
 * Fetches meetings from Fathom by following pagination cursors.
 *
 * The Fathom API ignores server-side filters (invitee_domain, invitee_email,
 * created_after, created_before), so we fetch everything and filter client-side.
 *
 * Pagination stops when:
 *   - There is no next_cursor (end of account history)
 *   - The oldest meeting on a page is earlier than `stopBefore` (we've passed the window)
 *   - A hard safety cap of 100 pages (5000 meetings) is hit
 *   - The wall-clock budget (20 s) is nearly exhausted, to stay under Worker timeout
 */
async function fetchAllMeetings(
  dateParams: Record<string, string>,
  apiKey: string,
): Promise<{ meetings: FathomMeeting[]; truncated: boolean }> {
  const all: FathomMeeting[] = [];
  let cursor: string | undefined;
  const SAFETY_CAP = 100; // 100 pages × 50 = 5000 meetings max
  // performance.now() advances during awaits in Workers; Date.now() is frozen at request start.
  const startedAt = performance.now();
  const BUDGET_MS = 20_000; // stop after 20 s to stay under 30 s Worker timeout
  let pagesFetched = 0;

  // If caller supplied a created_after bound, stop paginating once we've
  // gone past it — meetings are returned newest-first so once we see a
  // meeting older than this we know there's nothing relevant further back.
  const stopBefore = dateParams.created_after
    ? new Date(dateParams.created_after).getTime()
    : null;

  while (pagesFetched < SAFETY_CAP && performance.now() - startedAt < BUDGET_MS) {
    const params: Record<string, string> = { limit: "50" };
    if (cursor) params.cursor = cursor;

    const data = (await fathomGet("/meetings", params, apiKey)) as {
      items: FathomMeeting[];
      next_cursor?: string;
    };

    if (!data.items?.length) break;
    all.push(...data.items);
    pagesFetched++;

    // If the oldest meeting on this page is before our window, we're done.
    if (stopBefore) {
      const oldest = data.items[data.items.length - 1];
      const oldestTime = new Date(
        oldest.scheduled_start_time ?? oldest.created_at
      ).getTime();
      if (oldestTime < stopBefore) break;
    }

    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  const truncated = pagesFetched >= SAFETY_CAP || performance.now() - startedAt >= BUDGET_MS;
  return { meetings: all, truncated };
}

function formatMeetingLine(m: FathomMeeting): string {
  const id = String(m.recording_id ?? m.id ?? "unknown");
  const date = (m.scheduled_start_time ?? m.created_at).split("T")[0];
  const title = m.meeting_title ?? m.title ?? "Untitled";
  const attendees =
    m.calendar_invitees
      ?.filter((i) => i.is_external)
      .map((i) => `${i.name} <${i.email}>`)
      .join(", ") ?? "";
  return `• [${id}] ${title} — ${date}${attendees ? ` | External: ${attendees}` : ""}`;
}

async function handleListMeetings(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const errors: ValidationError[] = [];
  const e1 = validateIso8601(args.created_after, "created_after");
  const e2 = validateIso8601(args.created_before, "created_before");
  const e3 = validateEmail(args.invitee_email, "invitee_email");
  const e4 = validateDomain(args.invitee_domain, "invitee_domain");
  const e5 = args.query !== undefined && args.query !== null && args.query !== ""
    ? validateSearchQuery(args.query, "query")
    : null;
  if (e1) errors.push(e1);
  if (e2) errors.push(e2);
  if (e3) errors.push(e3);
  if (e4) errors.push(e4);
  if (e5) errors.push(e5);
  if (errors.length)
    return `Invalid arguments:\n${errors.map((e) => `- ${e.message}`).join("\n")}`;

  // Normalize date-only strings to full ISO timestamps before sending to Fathom,
  // which requires the full datetime format.
  const normalizeDate = (v: unknown): string | null => {
    if (!v) return null;
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  };

  const dateParams: Record<string, string> = {};
  const after = normalizeDate(args.created_after);
  const before = normalizeDate(args.created_before);

  const filterEmail = args.invitee_email ? String(args.invitee_email).toLowerCase() : null;
  const filterDomain = args.invitee_domain ? String(args.invitee_domain).toLowerCase() : null;
  const filterQuery = args.query ? String(args.query).toLowerCase().trim() : null;

  // When a search filter is provided, default to 1 year back so searches
  // cover full history without requiring the user to specify dates.
  // Plain listing (no filters) defaults to 1 month for a fast response.
  // Both are bounded by the 20-second wall-clock budget in fetchAllMeetings.
  const isSearch = !!(filterQuery || filterEmail || filterDomain);
  const defaultWindow = new Date();
  defaultWindow.setMonth(defaultWindow.getMonth() - (isSearch ? 12 : 1));
  dateParams.created_after = after ?? defaultWindow.toISOString();
  if (before) dateParams.created_before = before;
  const rawLimit = Number(args.limit ?? 50);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(1, rawLimit), 500);

  const { meetings: all, truncated } = await fetchAllMeetings(dateParams, apiKey);

  const filtered = all.filter((m) => {
    const invitees = m.calendar_invitees ?? [];
    const allEmails = [
      ...invitees.map((i) => i.email.toLowerCase()),
      ...(m.recorded_by?.email ? [m.recorded_by.email.toLowerCase()] : []),
    ];

    if (filterEmail && !allEmails.includes(filterEmail)) return false;
    if (filterDomain && !allEmails.some((e) => e.endsWith(`@${filterDomain}`))) return false;

    if (filterQuery) {
      const title = (m.meeting_title ?? m.title ?? "").toLowerCase();
      const attendeeText = [
        ...invitees.map((i) => `${i.name} ${i.email}`.toLowerCase()),
        m.recorded_by ? `${m.recorded_by.name} ${m.recorded_by.email}`.toLowerCase() : "",
      ].join(" ");

      // Email exact match
      if (filterQuery.includes("@")) {
        return allEmails.includes(filterQuery);
      }
      // Domain match
      if (filterQuery.includes(".") && !filterQuery.includes(" ")) {
        return allEmails.some((e) => e.endsWith(`@${filterQuery}`));
      }
      // Title or attendee name/email substring
      return title.includes(filterQuery) || attendeeText.includes(filterQuery);
    }

    return true;
  });

  if (!filtered.length) return "No meetings found matching those filters.";

  const results = filtered.slice(0, limit);
  const lines = results.map(formatMeetingLine);

  const notes: string[] = [];
  if (filtered.length > limit)
    notes.push(`Showing ${limit} of ${filtered.length} matches. Pass a higher limit or narrow with created_after/created_before.`);
  if (truncated)
    notes.push(`Search pool capped (time or page limit reached). Results may be incomplete — narrow the date range to ensure full coverage.`);

  const noteStr = notes.length ? `\n\n(${notes.join(" ")})` : "";
  return `Found ${filtered.length} meeting(s):\n\n${lines.join("\n")}${noteStr}`;
}

async function handleSearchMeetings(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  // search_meetings is now an alias for list_meetings with query support.
  // Kept for backwards compatibility with any cached tool lists.
  return handleListMeetings(args, apiKey);
}

async function handleGetTranscript(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const idError = validateRecordingId(args.recording_id, "recording_id");
  if (idError) return `Invalid argument: ${idError.message}`;

  const id = String(args.recording_id);

  // Use the dedicated transcript endpoint — OAuth apps cannot use
  // include_transcript on /meetings. This is also a single HTTP call
  // vs. paginating through all meetings looking for the ID.
  const data = (await fathomGet(
    `/recordings/${id}/transcript`,
    {},
    apiKey
  )) as { transcript?: Array<{ speaker: { display_name: string }; text: string; timestamp: string }> };

  if (!data.transcript?.length)
    return `No transcript found. The recording may still be processing, or the ID may be invalid. Use list_meetings to verify.`;

  const lines = data.transcript.map(
    (t) => `[${t.timestamp}] ${t.speaker.display_name}: ${t.text}`
  );
  return `# Transcript (recording ${id})\n\n${lines.join("\n")}`;
}

async function handleGetSummary(
  args: Record<string, unknown>,
  apiKey: string
): Promise<string> {
  const idError = validateRecordingId(args.recording_id, "recording_id");
  if (idError) return `Invalid argument: ${idError.message}`;

  const id = String(args.recording_id);

  // Use the dedicated summary endpoint — OAuth apps cannot use
  // include_summary on /meetings. Response shape:
  //   { summary: { template_name: string, markdown_formatted: string } }
  // Note: action_items are only available via the /meetings inline embed
  // which OAuth apps cannot use. The summary markdown often includes them.
  const data = (await fathomGet(
    `/recordings/${id}/summary`,
    {},
    apiKey
  )) as { summary?: { template_name?: string; markdown_formatted?: string } };

  if (!data.summary?.markdown_formatted)
    return `No summary found. The recording may still be processing, or the ID may be invalid. Use list_meetings to verify.`;

  const { template_name, markdown_formatted } = data.summary;
  const templateNote = template_name ? ` _(${template_name} template)_` : "";

  return `# Summary (recording ${id})${templateNote}\n\n${markdown_formatted}`;
}

const TOOLS = [
  {
    name: "list_meetings",
    description:
      "List and search Fathom meetings. Supports filtering by date range, attendee email, attendee domain, and free-text query (matches meeting title and attendee names). " +
      "When a query, email, or domain filter is provided, automatically searches the last 12 months. " +
      "Plain listing (no filters) defaults to the last 1 month. " +
      "Pass created_after to search even further back.",
    inputSchema: {
      type: "object",
      properties: {
        created_after:  { type: "string", description: "ISO 8601 date or datetime, e.g. 2025-01-01 or 2025-01-01T00:00:00Z" },
        created_before: { type: "string", description: "ISO 8601 date or datetime, e.g. 2025-03-31 or 2025-03-31T23:59:59Z" },
        invitee_email:  { type: "string", description: "Filter by exact attendee email, e.g. john@acme.com" },
        invitee_domain: { type: "string", description: "Filter by attendee email domain, e.g. acme.com" },
        query:          { type: "string", description: "Free-text search across meeting titles and attendee names/emails, e.g. 'National Catholic Reporter' or 'john@acme.com'" },
        limit:          { type: "number", description: "Max results to return (default 50, max 500)" },
      },
    },
  },
  {
    name: "get_transcript",
    description: "Get the full transcript for a Fathom recording. Returns speaker-labeled, timestamped text. Use list_meetings first to find the recording_id.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: { type: "string", description: "The recording ID from list_meetings" },
      },
      required: ["recording_id"],
    },
  },
  {
    name: "get_summary",
    description: "Get the AI-generated summary and action items for a Fathom recording. Use list_meetings first to find the recording_id.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: { type: "string", description: "The recording ID from list_meetings" },
      },
      required: ["recording_id"],
    },
  },
  {
    name: "search_meetings",
    description: "Alias for list_meetings with query support. Prefer list_meetings. Accepts the same parameters.",
    inputSchema: {
      type: "object",
      properties: {
        query:          { type: "string", description: "Free-text search across meeting titles and attendee names/emails" },
        created_after:  { type: "string", description: "ISO 8601 date or datetime" },
        created_before: { type: "string", description: "ISO 8601 date or datetime" },
        invitee_email:  { type: "string", description: "Filter by exact attendee email" },
        invitee_domain: { type: "string", description: "Filter by attendee email domain" },
        limit:          { type: "number", description: "Max results to return (default 50, max 500)" },
      },
    },
  },
];

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

function mcpOk(id: string | number | null, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result };
}

function mcpErr(id: string | number | null, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMCP(req: MCPRequest, apiKey: string): Promise<MCPResponse> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return mcpOk(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fathom-mcp", version: VERSION },
      });

    case "notifications/initialized":
      return mcpOk(id, {});

    case "tools/list":
      return mcpOk(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;
        switch (toolName) {
          case "list_meetings":    text = await handleListMeetings(args, apiKey); break;
          case "get_transcript":   text = await handleGetTranscript(args, apiKey); break;
          case "get_summary":      text = await handleGetSummary(args, apiKey); break;
          case "search_meetings":  text = await handleSearchMeetings(args, apiKey); break;
          default:
            return mcpErr(id, -32601, `Unknown tool: ${toolName}`);
        }
        return mcpOk(id, { content: [{ type: "text", text }] });
      } catch (e) {
        if (e instanceof FathomAPIError) {
          const msg =
            e.status === 401 ? "Fathom authentication failed. Check that your Fathom API key is valid." :
            e.status === 403 ? "Fathom access denied. Your API key may not have permission for this resource." :
            e.status === 404 ? "Fathom resource not found." :
            e.status === 429 ? "Fathom rate limit exceeded. Please wait before retrying." :
            `Fathom API request failed (HTTP ${e.status}). Please try again.`;
          return mcpOk(id, { content: [{ type: "text", text: msg }], isError: true });
        }
        return mcpOk(id, {
          content: [{ type: "text", text: "An unexpected error occurred. Please try again." }],
          isError: true,
        });
      }
    }

    default:
      return mcpErr(id, -32601, `Method not found: ${method}`);
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────

/**
 * OAuth endpoints need to accept requests from claude.ai (browser-initiated
 * redirects during the auth flow). MCP endpoints remain server-to-server.
 * We allow claude.ai and claude.com explicitly rather than using a wildcard.
 */
function oauthCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "https://claude.ai",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function mcpCorsHeaders(): Record<string, string> {
  // MCP is server-to-server — no Access-Control-Allow-Origin is set.
  // "null" (the string) is a valid serialized origin that matches sandboxed
  // iframes and file:// pages, so omitting it is safer than sending it.
  // Allow-Methods/Headers are retained for OPTIONS discoverability only.
  return {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function htmlPage(title: string, body: string): Response {
  const escTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1rem;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 2rem;
      max-width: 440px;
      width: 100%;
    }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #555; font-size: 0.95rem; margin: 0 0 1.5rem; line-height: 1.5; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.4rem; }
    input[type=password], input[type=text] {
      width: 100%;
      padding: 0.65rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 0.95rem;
      margin-bottom: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #7c5ce5; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #7c5ce5;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #6a4fd4; }
    .error {
      background: #fff0f0;
      border: 1px solid #ffcccc;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      color: #c00;
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }
    .hint { font-size: 0.8rem; color: #888; margin-top: 1rem; text-align: center; }
    a { color: #7c5ce5; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// ── OAuth handlers ────────────────────────────────────────────────────────────

/**
 * GET /.well-known/oauth-authorization-server
 *
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Claude fetches this to discover the authorize and token endpoints.
 */
function handleOAuthMetadata(baseUrl: string): Response {
  return new Response(
    JSON.stringify({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
    { headers: { "Content-Type": "application/json", ...oauthCorsHeaders() } }
  );
}

/**
 * POST /oauth/register
 *
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 * Claude calls this before starting the auth flow to register itself
 * as a client. We don't need to persist the registration — we accept
 * any well-formed request and return a client_id derived from the
 * request so Claude can proceed to the authorize endpoint.
 *
 * Security note: we validate that the redirect_uris are Claude's
 * known callback URLs before accepting the registration.
 */
async function handleRegister(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_request", "Could not parse registration request body");
  }

  // Validate redirect_uris — only Claude's known callback URLs accepted
  const redirectUris = (body.redirect_uris as string[]) ?? [];
  const allValid = redirectUris.every(
    (uri) =>
      uri.startsWith("https://claude.ai/") ||
      uri.startsWith("https://claude.com/")
  );

  if (!redirectUris.length || !allValid) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be Claude callback URLs");
  }

  // Issue a stable client_id based on the requesting client name.
  // We don't store registrations — the client_id is accepted as-is
  // on the authorize endpoint without further validation.
  const clientId = `claude-${randomHex(8)}`;

  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_name: body.client_name ?? "Claude",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      code_challenge_methods: ["S256"],
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", ...oauthCorsHeaders() },
    }
  );
}

/**
 * GET /oauth/authorize
 *
 * Validates the incoming OAuth request parameters, then serves the
 * Fathom API key entry form. The state, redirect_uri, and code_challenge
 * are embedded as hidden fields so the POST handler can use them without
 * server-side session state.
 *
 * Security notes:
 * - redirect_uri must start with https://claude.ai or https://claude.com
 * - code_challenge_method must be S256
 * - state is echoed back to Claude to prevent CSRF
 */
function handleAuthorizeGet(url: URL): Response {
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";

  // Validate redirect_uri — only Claude's known callback URLs are accepted
  if (
    !redirectUri.startsWith("https://claude.ai/") &&
    !redirectUri.startsWith("https://claude.com/")
  ) {
    return htmlPage(
      "Invalid Request",
      `<h1>Invalid Request</h1>
       <p>The redirect URI is not allowed. This connector only works with Claude.</p>`
    );
  }

  // Require PKCE with S256
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return htmlPage(
      "Invalid Request",
      `<h1>Invalid Request</h1>
       <p>PKCE with S256 is required.</p>`
    );
  }

  // Encode params for hidden fields — escape to prevent XSS
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return htmlPage(
    "Connect Fathom to Claude",
    `<h1>Connect Fathom to Claude</h1>
     <p>Enter your Fathom API key to give Claude access to your meeting recordings, transcripts, and summaries.</p>
     <p>Get your key at <a href="https://fathom.video" target="_blank" rel="noopener">fathom.video</a> → Settings → API Access.</p>
     <form method="POST" action="/oauth/authorize">
       <input type="hidden" name="redirect_uri"           value="${esc(redirectUri)}">
       <input type="hidden" name="state"                  value="${esc(state)}">
       <input type="hidden" name="code_challenge"         value="${esc(codeChallenge)}">
       <input type="hidden" name="code_challenge_method"  value="${esc(codeChallengeMethod)}">
       <label for="api_key">Fathom API Key</label>
       <input type="password" id="api_key" name="api_key" placeholder="fathom_..." autocomplete="off" required>
       <button type="submit">Connect</button>
     </form>
     <p class="hint">Your API key is validated and stored securely. It is never shared.</p>`
  );
}

/**
 * POST /oauth/authorize
 *
 * Processes the form submission:
 * 1. Validates the Fathom API key by making a real API call
 * 2. Generates a single-use auth code
 * 3. Stores code → { fathomApiKey, codeChallenge } in KV with a 5-minute TTL
 * 4. Redirects back to Claude with the code and state
 */
async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const redirectUri = formData.get("redirect_uri")?.toString() ?? "";
  const state = formData.get("state")?.toString() ?? "";
  const codeChallenge = formData.get("code_challenge")?.toString() ?? "";
  const codeChallengeMethod = formData.get("code_challenge_method")?.toString() ?? "";
  const apiKey = formData.get("api_key")?.toString().trim() ?? "";

  // Escape helper for re-rendering values into HTML attributes
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Re-validate redirect_uri on POST — never trust hidden field alone
  if (
    !redirectUri.startsWith("https://claude.ai/") &&
    !redirectUri.startsWith("https://claude.com/")
  ) {
    return new Response("Invalid redirect_uri", { status: 400 });
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return new Response("PKCE required", { status: 400 });
  }

  if (!apiKey) {
    return htmlPage(
      "Connect Fathom to Claude",
      `<div class="error">Please enter your Fathom API key.</div>
       <h1>Connect Fathom to Claude</h1>
       <p>Enter your Fathom API key to give Claude access to your meeting recordings.</p>
       <form method="POST" action="/oauth/authorize">
         <input type="hidden" name="redirect_uri"          value="${esc(redirectUri)}">
         <input type="hidden" name="state"                 value="${esc(state)}">
         <input type="hidden" name="code_challenge"        value="${esc(codeChallenge)}">
         <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">
         <label for="api_key">Fathom API Key</label>
         <input type="password" id="api_key" name="api_key" placeholder="fathom_..." autocomplete="off" required>
         <button type="submit">Connect</button>
       </form>`
    );
  }

  // Validate the key actually works before storing it
  let keyValid: boolean;
  try {
    keyValid = await validateFathomKey(apiKey);
  } catch {
    return htmlPage(
      "Connection Error",
      `<h1>Connection Error</h1>
       <p>Could not reach Fathom to verify your API key. Please try again.</p>
       <p><button type="button" onclick="history.back()">Go back</button></p>`
    );
  }

  if (!keyValid) {
    return htmlPage(
      "Connect Fathom to Claude",
      `<div class="error">That API key wasn't accepted by Fathom. Please check it and try again.</div>
       <h1>Connect Fathom to Claude</h1>
       <p>Enter your Fathom API key to give Claude access to your meeting recordings.</p>
       <form method="POST" action="/oauth/authorize">
         <input type="hidden" name="redirect_uri"          value="${esc(redirectUri)}">
         <input type="hidden" name="state"                 value="${esc(state)}">
         <input type="hidden" name="code_challenge"        value="${esc(codeChallenge)}">
         <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">
         <label for="api_key">Fathom API Key</label>
         <input type="password" id="api_key" name="api_key" placeholder="fathom_..." autocomplete="off" required>
         <button type="submit">Connect</button>
       </form>`
    );
  }

  // Issue a single-use auth code — encrypt the key at rest
  const code = randomHex(32); // 256 bits of entropy
  const encryptedKey = await encryptValue(apiKey, env.KV_ENCRYPTION_KEY);
  await env.FATHOM_KV.put(
    `auth_code:${code}`,
    JSON.stringify({ fathomApiKey: encryptedKey, codeChallenge }),
    { expirationTtl: AUTH_CODE_TTL_SECONDS }
  );

  // Redirect back to Claude
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  return Response.redirect(callbackUrl.toString(), 302);
}

/**
 * POST /oauth/token
 *
 * Exchanges an auth code for an access token.
 * Verifies PKCE code_verifier against the stored code_challenge.
 * Auth codes are single-use — deleted immediately after exchange.
 */
async function handleToken(request: Request, env: Env): Promise<Response> {
  let params: URLSearchParams;
  try {
    const body = await request.text();
    params = new URLSearchParams(body);
  } catch {
    return oauthError("invalid_request", "Could not parse request body");
  }

  const grantType = params.get("grant_type");
  const code = params.get("code") ?? "";
  const codeVerifier = params.get("code_verifier") ?? "";

  if (grantType !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported");
  }

  if (!code || !codeVerifier) {
    return oauthError("invalid_request", "code and code_verifier are required");
  }

  // Look up the auth code.
  const stored = await env.FATHOM_KV.get(`auth_code:${code}`);

  if (!stored || stored === "consumed") {
    return oauthError("invalid_grant", "Authorization code is invalid or expired");
  }

  // Write a "consumed" sentinel immediately — before any async PKCE work.
  // This narrows the TOCTOU race window (two concurrent requests with the same
  // code both passing the get check) from PKCE verification time to one KV
  // round-trip. The sentinel expires in 60 s; delete cleans it up on success.
  await env.FATHOM_KV.put(`auth_code:${code}`, "consumed", { expirationTtl: 60 });

  let codeData: { fathomApiKey: string; codeChallenge: string };
  try {
    codeData = JSON.parse(stored);
  } catch {
    return oauthError("server_error", "Internal error");
  }

  // Decrypt the stored Fathom API key
  const fathomApiKey = await decryptValue(codeData.fathomApiKey, env.KV_ENCRYPTION_KEY);
  if (!fathomApiKey) {
    return oauthError("server_error", "Internal error");
  }

  // Verify PKCE — code is already consumed via sentinel; a failed check here
  // burns the code intentionally (trade-off for closing the TOCTOU window).
  const pkceValid = await verifyPKCE(codeVerifier, codeData.codeChallenge);
  if (!pkceValid) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // PKCE passed — clean up the sentinel
  await env.FATHOM_KV.delete(`auth_code:${code}`);

  // Issue access token — encrypt the key at rest
  const accessToken = randomHex(32); // 256 bits of entropy
  const encryptedKey = await encryptValue(fathomApiKey, env.KV_ENCRYPTION_KEY);
  await env.FATHOM_KV.put(
    `token:${accessToken}`,
    JSON.stringify({ fathomApiKey: encryptedKey, issuedAt: Date.now() }),
    { expirationTtl: ACCESS_TOKEN_TTL_SECONDS }
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    }),
    { headers: { "Content-Type": "application/json", ...oauthCorsHeaders() } }
  );
}

/**
 * POST /oauth/revoke
 *
 * Revokes an access token (RFC 7009).
 * Always returns 200 regardless of whether the token existed —
 * this is per-spec and avoids leaking token validity information.
 */
async function handleRevoke(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.text();
    const params = new URLSearchParams(body);
    const token = params.get("token");
    if (token) await env.FATHOM_KV.delete(`token:${token}`);
  } catch {
    // Silently ignore — always return 200 per RFC 7009
  }
  return new Response(null, { status: 200, headers: oauthCorsHeaders() });
}

function oauthError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { "Content-Type": "application/json", ...oauthCorsHeaders() },
  });
}

/**
 * Resolves a Bearer token from the Authorization header to a Fathom API key
 * by looking it up in KV. Returns null if the token is missing or unknown.
 */
async function resolveBearerToken(
  request: Request,
  env: Env
): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const stored = await env.FATHOM_KV.get(`token:${token}`);
  if (!stored) return null;

  try {
    const data = JSON.parse(stored) as { fathomApiKey: string };
    return await decryptValue(data.fathomApiKey, env.KV_ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

// Named exports for testing — Workers only uses the default export
export {
  timingSafeEqual,
  verifyPKCE,
  encryptValue,
  decryptValue,
  validateIso8601,
  validateEmail,
  validateDomain,
  validateRecordingId,
  validateSearchQuery,
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  TOOLS,
};

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // ── Health check ───────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── OAuth metadata discovery ───────────────────────────────────────────────
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return handleOAuthMetadata(baseUrl);
    }

    // ── OAuth register (Dynamic Client Registration) ───────────────────────────
    if (url.pathname === "/oauth/register") {
      if (request.method === "OPTIONS")
        return new Response(null, { headers: oauthCorsHeaders() });
      if (request.method === "POST")
        return handleRegister(request);
      return new Response("Method not allowed", { status: 405 });
    }

    // ── OAuth authorize ────────────────────────────────────────────────────────
    if (url.pathname === "/oauth/authorize") {
      if (request.method === "OPTIONS")
        return new Response(null, { headers: oauthCorsHeaders() });
      if (request.method === "GET")
        return handleAuthorizeGet(url);
      if (request.method === "POST")
        return handleAuthorizePost(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // ── OAuth token ────────────────────────────────────────────────────────────
    if (url.pathname === "/oauth/token") {
      if (request.method === "OPTIONS")
        return new Response(null, { headers: oauthCorsHeaders() });
      if (request.method === "POST")
        return handleToken(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // ── OAuth revoke ───────────────────────────────────────────────────────────
    if (url.pathname === "/oauth/revoke") {
      if (request.method === "OPTIONS")
        return new Response(null, { headers: oauthCorsHeaders() });
      if (request.method === "POST")
        return handleRevoke(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    // ── MCP ────────────────────────────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      if (request.method === "OPTIONS")
        return new Response(null, { headers: mcpCorsHeaders() });

      // Resolve the Fathom API key via Bearer token from the OAuth flow.
      const fathomApiKey = await resolveBearerToken(request, env);
      if (!fathomApiKey) {
        return new Response(
          JSON.stringify({ error: "Unauthorized. Connect via Claude's Connectors settings." }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      if (request.method === "POST") {
        let body: MCPRequest;
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        const response = await handleMCP(body, fathomApiKey);
        // No CORS headers on POST responses — MCP is server-to-server only.
        // Claude's infrastructure calls this directly; browser CORS is not needed.
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
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
          },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};