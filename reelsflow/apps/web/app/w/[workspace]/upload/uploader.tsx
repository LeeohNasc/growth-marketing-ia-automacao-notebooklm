"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as tus from "tus-js-client";
import { CheckCircle2, CircleAlert, Copy, Loader2, RotateCcw, UploadCloud, X } from "lucide-react";
import { ACCEPTED_VIDEO_TYPES, TUS_CHUNK_SIZE, checkUploadFile, formatBytes } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";
import { planLimitMessage } from "@/lib/limits-messages";
import { tusEndpoint } from "@/lib/upload/endpoint";
import { makeThumbnail } from "@/lib/upload/thumbnail";
import { sha256File } from "@/lib/upload/hash";
import { clearPending, findPending, savePending } from "@/lib/upload/resume-store";
import { cn } from "@/lib/utils";

type Status = "invalid" | "hashing" | "duplicate" | "ready" | "uploading" | "finalizing" | "done" | "error" | "cancelled";

type Item = {
  id: string;
  name: string;
  size: number;
  mime: string;
  status: Status;
  progress: number;
  sha256?: string;
  mediaId?: string;
  error?: string;
  duplicateOf?: string;
  resumed?: boolean;
};

type Action =
  | { type: "add"; items: Item[] }
  | { type: "patch"; id: string; patch: Partial<Item> }
  | { type: "remove"; id: string }
  | { type: "clearFinished" };

function reducer(state: Item[], action: Action): Item[] {
  switch (action.type) {
    case "add":
      return [...state, ...action.items];
    case "patch":
      return state.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i));
    case "remove":
      return state.filter((i) => i.id !== action.id);
    case "clearFinished":
      return state.filter((i) => !["done", "cancelled", "invalid"].includes(i.status));
  }
}

const UPLOAD_CONCURRENCY = 3;
const HASH_CONCURRENCY = 2;
const ACCEPT = Object.keys(ACCEPTED_VIDEO_TYPES).join(",") + ",.mp4,.mov,.m4v";

const STATUS_LABEL: Record<Status, string> = {
  invalid: "Inválido",
  hashing: "Verificando",
  duplicate: "Possível duplicado",
  ready: "Na fila",
  uploading: "Enviando",
  finalizing: "Finalizando",
  done: "Enviado",
  error: "Falhou",
  cancelled: "Cancelado",
};

export function Uploader({ workspaceId, slug, maxBytes }: { workspaceId: string; slug: string; maxBytes: number }) {
  const [items, dispatch] = useReducer(reducer, []);
  const [dragging, setDragging] = useState(false);
  const files = useRef(new Map<string, File>());
  const uploads = useRef(new Map<string, tus.Upload>());
  const started = useRef(new Set<string>());
  const hashing = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createClient(), []);
  const patch = useCallback((id: string, p: Partial<Item>) => dispatch({ type: "patch", id, patch: p }), []);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const next: Item[] = [];
      for (const file of Array.from(list)) {
        const id = crypto.randomUUID();
        const check = checkUploadFile({ name: file.name, size: file.size, type: file.type }, maxBytes);
        files.current.set(id, file);
        next.push({
          id,
          name: file.name,
          size: file.size,
          mime: check.ok ? check.mime : file.type,
          status: check.ok ? "hashing" : "invalid",
          progress: 0,
          error: check.ok ? undefined : check.reason,
        });
      }
      dispatch({ type: "add", items: next });
    },
    [maxBytes],
  );

  // 1) Hash + detecção de duplicados (no workspace e no próprio lote).
  useEffect(() => {
    const waiting = items.filter((i) => i.status === "hashing" && !hashing.current.has(i.id));
    const free = HASH_CONCURRENCY - [...hashing.current].filter((id) => items.find((i) => i.id === id)?.status === "hashing").length;
    for (const item of waiting.slice(0, Math.max(0, free))) {
      hashing.current.add(item.id);
      const file = files.current.get(item.id)!;
      (async () => {
        try {
          const sha = await sha256File(file, (r) => patch(item.id, { progress: Math.round(r * 100) }));
          const { data } = await supabase
            .from("media_assets")
            .select("name")
            .eq("workspace_id", workspaceId)
            .eq("sha256", sha)
            .is("deleted_at", null)
            .neq("status", "uploading")
            .limit(1);
          const inBatch = items.find((o) => o.id !== item.id && o.sha256 === sha && o.status !== "cancelled");
          const dup = data?.[0]?.name ?? inBatch?.name;
          patch(item.id, { sha256: sha, progress: 0, status: dup ? "duplicate" : "ready", duplicateOf: dup });
        } catch {
          patch(item.id, { status: "error", error: "Não foi possível ler o arquivo." });
        } finally {
          hashing.current.delete(item.id);
        }
      })();
    }
  }, [items, patch, supabase, workspaceId]);

  // 2) Envio TUS com concorrência limitada.
  const startUpload = useCallback(
    async (item: Item) => {
      const file = files.current.get(item.id)!;
      const sha = item.sha256!;
      try {
        let mediaId: string | undefined;
        let storagePath: string | undefined;
        let resumed = false;

        const pending = findPending(workspaceId, sha, file.size);
        if (pending) {
          const { data } = await supabase.from("media_assets").select("id, storage_path, status").eq("id", pending.mediaId).maybeSingle();
          if (data?.status === "uploading") {
            mediaId = data.id;
            storagePath = data.storage_path;
            resumed = true;
          } else {
            clearPending(workspaceId, sha, file.size);
          }
        }
        if (!mediaId) {
          const { data, error } = await supabase.rpc("begin_media_upload", {
            p_workspace: workspaceId,
            p_files: [{ name: file.name, size: file.size, mime: item.mime, sha256: sha }],
          });
          if (error || !data?.[0]) {
            throw new Error(planLimitMessage(error?.message) ?? (error?.message.includes("size") ? "Arquivo acima do limite." : "Não foi possível iniciar o envio."));
          }
          mediaId = data[0].media_id;
          storagePath = data[0].storage_path;
          savePending(workspaceId, sha, file.size, mediaId, storagePath);
        }
        patch(item.id, { mediaId, resumed, status: "uploading" });

        // Miniatura em paralelo ao envio; precisa estar gravada antes de concluir (a análise a usa).
        const thumbPath = `${workspaceId}/${mediaId}/thumb.jpg`;
        const thumbDone = makeThumbnail(file)
          .then(async (blob) => {
            if (!blob) return;
            // Já existir (envio retomado) não é erro.
            await supabase.storage.from("media").upload(thumbPath, blob, { contentType: "image/jpeg", upsert: false });
          })
          .catch(() => undefined);

        const upload = new tus.Upload(file, {
          endpoint: tusEndpoint(publicEnv().NEXT_PUBLIC_SUPABASE_URL),
          chunkSize: TUS_CHUNK_SIZE,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          headers: { "x-upsert": "false" },
          metadata: { bucketName: "media", objectName: storagePath!, contentType: item.mime, cacheControl: "3600" },
          onBeforeRequest: async (req) => {
            // Token renovado a cada requisição: uploads longos sobrevivem à expiração da sessão.
            const { data } = await supabase.auth.getSession();
            const token = data.session?.access_token;
            if (token) req.setHeader("authorization", `Bearer ${token}`);
          },
          onProgress: (sent, total) => patch(item.id, { progress: total ? Math.floor((sent / total) * 100) : 0 }),
          onError: (err) => {
            uploads.current.delete(item.id);
            const status = (err as tus.DetailedError).originalResponse?.getStatus();
            patch(item.id, {
              status: "error",
              error:
                status === 403 || status === 401
                  ? "Sem permissão para enviar (sessão expirada ou papel insuficiente)."
                  : status === 413
                    ? "Arquivo acima do limite do armazenamento."
                    : "Falha de conexão. Você pode tentar novamente; o envio continua de onde parou.",
            });
          },
          onSuccess: async () => {
            uploads.current.delete(item.id);
            patch(item.id, { status: "finalizing", progress: 100 });
            await thumbDone;
            const { data, error } = await supabase.rpc("complete_media_upload", { p_media: mediaId! });
            if (error || data === "failed") {
              patch(item.id, { status: "error", error: "O arquivo recebido não confere com o original. Envie novamente." });
              clearPending(workspaceId, sha, file.size);
              return;
            }
            clearPending(workspaceId, sha, file.size);
            patch(item.id, { status: "done" });
          },
        });
        uploads.current.set(item.id, upload);
        const previous = await upload.findPreviousUploads();
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      } catch (err) {
        patch(item.id, { status: "error", error: err instanceof Error ? err.message : "Falha ao enviar." });
      }
    },
    [patch, supabase, workspaceId],
  );

  useEffect(() => {
    const active = items.filter((i) => i.status === "uploading" || (i.status === "ready" && started.current.has(i.id))).length;
    const queue = items.filter((i) => i.status === "ready" && !started.current.has(i.id));
    for (const item of queue.slice(0, Math.max(0, UPLOAD_CONCURRENCY - active))) {
      started.current.add(item.id);
      void startUpload(item);
    }
  }, [items, startUpload]);

  const cancel = useCallback(
    async (item: Item) => {
      const up = uploads.current.get(item.id);
      uploads.current.delete(item.id);
      if (up) await up.abort(true).catch(() => undefined);
      if (item.mediaId && item.status !== "done") {
        await supabase.rpc("cancel_media_upload", { p_media: item.mediaId });
      }
      if (item.sha256) clearPending(workspaceId, item.sha256, item.size);
      patch(item.id, { status: "cancelled" });
    },
    [patch, supabase, workspaceId],
  );

  const retry = useCallback(
    (item: Item) => {
      started.current.delete(item.id);
      patch(item.id, { status: item.sha256 ? "ready" : "hashing", error: undefined, progress: 0 });
    },
    [patch],
  );

  const busy = items.some((i) => ["hashing", "ready", "uploading", "finalizing"].includes(i.status));
  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  const counts = useMemo(() => {
    const c = { done: 0, error: 0, active: 0, total: 0, bytes: 0, sentBytes: 0 };
    for (const i of items) {
      if (i.status === "invalid" || i.status === "cancelled") continue;
      c.total++;
      c.bytes += i.size;
      if (i.status === "done") c.done++;
      else if (i.status === "error") c.error++;
      else c.active++;
      c.sentBytes += i.status === "done" ? i.size : i.status === "uploading" || i.status === "finalizing" ? (i.size * i.progress) / 100 : 0;
    }
    return c;
  }, [items]);
  const overall = counts.bytes ? Math.round((counts.sentBytes / counts.bytes) * 100) : 0;

  return (
    <div className="grid gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "grid place-items-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <UploadCloud className="size-10 text-primary" aria-hidden />
        <div>
          <p className="font-medium">Arraste vídeos para cá</p>
          <p className="text-sm text-muted-foreground">
            MP4 ou MOV · até {formatBytes(maxBytes)} por arquivo · vários de uma vez
          </p>
        </div>
        <Button type="button" onClick={() => inputRef.current?.click()}>
          Selecionar vídeos
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          aria-label="Selecionar vídeos"
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <section aria-labelledby="fila-envio" className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="fila-envio" className="font-medium">
              Envios
            </h2>
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {counts.done} de {counts.total} enviados{counts.error ? ` · ${counts.error} com falha` : ""}
            </span>
            <div className="ml-auto flex gap-2">
              {!busy && counts.done > 0 && (
                <Button asChild size="sm">
                  <Link href={`/w/${slug}/library`}>Ver na biblioteca</Link>
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => dispatch({ type: "clearFinished" })}>
                Limpar concluídos
              </Button>
            </div>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso total">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${overall}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            Mantenha esta aba aberta até o fim do envio. Se a conexão cair, o envio é retomado automaticamente; se a página for
            fechada, selecione os mesmos arquivos novamente para continuar de onde parou.
          </p>
          <ul className="divide-y rounded-xl border bg-card">
            {items.map((item) => (
              <UploadRow key={item.id} item={item} onCancel={cancel} onRetry={retry} onRemove={(id) => dispatch({ type: "remove", id })} onAccept={(id) => patch(id, { status: "ready" })} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onRemove,
  onAccept,
}: {
  item: Item;
  onCancel: (i: Item) => void;
  onRetry: (i: Item) => void;
  onRemove: (id: string) => void;
  onAccept: (id: string) => void;
}) {
  const showBar = item.status === "uploading" || item.status === "hashing" || item.status === "finalizing";
  return (
    <li className="grid gap-2 px-4 py-3 text-sm" data-testid="upload-row" data-status={item.status}>
      <div className="flex items-center gap-3">
        <StatusIcon status={item.status} />
        <span className="min-w-0 flex-1 truncate" title={item.name}>
          {item.name}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{formatBytes(item.size)}</span>
        <Badge variant={item.status === "done" ? "success" : item.status === "error" || item.status === "invalid" ? "outline" : item.status === "duplicate" ? "warning" : "secondary"}>
          {STATUS_LABEL[item.status]}
          {showBar && item.status !== "finalizing" ? ` ${item.progress}%` : ""}
        </Badge>
        {["hashing", "ready", "uploading", "duplicate"].includes(item.status) && (
          <Button size="icon" variant="ghost" className="size-8" onClick={() => onCancel(item)} aria-label={`Cancelar ${item.name}`}>
            <X />
          </Button>
        )}
        {item.status === "error" && (
          <Button size="icon" variant="ghost" className="size-8" onClick={() => onRetry(item)} aria-label={`Tentar novamente ${item.name}`}>
            <RotateCcw />
          </Button>
        )}
      </div>
      {showBar && (
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div className={cn("h-full transition-[width]", item.status === "hashing" ? "bg-muted-foreground" : "bg-primary")} style={{ width: `${item.progress}%` }} />
        </div>
      )}
      {item.resumed && item.status === "uploading" && <p className="text-xs text-muted-foreground">Retomando envio anterior.</p>}
      {item.error && <p className="text-xs text-destructive">{item.error}</p>}
      {item.status === "duplicate" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-warning">Conteúdo idêntico a “{item.duplicateOf}”.</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => onAccept(item.id)}>
            Enviar mesmo assim
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onRemove(item.id)}>
            Ignorar
          </Button>
        </div>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "done") return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />;
  if (status === "error" || status === "invalid") return <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />;
  if (status === "duplicate") return <Copy className="size-4 shrink-0 text-warning" aria-hidden />;
  if (status === "cancelled") return <X className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
}
