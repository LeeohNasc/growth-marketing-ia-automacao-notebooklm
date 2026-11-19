import type { Metadata } from "next";
import Link from "next/link";
import { FileStack, Plus } from "lucide-react";
import { MODE_LABELS, ORDER_LABELS, WEEKDAY_LABELS, can, type OrderStrategy } from "@reelsflow/domain";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DeleteTemplateButton } from "./delete-button";

export const metadata: Metadata = { title: "Modelos de Publicação" };

export default async function TemplatesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: templates } = await supabase.from("publication_templates").select("*").eq("workspace_id", workspace.id).order("name");
  const canEdit = can(role, "editContent");

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Modelos de Publicação</h1>
          <p className="text-sm text-muted-foreground">Configure uma vez e reutilize em várias campanhas.</p>
        </div>
        {canEdit && (
          <Button asChild>
            <Link href={`/w/${slug}/templates/new`}>
              <Plus /> Novo modelo
            </Link>
          </Button>
        )}
      </div>
      {(templates?.length ?? 0) === 0 ? (
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <FileStack className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Nenhum modelo ainda</p>
          <p className="text-sm text-muted-foreground">Ex.: 3 vídeos por dia, às 09:00, 13:00 e 19:00.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates!.map((t) => (
            <Card key={t.id}>
              <CardHeader>
                <CardTitle>{t.name}</CardTitle>
                <CardDescription>{MODE_LABELS[t.mode]}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <p>
                  <span className="text-muted-foreground">Frequência: </span>
                  {t.times.length}× por dia · {t.weekdays.length === 7 ? "todos os dias" : t.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")}
                </p>
                <p className="tabular-nums">
                  <span className="text-muted-foreground">Horários: </span>
                  {t.times.join(", ")} ({t.timezone.replaceAll("_", " ")})
                </p>
                <p>
                  <span className="text-muted-foreground">Ordem: </span>
                  {ORDER_LABELS[t.order_strategy as OrderStrategy]}
                </p>
                {canEdit && (
                  <div className="flex gap-2 pt-1">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/w/${slug}/templates/${t.id}`}>Editar</Link>
                    </Button>
                    <DeleteTemplateButton slug={slug} id={t.id} name={t.name} />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
