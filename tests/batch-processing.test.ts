import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createResultZip, extractImagesFromZip, isArchiveMetadataEntry, MAX_IMAGES_PER_BATCH, naturalNameCompare, outputNameForSource, validateBatchImages } from "../server/standalone/batch-processing";
import { parseGoogleDriveUrl } from "../server/standalone/google-drive";

describe("batch processing sources", () => {
  it("keeps natural page ordering and creates safe PNG result names", () => {
    expect(["page-10.webp", "page-2.webp", "page-1.webp"].sort(naturalNameCompare)).toEqual(["page-1.webp", "page-2.webp", "page-10.webp"]);
    expect(outputNameForSource("الفصل 01/page 001.webp")).toBe("page-001-clean.png");
  });

  it("extracts only supported image files from an in-memory ZIP", async () => {
    const zip = new JSZip();
    zip.file("chapter/page-10.webp", Buffer.from([1, 2, 3]));
    zip.file("chapter/page-2.png", Buffer.from([4, 5, 6]));
    zip.file("chapter/readme.txt", "ignored");
    const images = await extractImagesFromZip(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
    expect(images.map((image) => image.name)).toEqual(["page-2.png", "page-10.webp"]);
  });

  it("ignores macOS resource forks that misleadingly end in image extensions", async () => {
    const zip = new JSZip();
    zip.file("IMG_7482.webp", Buffer.from([1, 2, 3]));
    zip.file("__MACOSX/._IMG_7482.webp", Buffer.from([0, 1, 2, 3]));
    zip.file("chapter/._IMG_7546.jpeg", Buffer.from([0, 1]));
    const images = await extractImagesFromZip(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
    expect(images.map((image) => image.name)).toEqual(["IMG_7482.webp"]);
    expect(isArchiveMetadataEntry("__MACOSX/._IMG_7482.webp")).toBe(true);
  });

  it("allows a twelve-page chapter while retaining a total-memory limit", () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({ name: `page-${index + 1}.png`, mimeType: "image/png", image: Buffer.from([index]) }));
    expect(MAX_IMAGES_PER_BATCH).toBe(12);
    expect(() => validateBatchImages(pages)).not.toThrow();
  });

  it("returns a ZIP result with the cleaned output names", async () => {
    const resultZip = await createResultZip([
      { sourceName: "page-1.webp", outputName: "page-1-clean.png", image: Buffer.from([1, 2, 3]) },
      { sourceName: "page-2.webp", outputName: "page-2-clean.png", image: Buffer.from([4, 5, 6]) },
    ]);
    const archive = await JSZip.loadAsync(resultZip);
    expect(Object.keys(archive.files).sort()).toEqual(["page-1-clean.png", "page-2-clean.png"]);
  });

  it("accepts supported Drive file and folder URLs only", () => {
    expect(parseGoogleDriveUrl("https://drive.google.com/drive/folders/folder_A-1")).toEqual({ type: "folder", id: "folder_A-1" });
    expect(parseGoogleDriveUrl("https://drive.google.com/file/d/file_A-1/view?usp=sharing")).toEqual({ type: "file", id: "file_A-1" });
    expect(parseGoogleDriveUrl("https://example.com/file/d/file_A-1")).toBeUndefined();
  });
});
