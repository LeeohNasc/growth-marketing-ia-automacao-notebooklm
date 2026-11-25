import type { Metadata } from "next";
import { can } from "@reelsflow/domain";
import { maxUploadBytes } from "@/lib/limits";
import { listCollections, listMedia } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { Uploader } from "../upload/uploader";
import { LibraryView } from "./library-view";

export const metadata: Metadata = { title: "Biblioteca" };

type Search = { enviar?: string; q?: string; status?: string; sort?: string; view?: string; collection?: string; trash?: string; page?: string };

export default async function LibraryPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<Search> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const query = { q: sp.q, status: sp.status, sort: sp.sort, trash: sp.trash === "1", page: Number(sp.page) || 1 };
  // Sem filtro de coleção (o caso do clique no menu), coleções e vídeos são buscados em paralelo.
  // Com filtro, a coleção é validada primeiro, como antes (coleção inexistente = sem filtro).
  const canUpload = can(role, "editContent");
  const [collections, unfiltered, maxBytes] = await Promise.all([
    listCollections(workspace.id),
    sp.collection ? Promise.resolve(null) : listMedia(workspace.id, query),
    canUpload ? maxUploadBytes(workspace.id) : Promise.resolve(0),
  ]);
  const collection = collections.find((c) => c.id === sp.collection)?.id;
  const result = unfiltered ?? (await listMedia(workspace.id, { ...query, collection }));

  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Biblioteca</h1>
          <p className="text-sm text-muted-foreground">
            {result.total} {result.total === 1 ? "vídeo" : "vídeos"}
            {sp.trash === "1" ? " na lixeira (removidos definitivamente após 30 dias)" : ""}
          </p>
        </div>
      </div>
      {canUpload && (
        // Envio em massa dentro da própria Biblioteca (antes era uma tela separada). Duplicados continuam
        // sendo detectados pelo conteúdo do arquivo antes do envio.
        <details open={sp.enviar === "1"} className="group rounded-xl border bg-card [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
            <span>Enviar vídeos</span>
            <span className="text-xs font-normal text-muted-foreground">Arraste vários arquivos de uma vez · duplicados são avisados antes do envio</span>
          </summary>
          <div className="border-t p-4">
            <Uploader workspaceId={workspace.id} slug={slug} maxBytes={maxBytes} embedded />
          </div>
        </details>
      )}
      <LibraryView
        // Remonta ao trocar filtros/página: a seleção não "vaza" entre listagens.
        key={[sp.q, sp.status, collection, sp.trash, result.page].join("|")}
        slug={slug}
        canEdit={canUpload}
        items={result.items}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        sort={result.sort}
        collections={collections}
        filters={{ q: sp.q ?? "", status: sp.status ?? "", view: sp.view === "list" ? "list" : "grid", collection: collection ?? "", trash: sp.trash === "1" }}
      />
    </div>
  );
}
