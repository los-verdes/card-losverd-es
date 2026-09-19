/**
 * The page a logged-out member lands on.
 *
 * `/login` used to redirect straight to Auth.js's built-in provider picker,
 * which meant two things. The first page of ours a member saw carried none of
 * the group's branding, and -- the reason this exists -- it offered signing in
 * and nothing else. `/email-card` has always been public and is the whole
 * answer for someone who has no Google or Apple account, or has one under a
 * different address, or simply does not want to hand us a login. It was
 * reachable only by knowing the URL.
 *
 * The providers themselves are still Auth.js's: the "sign in" link goes
 * exactly where `/login` went before. Rendering provider buttons here would
 * mean reimplementing the CSRF-protected POST that starts each flow, which is
 * a great deal of risk to save one click on a page that now has something
 * worth reading.
 */

import type { FC } from "hono/jsx";
import { MEMBERSHIP_STORE_URL } from "../member/portal";
import { Page, SUPPORT_EMAIL } from "../member/layout";

export interface LoginPageProps {
  /** Auth.js's provider picker, with the callback already set. */
  signInHref: string;
  /** Which providers are actually configured, so the page doesn't offer one that isn't. */
  providers: string[];
  /** Set when the member has just been sent back here by a sign-in that didn't complete. */
  failed?: boolean;
}

export const LoginPage: FC<LoginPageProps> = ({ signInHref, providers, failed }) => (
  <Page title="Your Membership Card">
    <h1>Los Verdes Membership Card</h1>

    {failed && (
      // Arriving back here having just signed in successfully elsewhere is
      // baffling without this: it reads as though nothing happened.
      <p style="color: #b00020">
        That sign-in didn't complete. Trying again often works. If it doesn't,
        you can still have your card emailed to you below.
      </p>
    )}

    {providers.length > 0 ? (
      <>
        <p>Sign in to see your card and add it to your phone.</p>
        <a href={signInHref} class="action">
          Sign in with {providers.join(" or ")}
        </a>
      </>
    ) : (
      <p>Signing in is unavailable at the moment.</p>
    )}

    <p class="muted" style="margin-top: 1.5rem">
      Haven't got one of those accounts, or joined under a different address?
    </p>
    <a href="/email-card" class="action">
      Email my card to me instead
    </a>

    <p class="muted" style="margin-top: 2rem">
      Not a member yet?{" "}
      <a href={MEMBERSHIP_STORE_URL}>Join Los Verdes</a>. Need a hand?{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
    </p>
  </Page>
);

/** The providers a member can actually pick, matching `authConfig`'s own checks. */
export function configuredProviders(env: {
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  APPLE_SIGNIN_KEY_ID?: string;
  APPLE_SIGNIN_PRIVATE_KEY_PEM?: string;
}): string[] {
  const providers: string[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) providers.push("Google");
  if (env.APPLE_SIGNIN_KEY_ID && env.APPLE_SIGNIN_PRIVATE_KEY_PEM) {
    providers.push("Apple");
  }
  return providers;
}

/** Callable without JSX, so `routes.ts` needn't become a `.tsx`. */
export function renderLoginPage(props: LoginPageProps) {
  return <LoginPage {...props} />;
}
