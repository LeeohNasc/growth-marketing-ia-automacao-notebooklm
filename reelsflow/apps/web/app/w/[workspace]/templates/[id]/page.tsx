import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { TemplateForm } from "../template-form";

export const metadata: Metadata = { title: "Editar modelo" };

export default async function EditTemplatePage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: template } = await supabase.from("publication_templates").select("*").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!template) notFound();
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Editar modelo</h1>
      <p className="-mt-4 text-sm text-muted-foreground">Alterações não mudam campanhas já criadas (elas guardam uma cópia da configuração).</p>
      <Card>
        <CardContent className="pt-5">
          <TemplateForm slug={slug} template={template} defaultTimezone={workspace.default_timezone} />
        </CardContent>
      </Card>
    </div>
  );
}
