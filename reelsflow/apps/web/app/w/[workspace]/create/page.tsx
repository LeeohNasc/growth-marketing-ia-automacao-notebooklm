import type { Metadata } from "next";
import Link from "next/link";
import { Newspaper, Plus } from "lucide-react";
import { CARD_FORMATS, can } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CardRenderStatus } from "@/lib/database.types";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { createCardAction } from "./actions";

export const metadata: Metadata = { title: "Card Editorial" };

const STATUS: Record<CardRenderStatus, { label: string; variant: "secondary" | "warning" | "success" | "outline" }> = {
  draft: { label: "Rascunho", variant: "secondary" },
  rendering: { label: "Renderizando", variant: "warning" },
  processing: { label: "Verificando", variant: "warning" },
  ready: { label: "Pronto", variant: "success" },
  error: { label: "Erro de render", variant: "outline" },
};
const ERRORS: Record<string, string> = {
  forbidden: "Somente editores podem criar cards.",
  create: "Não foi possível criar o card.",
  duplicate: "Não foi possível duplicar o card.",
  delete: "Não foi possível excluir o card.",
};

export default async function CreatePage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: cards } = await supabase
    .from("editorial_cards")
    .select("id, title, headline, format, media_kind, render_status, updated_at")
    .eq("workspace_id", workspace.id)
    .order("updated_at", { ascending: false })
    .limit(200);
  const canEdit = can(role, "editContent");
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: workspace.default_timezone });

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Card Editorial</h1>
        <p className="text-sm text-muted-foreground">Monte conteúdos no próprio ReelsFlow. O arquivo final vai para a Biblioteca e pode ser agendado como qualquer mídia.</p>
      </div>
      {sp.e && ERRORS[sp.e] && <Alert variant="destructive">{ERRORS[sp.e]}</Alert>}
      {sp.ok === "deleted" && <Alert variant="success">Card excluído. O arquivo final (se houver) continua na Biblioteca.</Alert>}

      <section className="grid gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Modelos</h2>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Newspaper className="size-5" aria-hidden /> Card Editorial
            </CardTitle>
            <CardDescription>
              Manchete com sua foto de perfil, nome e @, seguida de foto, duas fotos ou vídeo. Formatos 4:5, 1:1 e 9:16. Gera JPEG ou MP4 prontos para publicar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit ? (
              <form action={createCardAction}>
                <input type="hidden" name="slug" value={slug} />
                <Button type="submit">
                  <Plus /> Novo Card Editorial
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Somente editores podem criar cards.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Seus cards</h2>
        {(cards?.length ?? 0) === 0 ? (
          <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">Nenhum card ainda.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {cards!.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/w/${slug}/create/editorial/${c.id}`} className="font-medium hover:underline">
                    {c.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{c.headline || "Sem manchete"}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {CARD_FORMATS[c.format].label.split(" (")[0]} · {c.media_kind === "video" ? "Vídeo" : c.media_kind === "image_pair" ? "2 imagens" : "Foto"}
                </span>
                <Badge variant={STATUS[c.render_status].variant}>{STATUS[c.render_status].label}</Badge>
                <span className="text-xs tabular-nums text-muted-foreground">{fmt.format(new Date(c.updated_at))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
