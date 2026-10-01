import path from "node:path";
import { ensureDir, writeJson, writeText } from "../util/fs-utils.js";
import { toMarkdown } from "../extraction/markdown.js";

// Persists a single crawled screen (real page or synthetic modal) to disk: screenshot,
// content.md, and meta.json under outDir/screens/<screenId>/, plus an AutoQA-knowledge-base-style
// copy of the same markdown under outDir/modules/<screenId>.md. Keeps all screen-directory
// layout/naming decisions in one place instead of scattered through the crawl loop.
export class ScreenWriter {
  #outDir;
  #logger;

  constructor(outDir, logger) {
    this.#outDir = outDir;
    this.#logger = logger;
  }

  async init() {
    await ensureDir(path.join(this.#outDir, "screens"));
    await ensureDir(path.join(this.#outDir, "modules"));
  }

  async writeScreen({ page, extracted, screenId, url, normalizedUrl, depth, discoveredVia, status }) {
    const screenDir = path.join(this.#outDir, "screens", screenId);
    await ensureDir(screenDir);

    await page.screenshot({ path: path.join(screenDir, "screenshot.png"), fullPage: true }).catch((err) => {
      this.#logger.warn(`screenshot failed for ${url}: ${err.message}`);
    });

    const markdown = toMarkdown(extracted);
    await writeText(path.join(screenDir, "content.md"), markdown);
    await writeText(path.join(this.#outDir, "modules", `${screenId}.md`), markdown);
    await writeJson(path.join(screenDir, "meta.json"), {
      screenId,
      url,
      normalizedUrl,
      depth,
      discoveredVia,
      title: extracted.title,
      httpStatus: status,
      crawledAt: new Date().toISOString(),
    });

    return { extracted, markdown };
  }

  // Same as writeScreen but for a modal captured on a disposable scratch page: no real URL/status,
  // and the scratch page is closed here once its screenshot has been taken.
  async writeModalScreen({ modalPage, modal, screenId, baseUrl, syntheticUrl, depth, discoveredVia, label, closePage = true }) {
    const extracted = {
      title: modal.title,
      metaDescription: "",
      headings: [],
      links: modal.links || [],
      buttons: modal.buttons,
      navCandidates: [],
      forms: modal.forms,
      tables: [],
      ariaSnapshot: modal.ariaSnapshot || "",
      bodyText: modal.bodyText,
      url: baseUrl,
      screenId,
      discoveredVia,
    };

    const screenDir = path.join(this.#outDir, "screens", screenId);
    await ensureDir(screenDir);
    await modalPage.screenshot({ path: path.join(screenDir, "screenshot.png"), fullPage: true }).catch((err) => {
      this.#logger.warn(`modal screenshot failed for "${label}": ${err.message}`);
    });
    if (closePage) await modalPage.close().catch(() => { });

    const markdown = toMarkdown(extracted);
    await writeText(path.join(screenDir, "content.md"), markdown);
    await writeText(path.join(this.#outDir, "modules", `${screenId}.md`), markdown);
    await writeJson(path.join(screenDir, "meta.json"), {
      screenId,
      url: baseUrl,
      normalizedUrl: syntheticUrl,
      depth,
      discoveredVia,
      title: modal.title,
      httpStatus: null,
      crawledAt: new Date().toISOString(),
    });

    return { extracted, markdown };
  }
}
