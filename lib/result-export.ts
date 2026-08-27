import { Directory, File, Paths } from "expo-file-system/next";

export async function downloadResultToCache(url: string, imageId: string) {
  if (url.startsWith("file:")) return url;
  const directory = new Directory(Paths.cache, "bubbleclean-results");
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, `bubbleclean-${imageId}.png`);
  const downloaded = await File.downloadFileAsync(url, target, { idempotent: true });
  return downloaded.uri;
}
