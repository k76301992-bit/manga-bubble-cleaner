import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { hasLikelyClosedBubbleOutline, hasNeutralLightBubbleInterior, hasSmoothBubbleBackdrop } from "../server/standalone/cleaner";
import { requestLocalComicTextDetection } from "../server/standalone/inpainting-client";

const root = "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation";
const originals = join(root, "originals");

async function main() {
  const report = [];
  for (const name of (await readdir(originals)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
    const image = await readFile(join(originals, name));
    const decoded = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const regions = await requestLocalComicTextDetection(image) ?? [];
    report.push({
      name,
      regions: regions.map(({ confidence, ...region }) => ({
        ...region,
        confidence,
        closedOutline: hasLikelyClosedBubbleOutline(decoded.data, decoded.info.width, decoded.info.height, region),
        smoothBackdrop: hasSmoothBubbleBackdrop(decoded.data, decoded.info.width, decoded.info.height, region),
        neutralInterior: hasNeutralLightBubbleInterior(decoded.data, decoded.info.width, decoded.info.height, region),
      })),
    });
  }
  const destination = join(root, "full-page-detector-guard-report.json");
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ destination, summary: report.map((page) => ({ name: page.name, regions: page.regions.length, colouredCandidates: page.regions.filter((region) => region.closedOutline && region.smoothBackdrop && !region.neutralInterior).length })) }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
