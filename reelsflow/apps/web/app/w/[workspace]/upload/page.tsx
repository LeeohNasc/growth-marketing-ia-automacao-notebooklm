import type { Metadata } from "next";
import { can } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { maxUploadBytes } from "@/lib/limits";
import { requireWorkspace } from "@/lib/session";
import { Uploader } from "./uploader";

export const metadata: Metadata = { title: "Upload em Massa" };

export default async function UploadPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const maxBytes = await maxUploadBytes(workspace.id);

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload em Massa</h1>
        <p className="text-sm text-muted-foreground">
          Os vídeos vão direto para o armazenamento privado do workspace. Depois do envio, cada vídeo é analisado
          (duração, resolução, codec, miniatura e compatibilidade com as redes).
        </p>
      </div>
      {can(role, "editContent") ? (
        <Uploader workspaceId={workspace.id} slug={slug} maxBytes={maxBytes} />
      ) : (
        <Alert>Seu papel neste workspace é somente leitura. Peça a um administrador acesso de editor para enviar vídeos.</Alert>
      )}
    </div>
  );
}
