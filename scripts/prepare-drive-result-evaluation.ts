import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractImagesFromZip } from "../server/standalone/batch-processing";
import { readGoogleDriveSource } from "../server/standalone/google-drive";

const root = "/home/ubuntu/manga-bubble-cleaner-retained-fixtures/drive-result-evaluation";
const folderUrl = "https://drive.google.com/drive/folders/1lxeY77ps1ise0KpKC3GZ1b4_jXkmw3rF";

async function main() {
  const [archive, driveSource] = await Promise.all([
    readFile("/home/ubuntu/upload/أرشيف.zip"),
    readGoogleDriveSource(folderUrl),
  ]);
  const originals = await extractImagesFromZip(archive);
  await Promise.all([mkdir(join(root, "originals"), { recursive: true }), mkdir(join(root, "results"), { recursive: true })]);
  await Promise.all(originals.map((file) => writeFile(join(root, "originals", file.name), file.image)));
  await Promise.all(driveSource.images.map((file) => writeFile(join(root, "results", file.name), file.image)));
  console.log(JSON.stringify({ root, originals: originals.map((file) => file.name), results: driveSource.images.map((file) => file.name) }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
