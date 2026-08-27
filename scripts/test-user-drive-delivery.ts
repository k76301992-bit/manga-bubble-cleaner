import { readFile } from "node:fs/promises";
import { cleanBatchInMemory, extractImagesFromZip } from "../server/standalone/batch-processing";
import { createGoogleDriveResultFolder } from "../server/standalone/google-drive";

async function main() {
  const archive = await readFile("/home/ubuntu/upload/أرشيف.zip");
  const images = await extractImagesFromZip(archive);
  const results = await cleanBatchInMemory({ images, quality: "maximum-detail" });
  const folder = await createGoogleDriveResultFolder({ sourceName: "archive-oauth-verification", results });
  console.log(JSON.stringify({ inputPages: images.length, outputPages: results.length, folderId: folder.id, url: folder.url }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
