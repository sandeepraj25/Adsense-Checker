import type { AnalyzerDef } from "../contract";

/**
 * Images without width and height, which make the page jump as they load
 * (layout shift). Explicit width/height attributes, or a CSS width and
 * height or aspect-ratio in the image's own style, count as dimensions.
 */

export const analyzer: AnalyzerDef = {
  key: "images_without_dimensions",
  name: "Images without dimensions",
  category: "technical",
  defaultPlan: "pro",
  scope: "page",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const $ = ctx.$;
    const images = $("img").toArray();
    const missing = images.filter((el) => {
      const img = $(el);
      const style = img.attr("style") ?? "";
      const attrs = Boolean(img.attr("width")) && Boolean(img.attr("height"));
      const css = (/(?:^|;)\s*width\s*:/i.test(style) && /(?:^|;)\s*height\s*:/i.test(style)) || /aspect-ratio\s*:/i.test(style);
      return !attrs && !css;
    });
    const features = { images: images.length, images_missing_dimensions: missing.length };
    if (missing.length < 2) {
      return { status: "pass", findings: [], recommendation: "", summary: images.length === 0 ? "No images on this page." : `${images.length - missing.length} of ${images.length} image(s) have dimensions.`, features };
    }
    return {
      status: "warn",
      findings: missing.slice(0, 10).map((el) => ({ message: "Image without width and height.", evidence: ($(el).attr("src") ?? $(el).attr("data-src") ?? "(no src)").slice(0, 160), pageUrl: ctx.url })),
      recommendation: "Add width and height attributes (the image's real size) to every <img>. The browser then reserves the space and the page doesn't jump while loading.",
      summary: `${missing.length} of ${images.length} images have no width and height.`,
      features,
    };
  },
};
