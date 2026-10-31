import { createHash, createHmac } from 'node:crypto';

/** RFC 3986, plus the four characters `encodeURIComponent` leaves alone. */
export const uriEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

const hmac = (key: string | Uint8Array, value: string) =>
  createHmac('sha256', key).update(value).digest();

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/** The canonical query: pairs sorted by name then value, each part encoded. */
const canonicalQuery = (search: string) => {
  if (search === '' || search === '?') {
    return '';
  }
  return search
    .slice(1)
    .split('&')
    .map((pair) => {
      const cut = pair.indexOf('=');
      const name = cut < 0 ? pair : pair.slice(0, cut);
      const value = cut < 0 ? '' : pair.slice(cut + 1);
      return {
        name: uriEncode(decodeURIComponent(name)),
        value: uriEncode(decodeURIComponent(value)),
      };
    })
    .sort(
      (left, right) =>
        compare(left.name, right.name) || compare(left.value, right.value),
    )
    .map((pair) => `${pair.name}=${pair.value}`)
    .join('&');
};

/** `2013-05-24T00:00:00.000Z` becomes `20130524T000000Z`. */
const amzStamp = (at: Date) =>
  at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

export interface Sigv4Request {
  readonly method: string;
  readonly url: string;
  /** Headers to sign besides the ones this adds (e.g. `if-match`). */
  readonly headers: Readonly<Record<string, string>>;
  /** The hex sha256 of the body, or of the empty string for no body. */
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly at: Date;
}

/**
 * AWS Signature Version 4 (the S3 flavour) — hand-rolled because it is a
 * hundred lines of hashing and the AWS SDK is a hundred packages. R2 speaks the
 * same signature, so this serves both. Returns the headers to send (with the
 * `Authorization` value among them, and `host` deliberately left out) .
 */
export const sign = (request: Sigv4Request) => {
  const parsed = new URL(request.url);
  const date = amzStamp(request.at);
  const dateStamp = date.slice(0, 8);

  const headers = new Map<string, string>([
    ['host', parsed.host],
    ['x-amz-content-sha256', request.payloadHash],
    ['x-amz-date', date],
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    headers.set(name.toLowerCase(), value.trim());
  }

  const names = [...headers.keys()].sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers.get(name) ?? ''}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method.toUpperCase(),
    parsed.pathname,
    canonicalQuery(parsed.search),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${request.secretAccessKey}`, dateStamp), request.region),
      request.service,
    ),
    'aws4_request',
  );
  const signature = Buffer.from(hmac(key, stringToSign)).toString('hex');

  return {
    headers: Object.fromEntries(
      [...headers].filter(([name]) => name !== 'host'),
    ),
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', '),
  };
};
