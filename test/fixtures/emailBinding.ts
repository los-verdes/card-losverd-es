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
export function fakeEmailBinding(options: { failWith?: string; suppressed?: boolean } = {}): FakeEmailBinding {
  const send = vi.fn<(message: BindingMessage) => Promise<unknown>>(async (message) => {
    if (options.suppressed) {
      throw Object.assign(new Error("Suppressed recipient while dropping is off"), {
        code: "E_RECIPIENT_SUPPRESSED",
      });
    }
    if (options.failWith) throw new Error(options.failWith);
    // The real binding refuses anything but a bare address in `email`, and
    // an address object without a string `name`, and says so in these
    // words. Refusing them here too is what would have caught a display name
    // folded into the address, and a claim link sent to `{ email }` alone,
    // before a real send did.
    for (const address of [message.from, message.to]) {
      if (typeof address === "object" && typeof address.name !== "string") {
        throw new TypeError(
          "Incorrect type for the 'name' field on 'EmailAddress': the provided value is not of type 'string'.",
        );
      }
      const email = typeof address === "string" ? address : address.email;
      if (!/^[^\s<>()]+@[^\s<>()]+$/.test(email)) {
        throw new Error("Invalid email address: Invalid email user");
      }
    }
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
  return typeof message.to === "string" ? message.to : message.to.email;
}
