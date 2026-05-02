interface HubSpotRateLimitInfo {
  remaining: number | null;
  max: number | null;
  intervalMs: number | null;
}

interface PBRateLimitInfo {
  remaining: number | null;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function extractPointerId(pointer: unknown): string | null {
  if (typeof pointer !== 'string') return null;
  const parts = pointer.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function compact(s: string, max = 500): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

// User-facing, single-line summary of an error response body for history/SSE.
// The raw response body is still preserved on ApiError.responseBody for debug
// history; normal history should stay readable while retaining reportable IDs.
function formatBody(data: unknown): string {
  if (data == null) return '';

  if (typeof data === 'object' && data !== null) {
    const body = data as {
      id?: unknown;
      errors?: Array<{
        code?: unknown;
        title?: unknown;
        detail?: unknown;
        message?: unknown;
        source?: { pointer?: unknown };
      }>;
      message?: unknown;
      error?: unknown;
      category?: unknown;
      correlationId?: unknown;
    };

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const first = body.errors[0]!;
      const detail = String(first.detail ?? first.message ?? first.title ?? 'Validation failed');
      const extras: string[] = [];
      const pointerId = extractPointerId(first.source?.pointer);
      if (pointerId) extras.push(`field/entity: ${pointerId}`);
      if (first.code) extras.push(`code: ${String(first.code)}`);
      if (body.id) extras.push(`error id: ${String(body.id)}`);
      return ` — ${compact(detail)}${extras.length ? ` (${extras.join('; ')})` : ''}`;
    }

    const message = body.message ?? body.error;
    if (message) {
      const extras: string[] = [];
      if (body.category) extras.push(`category: ${String(body.category)}`);
      if (body.correlationId) extras.push(`correlation id: ${String(body.correlationId)}`);
      if (body.id) extras.push(`error id: ${String(body.id)}`);
      return ` — ${compact(String(message))}${extras.length ? ` (${extras.join('; ')})` : ''}`;
    }
  }

  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s ? ` — ${compact(s)}` : '';
  } catch { return ''; }
}

export function parseHubSpotHeaders(headers: Headers): HubSpotRateLimitInfo {
  const remaining = headers.get('x-hubspot-ratelimit-remaining');
  const max = headers.get('x-hubspot-ratelimit-max');
  const intervalMs = headers.get('x-hubspot-ratelimit-interval-milliseconds');
  return {
    remaining: remaining !== null ? parseInt(remaining, 10) : null,
    max: max !== null ? parseInt(max, 10) : null,
    intervalMs: intervalMs !== null ? parseInt(intervalMs, 10) : null,
  };
}

export function parsePBHeaders(headers: Headers): PBRateLimitInfo {
  const remaining = headers.get('x-ratelimit-remaining');
  return { remaining: remaining !== null ? parseInt(remaining, 10) : null };
}

export function shouldBackOffPB(info: PBRateLimitInfo): boolean {
  if (info.remaining === null) return false;
  return info.remaining < 10;
}

// HubSpot publishes the full window (max + remaining), so back off on a ratio
// rather than an absolute count — under 20% of the window left means we're
// close enough to the cap to slow down before the next request.
export function shouldBackOffHubSpot(info: HubSpotRateLimitInfo): boolean {
  if (info.remaining === null || info.max === null || info.max === 0) return false;
  return info.remaining / info.max < 0.2;
}

export function getRetryAfterMs(headers: Headers): number {
  const val = headers.get('retry-after');
  if (val === null) return 1000;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? 1000 : parsed * 1000;
}

export async function withRetry<T>(
  fn: () => Promise<ApiResponse<T>>,
  maxRetries = 3
): Promise<T> {
  let attempt = 0;

  while (true) {
    const res = await fn();

    if (res.status === 429) {
      const wait = getRetryAfterMs(res.headers);
      await sleep(wait);
      // 429 retry does not consume a 5xx slot — loop back from top
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      return res.data;
    }

    if (res.status >= 400 && res.status < 500) {
      throw new ApiError(`Request was rejected by the API (HTTP ${res.status})${formatBody(res.data)}`, res.status, res.data);
    }

    // 5xx path
    if (attempt >= maxRetries) {
      throw new ApiError(`API request failed after ${maxRetries} retries (HTTP ${res.status})${formatBody(res.data)}`, res.status, res.data);
    }

    const baseMs = 500 * Math.pow(2, attempt);
    const jitter = baseMs * 0.25 * (Math.random() * 2 - 1);
    await sleep(Math.round(baseMs + jitter));
    attempt++;
  }
}
