import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { hasLikelyClosedBubbleOutline, hasSmoothBubbleBackdrop } from "../server/standalone/cleaner";
import { requestLocalComicTextDetectionWithMask } from "../server/standalone/inpainting-client";

const sourcePath = `/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation/originals/${process.env.PAGE_NAME || "IMG_7546.jpeg"}`;
const TILE_HEIGHT = 2400;
const TILE_OVERLAP = 56;
const targets = process.env.TARGETS_JSON ? JSON.parse(process.env.TARGETS_JSON) as Array<{ label: string; y: number }> : [{ label: "فقاعة منحنيّة فائتة", y: 6550 }, { label: "فقاعة حوار فائتة", y: 9560 }];

async function main() {
  const image = await readFile(sourcePath);
  const metadata = await sharp(image).metadata();
  const width = metadata.width!; const height = metadata.height!;
  const report = [];
  for (let tileIndex = 0; tileIndex < Math.ceil(height / TILE_HEIGHT); tileIndex += 1) {
    const coreTop = tileIndex * TILE_HEIGHT; const coreHeight = Math.min(TILE_HEIGHT, height - coreTop);
    const top = Math.max(0, coreTop - TILE_OVERLAP); const bottom = Math.min(height, coreTop + coreHeight + TILE_OVERLAP);
    const tile = await sharp(image).extract({ left: 0, top, width, height: bottom - top }).ensureAlpha().raw().toBuffer();
    const vision = await sharp(tile, { raw: { width, height: bottom - top, channels: 4 } }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    const detection = await requestLocalComicTextDetectionWithMask(vision);
    const accepted = (detection?.regions ?? []).map((region) => ({
      ...region,
      globalY: region.y + top,
      closedOutline: hasLikelyClosedBubbleOutline(tile, width, bottom - top, region),
      smoothBackdrop: hasSmoothBubbleBackdrop(tile, width, bottom - top, region),
    }));
    report.push({
      tileIndex,
      core: [coreTop, coreTop + coreHeight],
      input: [top, bottom],
      textMaskBytes: detection?.textMask?.length ?? 0,
      expectedTextMaskBytes: width * (bottom - top),
      textMaskNonzero: detection?.textMask?.reduce((count, value) => count + (value > 0 ? 1 : 0), 0) ?? 0,
      candidatesAtTargets: targets.map((target) => ({
        ...target,
        matching: accepted.filter((region) => target.y >= region.globalY - 70 && target.y <= region.globalY + region.height + 70).map((region) => {
          let masked = 0;
          for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) if (detection?.textMask?.[y * width + x]) masked += 1;
          return { ...region, textMaskCoverage: Number((masked / Math.max(1, region.width * region.height)).toFixed(4)) };
        }),
      })),
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
