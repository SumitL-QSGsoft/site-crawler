import { gotoAndSettle, settleAfterAction, blockHeavyResources } from "../browser/navigation.js";

// Fills a GET form's visible fields with placeholder-ish values and submits it in a scratch page.
// GET-only by contract with the caller: submitting a form is how query-string-driven content
// (search/filter/pagination) is reached without ever POSTing/mutating anything on the target site.
export async function probeFormSubmission(context, url, formIndex) {
  const scratchPage = await context.newPage();
  await blockHeavyResources(scratchPage);
  try {
    await gotoAndSettle(scratchPage, url, { idleTimeout: 750 });
    const form = scratchPage.locator("form").nth(formIndex);
    if (!(await form.count())) return null;
    const fields = form.locator("input, select, textarea");
    for (let index = 0; index < await fields.count(); index++) {
      const field = fields.nth(index);
      if (!(await field.isVisible()) || !(await field.isEnabled())) continue;
      const type = (await field.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "button", "reset", "file", "checkbox", "radio", "password"].includes(type)) continue;
      const tag = await field.evaluate((element) => element.tagName.toLowerCase());
      if (tag === "select") {
        const option = await field.locator("option:not([disabled])").evaluateAll((options) =>
          options.find((entry) => entry.value)?.value || null);
        if (option) await field.selectOption(option);
      } else if (!(await field.inputValue())) {
        const value = type === "email" ? "crawler@example.com" : type === "url" ? "https://example.com"
          : type === "number" ? "1" : type === "date" ? "2020-01-01" : "test";
        await field.fill(value);
      }
    }

    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    if (await submit.count() && (await submit.getAttribute("formmethod"))?.toLowerCase() === "post") return null;
    if (await submit.count() && await submit.isVisible() && await submit.isEnabled()) {
      await submit.click({ timeout: 3000 });
    } else {
      await form.evaluate((element) => element.requestSubmit());
    }
    await settleAfterAction(scratchPage, url);
    return scratchPage.url();
  } finally {
    await scratchPage.close().catch(() => { });
  }
}
