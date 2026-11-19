"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Film,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  MEDIA_FAILURE_LABELS,
  MEDIA_STATUS_LABELS,
  PLATFORMS,
  PLATFORM_LABELS,
  aspectLabel,
  formatBytes,
  formatDuration,
  type Compatibility,
} from "@reelsflow/domain";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { initialActionState } from "@/lib/action-state";
import type { LibraryItem } from "@/lib/media";
import { cn } from "@/lib/utils";
import {
  addToCollectionAction,
  createCollectionAction,
  deleteCollectionAction,
  deleteMediaAction,
  getPlaybackUrlAction,
  moveInCollectionAction,
  removeFromCollectionAction,
  restoreMediaAction,
  retryProcessingAction,
  updateMediaAction,
} from "./actions";

type Filters = { q: string; status: string; view: "grid" | "list"; collection: string; trash: boolean };
type Props = {
  slug: string;
  canEdit: boolean;
  items: LibraryItem[];
  total: number;
  page: number;
  pageCount: number;
  sort: string;
  collections: { id: string; name: string }[];
  filters: Filters;
};

const STATUS_VARIANT = { ready: "success", failed: "outline", uploaded: "secondary", processing: "secondary", uploading: "secondary" } as const;

export function LibraryView(props: Props) {
  const { slug, canEdit, items, collections, filters } = props;
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const opened = items.find((i) => i.id === openId) ?? null;
  const manual = Boolean(filters.collection) && props.sort === "manual";

  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    const qs = next.toString();
    return `/w/${slug}/library${qs ? `?${qs}` : ""}`;
  };

  // Atualiza enquanto houver vídeos em análise.
  const processing = items.some((i) => i.status === "uploaded" || i.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [processing, router]);

  const run = (fn: () => Promise<{ ok: boolean; message?: string; count?: number }>, success: string) =>
    startTransition(async () => {
      const r = await fn();
      setNotice(r.ok ? success.replace("{n}", String(r.count ?? selected.size)) : (r.message ?? "Não foi possível concluir."));
      if (r.ok) setSelected(new Set());
      router.refresh();
    });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const sel = [...selected];
  const selFailed = items.filter((i) => selected.has(i.id) && i.status === "failed").length;

  return (
    <div className="grid gap-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3">
        <form action={`/w/${slug}/library`} className="relative min-w-56 flex-1" role="search">
          {filters.status && <input type="hidden" name="status" value={filters.status} />}
          {filters.collection && <input type="hidden" name="collection" value={filters.collection} />}
          {filters.trash && <input type="hidden" name="trash" value="1" />}
          {filters.view === "list" && <input type="hidden" name="view" value="list" />}
          <Label htmlFor="q" className="sr-only">
            Buscar por nome
          </Label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="q" name="q" defaultValue={filters.q} placeholder="Buscar por nome" className="pl-9" />
        </form>
        <FilterSelect label="Status" value={filters.status} onChange={(v) => router.push(href({ status: v }))}>
          <option value="">Todos os status</option>
          <option value="ready">Prontos</option>
          <option value="processing">Em análise</option>
          <option value="failed">Com falha</option>
        </FilterSelect>
        <FilterSelect label="Ordenar" value={props.sort} onChange={(v) => router.push(href({ sort: v }))}>
          {filters.collection && <option value="manual">Ordem manual</option>}
          <option value="newest">Mais recentes</option>
          <option value="oldest">Mais antigos</option>
          <option value="name">Nome</option>
        </FilterSelect>
        <FilterSelect label="Coleção" value={filters.collection} onChange={(v) => router.push(href({ collection: v, sort: null }))}>
          <option value="">Todas as coleções</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <div className="flex items-center gap-1 rounded-md border p-1" role="group" aria-label="Visualização">
          <Button asChild size="icon" variant={filters.view === "grid" ? "secondary" : "ghost"} className="size-8">
            <Link href={href({ view: null, page: String(props.page) })} aria-label="Grade" aria-current={filters.view === "grid"}>
              <LayoutGrid />
            </Link>
          </Button>
          <Button asChild size="icon" variant={filters.view === "list" ? "secondary" : "ghost"} className="size-8">
            <Link href={href({ view: "list", page: String(props.page) })} aria-label="Lista" aria-current={filters.view === "list"}>
              <List />
            </Link>
          </Button>
        </div>
        <Button asChild variant={filters.trash ? "secondary" : "ghost"} size="sm">
          <Link href={href({ trash: filters.trash ? null : "1", collection: null, sort: null })}>
            <Trash2 /> Lixeira
          </Link>
        </Button>
      </div>

      {canEdit && !filters.trash && <CollectionTools slug={slug} current={collections.find((c) => c.id === filters.collection)} onDone={(m) => setNotice(m)} />}

      <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
        {pending ? "Processando…" : notice}
      </p>

      {/* Barra de seleção */}
      {canEdit && selected.size > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 shadow-sm">
          <span className="px-2 text-sm font-medium">{selected.size} selecionado(s)</span>
          {filters.trash ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => restoreMediaAction(slug, sel), "{n} vídeo(s) restaurado(s).")}>
              <Undo2 /> Restaurar
            </Button>
          ) : (
            <>
              {collections.length > 0 && (
                <NativeSelect
                  aria-label="Adicionar à coleção"
                  className="h-9 w-auto"
                  value=""
                  disabled={pending}
                  onChange={(e) => e.target.value && run(() => addToCollectionAction(slug, e.target.value, sel), "{n} vídeo(s) adicionado(s) à coleção.")}
                >
                  <option value="">Adicionar à coleção…</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
              {filters.collection && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(async () => ({ ...(await removeFromCollectionAction(slug, filters.collection, sel)), count: sel.length }), "{n} vídeo(s) removido(s) da coleção.")}>
                  Remover da coleção
                </Button>
              )}
              {selFailed > 0 && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => retryProcessingAction(slug, sel), "{n} vídeo(s) enviados para nova análise.")}>
                  <RotateCcw /> Reprocessar
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Mover ${selected.size} vídeo(s) para a lixeira? Eles serão apagados definitivamente em 30 dias.`)) {
                    run(() => deleteMediaAction(slug, sel), "{n} vídeo(s) movido(s) para a lixeira.");
                  }
                }}
              >
                <Trash2 /> Excluir
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            <X /> Limpar seleção
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState slug={slug} canEdit={canEdit} filtered={Boolean(filters.q || filters.status || filters.collection || filters.trash)} />
      ) : filters.view === "list" ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                {canEdit && (
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" aria-label="Selecionar todos" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} className="size-4 accent-[var(--primary)]" />
                  </th>
                )}
                <th className="px-3 py-2 font-medium">Vídeo</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Duração</th>
                <th className="px-3 py-2 font-medium">Resolução</th>
                <th className="px-3 py-2 font-medium">Tamanho</th>
                <th className="px-3 py-2 font-medium">Enviado em</th>
                <th className="px-3 py-2 font-medium">Redes</th>
                {manual && canEdit && <th className="px-3 py-2 font-medium">Ordem</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((item, idx) => (
                <tr key={item.id} className={cn("hover:bg-accent/40", selected.has(item.id) && "bg-primary/5")}>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Selecionar ${item.name}`} checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="size-4 accent-[var(--primary)]" />
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <button type="button" className="flex items-center gap-3 text-left hover:underline" onClick={() => setOpenId(item.id)}>
                      <Thumb item={item} className="h-12 w-8 shrink-0 rounded" />
                      <span className="max-w-64 truncate font-medium">{item.name}</span>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANT[item.status]}>{MEDIA_STATUS_LABELS[item.status]}</Badge>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatDuration(item.duration_ms)}</td>
                  <td className="px-3 py-2 tabular-nums">{item.width ? `${item.width}×${item.height}` : "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{formatBytes(item.size_bytes)}</td>
                  <td className="px-3 py-2">{new Date(item.created_at).toLocaleDateString("pt-BR")}</td>
                  <td className="px-3 py-2">
                    <CompatDots compat={item.compatibility as Compatibility | null} />
                  </td>
                  {manual && canEdit && (
                    <td className="px-3 py-2">
                      <OrderButtons disabled={pending} first={idx === 0 && props.page === 1} last={idx === items.length - 1 && props.page === props.pageCount} onMove={(d) => run(async () => ({ ...(await moveInCollectionAction(slug, filters.collection, item.id, d)), count: 1 }), "Ordem atualizada.")} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {canEdit && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}>
                <CheckSquare /> {allSelected ? "Desmarcar todos" : "Selecionar todos da página"}
              </Button>
            </div>
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {items.map((item, idx) => (
              <li key={item.id} className={cn("group relative overflow-hidden rounded-xl border bg-card", selected.has(item.id) && "ring-2 ring-primary")}>
                <button type="button" onClick={() => setOpenId(item.id)} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Abrir ${item.name}`}>
                  <div className="relative aspect-[9/16] bg-muted">
                    <Thumb item={item} className="absolute inset-0 h-full w-full" />
                    {item.duration_ms != null && (
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">{formatDuration(item.duration_ms)}</span>
                    )}
                    {item.status !== "ready" && (
                      <Badge variant={STATUS_VARIANT[item.status]} className="absolute left-2 top-2 bg-background/90">
                        {MEDIA_STATUS_LABELS[item.status]}
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-1 p-2.5">
                    <span className="truncate text-sm font-medium" title={item.name}>
                      {item.name}
                    </span>
                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                      {formatBytes(item.size_bytes)}
                      <CompatDots compat={item.compatibility as Compatibility | null} />
                    </span>
                  </div>
                </button>
                {canEdit && (
                  <input
                    type="checkbox"
                    aria-label={`Selecionar ${item.name}`}
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className={cn("absolute right-2 top-2 size-5 accent-[var(--primary)] transition-opacity", selected.size ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100")}
                  />
                )}
                {manual && canEdit && (
                  <div className="absolute right-2 top-9">
                    <OrderButtons vertical disabled={pending} first={idx === 0 && props.page === 1} last={idx === items.length - 1 && props.page === props.pageCount} onMove={(d) => run(async () => ({ ...(await moveInCollectionAction(slug, filters.collection, item.id, d)), count: 1 }), "Ordem atualizada.")} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {props.pageCount > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="Paginação">
          <Button asChild variant="outline" size="sm" className={cn(props.page <= 1 && "pointer-events-none opacity-50")}>
            <Link href={href({ page: String(props.page - 1) })} aria-disabled={props.page <= 1}>
              Anterior
            </Link>
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {props.page} de {props.pageCount}
          </span>
          <Button asChild variant="outline" size="sm" className={cn(props.page >= props.pageCount && "pointer-events-none opacity-50")}>
            <Link href={href({ page: String(props.page + 1) })} aria-disabled={props.page >= props.pageCount}>
              Próxima
            </Link>
          </Button>
        </nav>
      )}

      <Sheet open={Boolean(opened)} onOpenChange={(o) => !o && setOpenId(null)}>
        {opened && (
          <SheetContent side="right" aria-describedby={undefined}>
            <MediaDetail
              key={opened.id}
              slug={slug}
              item={opened}
              canEdit={canEdit}
              collections={collections}
              onAction={(fn, msg) => {
                setOpenId(null);
                run(fn, msg);
              }}
            />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <NativeSelect aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-auto min-w-36">
        {children}
      </NativeSelect>
    </div>
  );
}

function Thumb({ item, className }: { item: LibraryItem; className?: string }) {
  if (item.thumbUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária; otimização de imagem não se aplica
    return <img src={item.thumbUrl} alt="" loading="lazy" className={cn("object-cover", className)} />;
  }
  return (
    <span className={cn("grid place-items-center bg-muted text-muted-foreground", className)}>
      {item.status === "processing" || item.status === "uploaded" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Film className="size-5" aria-hidden />}
    </span>
  );
}

const DOT = { ok: "bg-success", warning: "bg-warning", error: "bg-destructive" } as const;

function CompatDots({ compat }: { compat: Compatibility | null }) {
  if (!compat?.platforms) return null;
  const summary = PLATFORMS.map((p) => `${PLATFORM_LABELS[p]}: ${compat.platforms[p]?.status === "ok" ? "compatível" : compat.platforms[p]?.status === "warning" ? "com avisos" : "incompatível"}`).join("; ");
  return (
    <span className="flex items-center gap-1" role="img" aria-label={summary} title={summary}>
      {PLATFORMS.map((p) => (
        <span key={p} className={cn("size-2 rounded-full", DOT[compat.platforms[p]?.status ?? "warning"])} />
      ))}
    </span>
  );
}

function OrderButtons({ onMove, first, last, disabled, vertical }: { onMove: (d: -1 | 1) => void; first: boolean; last: boolean; disabled: boolean; vertical?: boolean }) {
  return (
    <div className={cn("flex gap-1", vertical && "flex-col")}>
      <Button size="icon" variant="secondary" className="size-7" disabled={disabled || first} onClick={() => onMove(-1)} aria-label="Mover para cima">
        <ArrowUp />
      </Button>
      <Button size="icon" variant="secondary" className="size-7" disabled={disabled || last} onClick={() => onMove(1)} aria-label="Mover para baixo">
        <ArrowDown />
      </Button>
    </div>
  );
}

function EmptyState({ slug, canEdit, filtered }: { slug: string; canEdit: boolean; filtered: boolean }) {
  return (
    <div className="grid place-items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <Film className="size-10 text-muted-foreground" aria-hidden />
      <p className="font-medium">{filtered ? "Nenhum vídeo encontrado" : "Sua biblioteca está vazia"}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filtered ? "Ajuste a busca ou os filtros." : "Envie vídeos para começar. Cada vídeo é analisado automaticamente após o envio."}
      </p>
      {!filtered && canEdit && (
        <Button asChild>
          <Link href={`/w/${slug}/upload`}>Enviar vídeos</Link>
        </Button>
      )}
    </div>
  );
}

function CollectionTools({ slug, current, onDone }: { slug: string; current?: { id: string; name: string }; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {creating ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await createCollectionAction(slug, name);
              onDone(r.ok ? `Coleção “${name.trim()}” criada.` : (r.message ?? "Erro."));
              if (r.ok) {
                setCreating(false);
                setName("");
                router.refresh();
              }
            });
          }}
        >
          <Label htmlFor="new-collection" className="sr-only">
            Nome da coleção
          </Label>
          <Input id="new-collection" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da coleção" className="h-9 w-56" maxLength={80} />
          <Button size="sm" type="submit" disabled={pending || !name.trim()}>
            Criar
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setCreating(false)}>
            Cancelar
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <FolderPlus /> Nova coleção
        </Button>
      )}
      {current && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (!window.confirm(`Excluir a coleção “${current.name}”? Os vídeos continuam na biblioteca.`)) return;
            start(async () => {
              await deleteCollectionAction(slug, current.id);
              onDone("Coleção excluída.");
              router.push(`/w/${slug}/library`);
            });
          }}
        >
          <Trash2 /> Excluir coleção
        </Button>
      )}
    </div>
  );
}

function MediaDetail({
  slug,
  item,
  canEdit,
  collections,
  onAction,
}: {
  slug: string;
  item: LibraryItem;
  canEdit: boolean;
  collections: { id: string; name: string }[];
  onAction: (fn: () => Promise<{ ok: boolean; message?: string; count?: number }>, msg: string) => void;
}) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [state, action] = useActionState(updateMediaAction, initialActionState);
  const compat = item.compatibility as Compatibility | null;
  const inCollections = useMemo(() => collections.filter((c) => item.collectionIds.includes(c.id)), [collections, item.collectionIds]);

  const play = async () => {
    setLoadingVideo(true);
    setVideoUrl(await getPlaybackUrlAction(slug, item.id));
    setLoadingVideo(false);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b px-5 py-4 pr-12">
        <SheetTitle className="truncate text-lg font-semibold">{item.name}</SheetTitle>
        <p className="truncate text-xs text-muted-foreground">{item.original_filename}</p>
      </div>
      <div className="grid gap-6 p-5">
        <div className="grid place-items-center overflow-hidden rounded-lg bg-black">
          {videoUrl ? (
            <video src={videoUrl} controls autoPlay playsInline className="max-h-[60vh] w-full" aria-label={`Reprodução de ${item.name}`} />
          ) : (
            <button type="button" onClick={play} disabled={item.deleted_at !== null} className="relative block aspect-[9/16] max-h-[60vh] w-full disabled:cursor-not-allowed" aria-label="Reproduzir vídeo">
              <Thumb item={item} className="absolute inset-0 h-full w-full" />
              <span className="absolute inset-0 grid place-items-center bg-black/30 text-sm font-medium text-white">
                {loadingVideo ? <Loader2 className="size-6 animate-spin" /> : item.deleted_at ? "Na lixeira" : "▶ Reproduzir"}
              </span>
            </button>
          )}
        </div>

        {item.status === "failed" && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {MEDIA_FAILURE_LABELS[item.failure_reason ?? ""] ?? "Falha no processamento."}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Meta k="Status" v={MEDIA_STATUS_LABELS[item.status]} />
          <Meta k="Duração" v={formatDuration(item.duration_ms)} />
          <Meta k="Resolução" v={item.width ? `${item.width}×${item.height}` : "—"} />
          <Meta k="Proporção" v={aspectLabel(item.width, item.height)} />
          <Meta k="Tamanho" v={formatBytes(item.size_bytes)} />
          <Meta k="Quadros/s" v={item.fps ? String(item.fps).replace(".", ",") : "—"} />
          <Meta k="Codec" v={[item.video_codec, item.audio_codec].filter(Boolean).join(" / ").toUpperCase() || "—"} />
          <Meta k="Enviado em" v={new Date(item.created_at).toLocaleString("pt-BR")} />
        </dl>

        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Compatibilidade</h3>
          {compat?.platforms ? (
            <>
              <ul className="grid gap-2">
                {PLATFORMS.map((p) => {
                  const c = compat.platforms[p];
                  return (
                    <li key={p} className="rounded-md border px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-full", DOT[c?.status ?? "warning"])} aria-hidden />
                        <span className="flex-1">{PLATFORM_LABELS[p]}</span>
                        <span className="text-xs text-muted-foreground">{c?.status === "ok" ? "Compatível" : c?.status === "warning" ? "Com avisos" : "Incompatível"}</span>
                      </div>
                      {c?.issues.length ? (
                        <ul className="mt-1 list-disc pl-6 text-xs text-muted-foreground">
                          {c.issues.map((i) => (
                            <li key={i.code}>{i.message}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">Regras preliminares; serão confirmadas com a documentação de cada rede ao conectar as contas.</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Disponível após a análise do vídeo.</p>
          )}
        </section>

        {canEdit && !item.deleted_at ? (
          <form action={action} className="grid gap-3" noValidate>
            <h3 className="text-sm font-medium">Conteúdo padrão</h3>
            <FormMessage state={state} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="id" value={item.id} />
            <Field label="Nome" name="name" defaultValue={state.values?.name ?? item.name} error={state.fieldErrors?.name} />
            <div className="grid gap-2">
              <Label htmlFor="caption">Legenda</Label>
              <textarea
                id="caption"
                name="caption"
                rows={4}
                maxLength={2200}
                defaultValue={state.values?.caption ?? item.default_caption ?? ""}
                className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {state.fieldErrors?.caption && <p className="text-xs text-destructive">{state.fieldErrors.caption}</p>}
            </div>
            <Field label="Hashtags" name="hashtags" hint="Separe por espaço ou vírgula. Máximo de 30." defaultValue={state.values?.hashtags ?? item.default_hashtags.join(" ")} />
            <SubmitButton className="justify-self-start" pendingText="Salvando…">
              Salvar
            </SubmitButton>
          </form>
        ) : null}

        <section className="grid gap-2 text-sm">
          <h3 className="font-medium">Coleções</h3>
          {inCollections.length ? (
            <div className="flex flex-wrap gap-1">
              {inCollections.map((c) => (
                <Badge key={c.id} variant="secondary">
                  {c.name}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">Nenhuma.</p>
          )}
        </section>

        <section className="grid gap-1 text-sm">
          <h3 className="font-medium">Histórico de publicações</h3>
          <p className="text-muted-foreground">Agendamento e publicações chegam na Fase 3.</p>
        </section>

        {canEdit && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {item.deleted_at ? (
              <Button variant="outline" onClick={() => onAction(() => restoreMediaAction(slug, [item.id]), "Vídeo restaurado.")}>
                <Undo2 /> Restaurar
              </Button>
            ) : (
              <>
                {item.status === "failed" && item.failure_reason !== "size_mismatch" && (
                  <Button variant="outline" onClick={() => onAction(() => retryProcessingAction(slug, [item.id]), "Vídeo enviado para nova análise.")}>
                    <RotateCcw /> Reprocessar
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (window.confirm("Mover este vídeo para a lixeira? Ele será apagado definitivamente em 30 dias.")) {
                      onAction(() => deleteMediaAction(slug, [item.id]), "Vídeo movido para a lixeira.");
                    }
                  }}
                >
                  <Trash2 /> Excluir
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="truncate">{v}</dd>
    </div>
  );
}
