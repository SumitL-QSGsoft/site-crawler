import { gotoAndSettle, settleAfterAction, blockHeavyResources } from "../browser/navigation.js";

// Fills a GET form's visible fields with placeholder-ish values and submits it in a scratch page.
// GET-only by contract with the caller: submitting a form is how query-string-driven content
// (search/filter/pagination) is reached without ever POSTing/mutating anything on the target site.
export async function probeFormSubmission(context, url, formIndex) {
  const scratchPage = await context.newPage();
  await blockHeavyResources(scratchPage);
  try {
    await gotoAndSettle(scratchPage, url);
    const submitted = await scratchPage.evaluate((idx) => {
      const { deepQueryAll, isVisible } = window.__crawlerHelpers;
      const form = deepQueryAll("form")[idx];
      if (!form) return false;

      [...form.querySelectorAll("input, select, textarea")].filter(isVisible).forEach((field) => {
        const tag = field.tagName.toLowerCase();
        if (tag === "select") {
          if (field.options.length) field.value = field.options[0].value;
        } else if (field.type === "checkbox" || field.type === "radio") {
          // leave pre-set toggles alone; don't change their semantics
        } else if (!["hidden", "submit", "button"].includes(field.type) && !field.value) {
          field.value = field.placeholder && /^[\w .-]+$/.test(field.placeholder) ? field.placeholder : "test";
        }
      });

      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return true;
    }, formIndex);

    if (!submitted) return null;
    await settleAfterAction(scratchPage, url);
    return scratchPage.url();
  } finally {
    await scratchPage.close().catch(() => { });
  }
}
