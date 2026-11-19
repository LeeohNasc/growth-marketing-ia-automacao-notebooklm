import { createSHA256 } from "hash-wasm";

/**
 * SHA-256 em streaming (não carrega o arquivo inteiro na memória). Cede o
 * event loop entre blocos para manter a interface responsiva.
 */
export async function sha256File(file: Blob, onProgress?: (ratio: number) => void, signal?: AbortSignal): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException("aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    read += value.byteLength;
    onProgress?.(file.size ? read / file.size : 1);
    await new Promise((r) => setTimeout(r, 0));
  }
  return hasher.digest("hex");
}
