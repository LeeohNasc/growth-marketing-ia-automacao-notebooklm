/**
 * Lembra, por navegador, quais vídeos estavam em envio (hash+tamanho →
 * media_id/caminho). Se a página for recarregada e o usuário selecionar o
 * mesmo arquivo, o envio continua de onde parou em vez de recomeçar.
 * Conveniência local: sem tokens, falha silenciosa sem localStorage.
 */
const KEY = "reelsflow.pendingUploads.v1";
const TTL_MS = 23 * 60 * 60 * 1000;

type Entry = { mediaId: string; storagePath: string; workspaceId: string; savedAt: number };

function readAll(): Record<string, Entry> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(data).filter(([, e]) => now - e.savedAt < TTL_MS));
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, Entry>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* indisponível: segue sem retomada entre recargas */
  }
}

const key = (workspaceId: string, sha256: string, size: number) => `${workspaceId}:${sha256}:${size}`;

export function findPending(workspaceId: string, sha256: string, size: number): Entry | undefined {
  return readAll()[key(workspaceId, sha256, size)];
}

export function savePending(workspaceId: string, sha256: string, size: number, mediaId: string, storagePath: string) {
  const all = readAll();
  all[key(workspaceId, sha256, size)] = { mediaId, storagePath, workspaceId, savedAt: Date.now() };
  writeAll(all);
}

export function clearPending(workspaceId: string, sha256: string, size: number) {
  const all = readAll();
  delete all[key(workspaceId, sha256, size)];
  writeAll(all);
}
