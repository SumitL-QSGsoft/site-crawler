import { gotoAndSettle, blockHeavyResources } from "../browser/navigation.js";
import { extractScreen } from "../extraction/screen-extractor.js";

// A password field (or a /login-ish URL) means we hit a login wall the crawl can't get past on its own.
export function looksLikeLoginPage(extracted, url) {
  const hasPasswordField = extracted.forms.some((f) => f.fields.some((field) => field.type === "password"));
  const urlLooksLikeLogin = /\/(login|signin|sign-in|log-in|auth)(\/|$|\?)/i.test(url);
  return hasPasswordField || urlLooksLikeLogin;
}

// After an auto-filled credentials login, confirms we actually got past the login wall. If it still
// looks like a login page, the site likely needs MFA/OTP/CAPTCHA that can't be automated here.
export async function verifyLoginSucceeded(browserManager, storageState, url) {
  const context = await browserManager.newContext({ storageState });
  try {
    const page = await context.newPage();
    await blockHeavyResources(page);
    await gotoAndSettle(page, url);
    const extracted = await extractScreen(page);
    return !looksLikeLoginPage(extracted, page.url());
  } catch {
    return true; // don't block the crawl over a verification hiccup
  } finally {
    await context.close().catch(() => { });
  }
}
