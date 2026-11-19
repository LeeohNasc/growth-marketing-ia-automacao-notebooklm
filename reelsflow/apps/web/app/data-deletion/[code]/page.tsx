import type { Metadata } from "next";
import { LegalLayout } from "@/components/legal-layout";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Status da exclusão de dados" };

export default async function DeletionStatusPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const valid = /^[0-9a-f]{24}$/.test(code);
  const supabase = await createClient();
  const { data } = valid ? await supabase.rpc("data_deletion_status", { p_code: code }) : { data: null };
  const r = data?.[0];
  return (
    <LegalLayout title="Status da exclusão de dados" updated="—">
      {r ? (
        <p>
          Solicitação <code>{code}</code>: <strong>{r.status === "completed" ? "concluída" : "recebida"}</strong>
          {r.completed_at ? ` em ${new Date(r.completed_at).toLocaleString("pt-BR")}` : ""}. Contas vinculadas removidas: {r.accounts_removed}.
        </p>
      ) : (
        <p>Código não encontrado. Verifique o código recebido.</p>
      )}
    </LegalLayout>
  );
}
