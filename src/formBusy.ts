/**
 * Every form on the site says it is working once submitted, and cannot be
 * submitted twice while it is.
 *
 * The forms are ordinary server-rendered posts, so between the click and the
 * next page there is nothing on screen to say anything happened -- and some
 * of those requests take a moment (a card rendered and signed, a Turnstile
 * check, a batch of admin grants). People click again, and the second click
 * is a second request.
 *
 * One listener on the document covers every form, present and future. It
 * marks the form `aria-busy` and relabels the button that was pressed. It
 * deliberately does not *disable* that button: a disabled button's name and
 * value are left out of the submission, and several forms here tell their
 * buttons apart that way (`action=save` / `action=clear`). A second submit is
 * stopped by the form's own busy flag instead.
 *
 * A page restored from the back/forward cache comes back exactly as it was
 * left -- busy -- so `pageshow` puts it back to rest.
 *
 * Inline rather than a separate file: it is a few hundred bytes, every page
 * needs it, and it saves a request on each one. Without JavaScript the forms
 * work exactly as before, just without the busy state.
 */
export const FORM_BUSY_SCRIPT = `
document.addEventListener("submit", function (event) {
  var form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
  if (form.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
  form.setAttribute("aria-busy", "true");
  var button = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
  if (button) {
    button.setAttribute("data-idle-label", button.textContent);
    button.textContent = button.getAttribute("data-busy-label") || "Working\\u2026";
    button.setAttribute("aria-disabled", "true");
  }
});
window.addEventListener("pageshow", function (event) {
  if (!event.persisted) return;
  document.querySelectorAll('form[aria-busy="true"]').forEach(function (form) {
    form.removeAttribute("aria-busy");
    form.querySelectorAll("[data-idle-label]").forEach(function (button) {
      button.textContent = button.getAttribute("data-idle-label");
      button.removeAttribute("data-idle-label");
      button.removeAttribute("aria-disabled");
    });
  });
});
`;
