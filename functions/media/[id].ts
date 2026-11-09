interface MediaMetadata {
  contentType?: string;
  fileName?: string;
  size?: number;
}

interface R2MediaObject {
  size: number;
  body?: ReadableStream<Uint8Array> | null;
  httpMetadata?: { contentType?: string } | null;
}

interface R2MediaBucket {
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } }
  ): Promise<R2MediaObject | null>;
  head(key: string): Promise<R2MediaObject | null>;
}

interface MediaEnv {
  MEDIA?: KVNamespace;
  MEDIA_R2?: R2MediaBucket;
}

interface MediaContext {
  request: Request;
  env: MediaEnv;
}

interface ByteRange {
  start: number;
  end: number;
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      }
    }
  );
}

function parseByteRange(header: string, size: number): ByteRange | null {
  const match = header.match(/^bytes=(\\d*)-(\\d*)$/);
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;

  let start: number;
  let end: number;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

function mediaHeaders(contentType: string, size: number): Headers {
  return new Headers({
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    'Access-Control-Allow-Origin': '*',
    'Timing-Allow-Origin': '*'
  });
}

async function serveR2(
  request: Request,
  bucket: R2MediaBucket,
  key: string
): Promise<Response | null> {
  const head = await bucket.head(key);
  if (!head) return null;

  const size = head.size;
  const headers = mediaHeaders(head.httpMetadata?.contentType || 'application/octet-stream', size);
  const method = request.method;
  const rangeHeader = request.headers.get('range');

  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  if (!rangeHeader) {
    const object = await bucket.get(key);
    if (!object?.body) return jsonError('Media not found.', 404);
    return new Response(object.body, { status: 200, headers });
  }

  const range = parseByteRange(rangeHeader, size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes' }
    });
  }

  const length = range.end - range.start + 1;
  const object = await bucket.get(key, { range: { offset: range.start, length } });
  if (!object?.body) return jsonError('Media not found.', 404);

  headers.set('Content-Length', String(length));
  headers.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + size);
  return new Response(object.body, { status: 206, headers });
}

async function serveKv(
  request: Request,
  namespace: KVNamespace,
  key: string
): Promise<Response> {
  const { value, metadata } = await namespace.getWithMetadata<MediaMetadata>(key, 'arrayBuffer');
  if (!value) return jsonError('Media not found.', 404);

  const data = value as ArrayBuffer;
  const size = data.byteLength;
  const headers = mediaHeaders(metadata?.contentType || 'application/octet-stream', size);

  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return new Response(data, { status: 200, headers });

  const range = parseByteRange(rangeHeader, size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes' }
    });
  }

  const chunk = data.slice(range.start, range.end + 1);
  headers.set('Content-Length', String(chunk.byteLength));
  headers.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + size);
  return new Response(chunk, { status: 206, headers });
}

export const onRequest = async ({ request, env }: MediaContext): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonError('Method not allowed.', 405);
  }

  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\\/media\\/([a-f0-9-]{36})$/i);
  if (!match) return jsonError('Media not found.', 404);

  const key = 'media/' + match[1];

  try {
    // R2 takes precedence for media migrated there; KV remains the current fallback.
    if (env.MEDIA_R2) {
      const r2Response = await serveR2(request, env.MEDIA_R2, key);
      if (r2Response) return r2Response;
    }

    if (!env.MEDIA) return jsonError('Media storage is not configured.', 503);
    return await serveKv(request, env.MEDIA, key);
  } catch (error) {
    // Do not expose internal storage details to public callers.
    return jsonError('Media could not be retrieved. Please try again.', 503);
  }
};
