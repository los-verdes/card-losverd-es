// Uploads to an R2 bucket only the files whose contents differ from what the
// bucket already holds, through Cloudflare's REST API -- the same object
// endpoint `wrangler r2 object put` calls, without starting wrangler once per
// file. Used by `just r2-upload-templates` (scripts/r2-sync-templates.mjs).
//
// An object's ETag is the MD5 of its contents when it was uploaded in one
// piece, which is how everything here is uploaded; a multipart ETag ("…-N")
// never matches an MD5, so such an object is simply uploaded again.

export interface LocalFile {
  key: string;
  md5: string;
  contentType: string;
  body: Uint8Array;
}

export interface R2Api {
  base: string;
  token: string;
  accountId: string;
  bucket: string;
  fetch?: typeof fetch;
  /** The first retry's wait; each later one doubles it. */
  retryDelayMs?: number;
}

const objectsUrl = (api: R2Api) =>
  `${api.base}/accounts/${encodeURIComponent(api.accountId)}/r2/buckets/${encodeURIComponent(api.bucket)}/objects`;

/** An object key as a URL path, each segment encoded and the slashes kept. */
const keyPath = (key: string) => key.split("/").map(encodeURIComponent).join("/");

const normalizeEtag = (etag: string) => etag.replace(/^W\//, "").replace(/"/g, "").toLowerCase();

async function call(api: R2Api, url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  const doFetch = api.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(url, { ...init, headers: { Authorization: `Bearer ${api.token}`, ...init.headers } });
    // Rate limits and the API's own hiccups are worth another try; anything
    // else (a bad token, a missing bucket) is not.
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, (api.retryDelayMs ?? 250) * 2 ** (attempt - 1)));
      continue;
    }
    return res;
  }
}

/** Every object under `prefix`, as key -> ETag. */
export async function listEtags(api: R2Api, prefix: string): Promise<Map<string, string>> {
  const etags = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const url = new URL(objectsUrl(api));
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await call(api, url.toString());
    const body = (await res.json()) as {
      success: boolean;
      errors?: unknown[];
      result?: { key: string; etag: string }[];
      result_info?: { cursor?: string; is_truncated?: boolean };
    };
    if (!res.ok || !body.success) {
      throw new Error(`listing ${api.bucket}/${prefix} failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
    }
    for (const object of body.result ?? []) etags.set(object.key, normalizeEtag(object.etag));
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
  } while (cursor);
  return etags;
}

/** The files whose contents the bucket does not already hold. */
export function filesToUpload(files: LocalFile[], remote: Map<string, string>): LocalFile[] {
  return files.filter((file) => remote.get(file.key) !== file.md5.toLowerCase());
}

export async function putObject(api: R2Api, file: LocalFile): Promise<void> {
  const res = await call(api, `${objectsUrl(api)}/${keyPath(file.key)}`, {
    method: "PUT",
    headers: { "Content-Type": file.contentType },
    // A copy, so the body is backed by a plain ArrayBuffer whatever the caller read it into.
    body: new Uint8Array(file.body),
  });
  if (!res.ok) {
    throw new Error(`uploading ${api.bucket}/${file.key} failed (${res.status}): ${await res.text()}`);
  }
  await res.body?.cancel();
}

/** Runs `task` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface SyncResult {
  uploaded: string[];
  unchanged: number;
}

/**
 * Uploads what differs, then lists the bucket again and fails unless every
 * file is there with the right contents, so a deploy never goes ahead on the
 * word of a PUT alone.
 */
export async function syncFiles(
  api: R2Api,
  prefix: string,
  files: LocalFile[],
  { concurrency = 8, dryRun = false }: { concurrency?: number; dryRun?: boolean } = {},
): Promise<SyncResult> {
  const changed = filesToUpload(files, await listEtags(api, prefix));
  if (dryRun) return { uploaded: changed.map((file) => file.key), unchanged: files.length - changed.length };
  await eachLimited(changed, concurrency, (file) => putObject(api, file));
  if (changed.length > 0) {
    const stale = filesToUpload(files, await listEtags(api, prefix));
    if (stale.length > 0) {
      throw new Error(`after uploading, ${api.bucket} still differs for: ${stale.map((file) => file.key).join(", ")}`);
    }
  }
  return { uploaded: changed.map((file) => file.key), unchanged: files.length - changed.length };
}
