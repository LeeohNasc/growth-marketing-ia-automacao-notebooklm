import type { Metadata } from "next";
import Link from "next/link";
import { Upload } from "lucide-react";
import { can } from "@reelsflow/domain";
import { Button } from "@/components/ui/button";
import { listCollections, listMedia } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { LibraryView } from "./library-view";

export const metadata: Metadata = { title: "Biblioteca de Vídeos" };

type Search = { q?: string; status?: string; sort?: string; view?: string; collection?: string; trash?: string; page?: string };

export default async function LibraryPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<Search> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const collections = await listCollections(workspace.id);
  const collection = collections.find((c) => c.id === sp.collection)?.id;
  const result = await listMedia(workspace.id, {
    q: sp.q,
    status: sp.status,
    sort: sp.sort,
    collection,
    trash: sp.trash === "1",
    page: Number(sp.page) || 1,
  });

  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Biblioteca de Vídeos</h1>
          <p className="text-sm text-muted-foreground">
            {result.total} {result.total === 1 ? "vídeo" : "vídeos"}
            {sp.trash === "1" ? " na lixeira (removidos definitivamente após 30 dias)" : ""}
          </p>
        </div>
        {can(role, "editContent") && (
          <Button asChild>
            <Link href={`/w/${slug}/upload`}>
              <Upload /> Enviar vídeos
            </Link>
          </Button>
        )}
      </div>
      <LibraryView
        // Remonta ao trocar filtros/página: a seleção não "vaza" entre listagens.
        key={[sp.q, sp.status, collection, sp.trash, result.page].join("|")}
        slug={slug}
        canEdit={can(role, "editContent")}
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
