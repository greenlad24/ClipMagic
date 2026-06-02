/**
 * Minimal R2 (S3-compatible) PutObject via AWS Signature V4.
 *
 * Uses crypto.subtle available in Cloudflare Workers.
 * Backend only — do not import from frontend code.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key instanceof ArrayBuffer ? key : new Uint8Array(key).buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  let key = await hmacSha256(new TextEncoder().encode('AWS4' + secret), date);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, SERVICE);
  key = await hmacSha256(key, 'aws4_request');
  return key;
}

/**
 * Upload a text/binary blob to R2 and return its public URL.
 * Uses env vars: ZITE_R2_ACCOUNT_ID, ZITE_R2_ACCESS_KEY_ID,
 * ZITE_R2_SECRET_ACCESS_KEY, ZITE_R2_BUCKET_NAME, ZITE_R2_PUBLIC_URL.
 */
export async function putToR2(
  key: string,
  body: string,
  contentType: string,
): Promise<string> {
  const accountId = process.env.ZITE_R2_ACCOUNT_ID;
  const accessKeyId = process.env.ZITE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ZITE_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.ZITE_R2_BUCKET_NAME;
  const publicUrl = process.env.ZITE_R2_PUBLIC_URL;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 credentials are not fully configured.');
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const payloadHash = await sha256Hex(body);
  const canonicalUri = `/${bucket}/${key}`;

  const headers: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'content-type': contentType,
  };

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeadersStr = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = [
    'PUT', canonicalUri, '', canonicalHeaders, signedHeadersStr, payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(secretAccessKey, dateStamp, region);
  const signatureBuf = await hmacSha256(signingKey, stringToSign);
  const signature = [...new Uint8Array(signatureBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const authHeader = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, Authorization: authHeader },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new Error(`R2 PUT failed (${res.status}): ${errText}`);
  }

  // Return the public URL
  if (publicUrl) {
    return `${publicUrl.replace(/\/+$/, '')}/${key}`;
  }
  // Fallback: construct a public URL from the account
  return `https://${host}/${bucket}/${key}`;
}
