/**
 * Who has asked not to be emailed, kept in Cloudflare Email Service's own
 * suppression list rather than a table of ours.
 *
 * The list already exists and already does the enforcing: the binding refuses
 * a send to a suppressed address (`E_RECIPIENT_SUPPRESSED`), and Cloudflare
 * adds hard bounces and spam complaints to it by itself. What it does not do
 * is process unsubscribe links, so this module is the small part that adds an
 * address when somebody follows one, and removes it when they change their
 * mind. Reading and writing it takes an API token with the account's
 * **Email Sending: Edit** permission (`EMAIL_SUPPRESSIONS_API_TOKEN`).
 *
 * The list is account-wide, so staging and production share it. That is the
 * right answer for a person -- "stop emailing me" does not depend on which
 * deployment sent the message -- and staging may only email test mailboxes in
 * any case.
 *
 * API reference:
 * https://developers.cloudflare.com/api/resources/email_sending/subresources/suppressions/
 */

export interface SuppressionsEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  EMAIL_SUPPRESSIONS_API_TOKEN?: string;
}

/** One row of the list, as much of it as this project reads. */
export interface Suppression {
  id: string;
  email: string;
  reason: string;
  /** Rows Cloudflare manages itself, such as a complaint, can't be removed. */
  read_only: boolean;
}

interface ApiEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
}

/** Whether this environment can manage the list at all. */
export function isSuppressionListConfigured(env: SuppressionsEnv): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.EMAIL_SUPPRESSIONS_API_TOKEN);
}

async function call<T>(
  env: SuppressionsEnv,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!isSuppressionListConfigured(env)) {
    throw new Error(
      "The email suppression list is not configured: EMAIL_SUPPRESSIONS_API_TOKEN (Email Sending: Edit) is unset",
    );
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/suppressions${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.EMAIL_SUPPRESSIONS_API_TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const envelope = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !envelope?.success) {
    const reason = envelope?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare suppression list ${method} failed: ${reason}`);
  }
  return envelope.result;
}

/**
 * Reads one row of the list, to prove the token can reach it -- for the
 * readiness page, which would otherwise learn about a token with the wrong
 * permission only when a member's unsubscribe failed.
 */
export async function checkSuppressionListAccess(env: SuppressionsEnv): Promise<void> {
  await call<Suppression[]>(env, "GET", "?per_page=1");
}

/** Every row for this exact address. Usually none, occasionally more than one. */
export async function findSuppressions(env: SuppressionsEnv, email: string): Promise<Suppression[]> {
  const query = new URLSearchParams({ email: email.toLowerCase(), per_page: "100" });
  return call<Suppression[]>(env, "GET", `?${query}`);
}

/**
 * Adds the address, permanently, unless it is already there. The check comes
 * first because the API documents no answer for adding an address twice, and
 * a second row would mean undoing it takes two deletes.
 */
export async function suppressAddress(env: SuppressionsEnv, email: string, note: string): Promise<void> {
  if ((await findSuppressions(env, email)).length > 0) return;
  await call(env, "POST", "", { email: email.toLowerCase(), note });
}

/**
 * Removes the rows this project can remove. A row Cloudflare added for a
 * bounce or a complaint is read-only and stays: an address with one still
 * receives nothing, whatever the member asks.
 */
export async function unsuppressAddress(env: SuppressionsEnv, email: string): Promise<void> {
  const rows = await findSuppressions(env, email);
  for (const row of rows.filter((r) => !r.read_only)) {
    await call(env, "DELETE", `/${encodeURIComponent(row.id)}`);
  }
}
