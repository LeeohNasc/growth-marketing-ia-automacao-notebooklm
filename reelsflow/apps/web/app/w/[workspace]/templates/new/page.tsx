import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { TemplateForm } from "../template-form";

export const metadata: Metadata = { title: "Novo modelo" };

export default async function NewTemplatePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Novo modelo</h1>
      <Card>
        <CardContent className="pt-5">
          <TemplateForm slug={slug} defaultTimezone={workspace.default_timezone} />
        </CardContent>
      </Card>
    </div>
  );
}
