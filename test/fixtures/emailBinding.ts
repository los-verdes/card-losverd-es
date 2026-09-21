/**
 * A stand-in for the `send_email` binding (src/email/cloudflare.ts) that
 * records every message it is handed.
 *
 * Tests set it on `env.EMAIL` and read `sent` back, rather than spying on
 * `fetch`: the binding is a method call, not an HTTP request, so there is no
 * request body to intercept. What is recorded is exactly what the binding
 * would have received -- the same object a real send carries.
 */

import { vi } from "vitest";
import type { BindingMessage, SendEmailBinding } from "../../src/email/cloudflare";

export interface FakeEmailBinding extends SendEmailBinding {
  send: ReturnType<typeof vi.fn<(message: BindingMessage) => Promise<unknown>>>;
  /**
   * Every message handed to `send`, in order -- including ones it rejected.
   *
   * Read from the mock's own call history rather than kept in a separate
   * list, so `vi.clearAllMocks()` empties it too. A test that sends once,
   * clears, and then checks a second request sent nothing relies on exactly
   * that, as it did when these were `fetch` spies.
   */
  readonly sent: BindingMessage[];
}

/**
 * `failWith` makes every send throw, as the binding does when it rejects a
 * message -- the equivalent of a mail service answering with an error.
 * `suppressed` throws the way it does for an address on the account's
 * suppression list: with the documented `code`.
 */
export function fakeEmailBinding(
  options: { failWith?: string; suppressed?: boolean } = {},
): FakeEmailBinding {
  const send = vi.fn<(message: BindingMessage) => Promise<unknown>>(async () => {
    if (options.suppressed) {
      throw Object.assign(new Error("Suppressed recipient while dropping is off"), {
        code: "E_RECIPIENT_SUPPRESSED",
      });
    }
    if (options.failWith) throw new Error(options.failWith);
    return undefined;
  });
  return {
    send,
    get sent() {
      return send.mock.calls.map(([message]) => message);
    },
  };
}

/** The bare address a message went to, whether or not a name was attached. */
export function recipientOf(message: BindingMessage): string {
  return message.to.match(/<([^>]+)>$/)?.[1] ?? message.to;
}
