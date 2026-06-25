import crypto from "node:crypto";

const USER_AGENT = "b2ai-openclaw";

export type B2Client = {
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  listObjects(bucket: string, prefix: string): Promise<B2ObjectEntry[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headBucket(bucket: string): Promise<void>;
};

export type B2ClientWithPrefixes = B2Client & {
  listPrefixes(bucket: string, prefix: string): Promise<string[]>;
};

export type B2ObjectEntry = {
  key: string;
  size: number;
  lastModified: string;
};

type S3SignParams = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array | "";
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
};

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Uint8Array | ""): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function signRequest(params: S3SignParams): Record<string, string> {
  const { method, path, query, headers, body, region, accessKeyId, secretAccessKey } = params;
  const service = params.service ?? "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const signedHeaders = { ...headers };
  signedHeaders["x-amz-date"] = amzDate;
  signedHeaders["x-amz-content-sha256"] = payloadHash;

  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k.toLowerCase()}:${signedHeaders[k]!.trim()}`)
    .join("\n");
  const signedHeadersList = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

  const queryStr = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
        .join("&")
    : "";

  const canonicalRequest = [
    method,
    path,
    queryStr,
    `${canonicalHeaders}\n`,
    signedHeadersList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    ...signedHeaders,
    authorization,
  };
}

export { signRequest as _signRequest, parseListObjectsResponse as _parseListObjectsResponse };

export async function createB2Client(
  keyId: string,
  applicationKey: string,
  region?: string,
): Promise<B2Client> {
  // Authorize with B2 to discover the region if not provided.
  const resolvedRegion = region ?? (await discoverRegion(keyId, applicationKey));
  const endpoint = `https://s3.${resolvedRegion}.backblazeb2.com`;

  const sign = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array | "" = "",
    query?: Record<string, string>,
  ) =>
    signRequest({
      method,
      path,
      query,
      headers: { ...headers, "user-agent": USER_AGENT },
      body,
      region: resolvedRegion,
      accessKeyId: keyId,
      secretAccessKey: applicationKey,
    });

  const client: B2ClientWithPrefixes = {
    async putObject(bucket, key, body, contentType) {
      const path = `/${bucket}/${key}`;
      const headers = sign("PUT", path, { host: new URL(endpoint).host, "content-type": contentType }, body);
      const resp = await fetch(`${endpoint}${path}`, {
        method: "PUT",
        headers,
        body: new Uint8Array(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 putObject failed (${resp.status}): ${text}`);
      }
    },

    async getObject(bucket, key) {
      const path = `/${bucket}/${key}`;
      const headers = sign("GET", path, { host: new URL(endpoint).host });
      const resp = await fetch(`${endpoint}${path}`, {
        method: "GET",
        headers,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 getObject failed (${resp.status}): ${text}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    },

    async listObjects(bucket, prefix) {
      const all: B2ObjectEntry[] = [];
      let continuationToken: string | undefined;

      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          "max-keys": "1000",
        };
        if (continuationToken) {
          query["continuation-token"] = continuationToken;
        }
        const reqPath = `/${bucket}`;
        const headers = sign("GET", reqPath, { host: new URL(endpoint).host }, "", query);
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const resp = await fetch(`${endpoint}${reqPath}?${qs}`, {
          method: "GET",
          headers,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`b2 listObjects failed (${resp.status}): ${text}`);
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.entries);
        continuationToken = page.nextToken;
      } while (continuationToken);

      return all;
    },

    async listPrefixes(bucket, prefix) {
      const all: string[] = [];
      let continuationToken: string | undefined;

      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          delimiter: "/",
          "max-keys": "1000",
        };
        if (continuationToken) {
          query["continuation-token"] = continuationToken;
        }
        const reqPath = `/${bucket}`;
        const headers = sign("GET", reqPath, { host: new URL(endpoint).host }, "", query);
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const resp = await fetch(`${endpoint}${reqPath}?${qs}`, {
          method: "GET",
          headers,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`b2 listPrefixes failed (${resp.status}): ${text}`);
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.prefixes);
        continuationToken = page.nextToken;
      } while (continuationToken);

      return all;
    },

    async deleteObject(bucket, key) {
      const path = `/${bucket}/${key}`;
      const headers = sign("DELETE", path, { host: new URL(endpoint).host });
      const resp = await fetch(`${endpoint}${path}`, {
        method: "DELETE",
        headers,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 deleteObject failed (${resp.status}): ${text}`);
      }
    },

    async headBucket(bucket) {
      const path = `/${bucket}`;
      const headers = sign("HEAD", path, { host: new URL(endpoint).host });
      const resp = await fetch(`${endpoint}${path}`, {
        method: "HEAD",
        headers,
      });
      if (!resp.ok) {
        throw new Error(`b2 headBucket failed (${resp.status})`);
      }
    },
  };

  return client;
}

async function discoverRegion(keyId: string, applicationKey: string): Promise<string> {
  const auth = Buffer.from(`${keyId}:${applicationKey}`).toString("base64");
  const resp = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { authorization: `Basic ${auth}`, "user-agent": USER_AGENT },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`b2 authorize failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as {
    s3ApiUrl?: string;
    apiInfo?: { storageApi?: { s3ApiUrl?: string } };
  };
  // v3 nests s3ApiUrl under apiInfo.storageApi; v2 has it at top level
  const s3ApiUrl = data.apiInfo?.storageApi?.s3ApiUrl ?? data.s3ApiUrl;
  const match = s3ApiUrl?.match(/s3\.([^.]+)\.backblazeb2\.com/);
  if (!match?.[1]) {
    throw new Error("b2: could not determine region from authorize response");
  }
  return match[1];
}

type ListObjectsPage = {
  entries: B2ObjectEntry[];
  prefixes: string[];
  nextToken: string | undefined;
};

function parseListObjectsResponse(xml: string): ListObjectsPage {
  const entries: B2ObjectEntry[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const key = block.match(/<Key>(.*?)<\/Key>/)?.[1] ?? "";
    const size = Number(block.match(/<Size>(.*?)<\/Size>/)?.[1] ?? "0");
    const lastModified = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] ?? "";
    entries.push({ key, size, lastModified });
  }

  const prefixes: string[] = [];
  const commonPrefixRegex = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  while ((match = commonPrefixRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const prefix = block.match(/<Prefix>([\s\S]*?)<\/Prefix>/)?.[1]?.trim() ?? "";
    if (prefix) {
      prefixes.push(prefix);
    }
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = isTruncated
    ? xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]
    : undefined;

  return { entries, prefixes, nextToken };
}
