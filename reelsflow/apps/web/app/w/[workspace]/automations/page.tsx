import type { Metadata } from "next";
import { can } from "@reelsflow/domain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { RuleRow } from "./rule-row";

export const metadata: Metadata = { title: "Automações" };

const RULES = [
  { key: "append_from_collection", title: "Novos vídeos da coleção entram no fim da fila", description: "Em campanhas vinculadas a uma coleção, vídeos prontos adicionados à coleção são agendados automaticamente depois do último horário." },
  { key: "retry_transient", title: "Tentar novamente após falhas temporárias", description: "Erros temporários e limites de requisição são repetidos com espera crescente. Desligado: uma única tentativa.", param: { key: "max_attempts" as const, label: "Máximo de tentativas", def: 6, min: 1, max: 20 } },
  { key: "low_content_alert", title: "Avisar quando faltar conteúdo", description: "Notifica (uma vez por dia) quando uma campanha ativa não tem publicações agendadas para os próximos dias.", param: { key: "days" as const, label: "Dias de antecedência", def: 3, min: 1, max: 30 } },
  { key: "complete_campaign", title: "Concluir campanhas finalizadas", description: "Marca como concluída a campanha sem publicações pendentes e envia um resumo." },
  { key: "pause_on_auth_loss", title: "Pausar conta que perder autorização", description: "Se a rede revogar o acesso, as publicações da conta aguardam a reconexão e os administradores são avisados. Desligado: a publicação falha definitivamente." },
];

const OUTCOMES: Record<string, string> = { appended: "Vídeos agendados", notified: "Aviso enviado", completed: "Campanha concluída", account_paused: "Conta pausada" };

export default async function AutomationsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: rules }, { data: runs }] = await Promise.all([
    supabase.from("automation_rules").select("*").eq("workspace_id", workspace.id),
    supabase.from("automation_runs").select("*").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
  ]);
  const byKey = new Map((rules ?? []).map((r) => [r.rule_key, r]));
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: workspace.default_timezone });

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Automações</h1>
        <p className="text-sm text-muted-foreground">Regras executadas pelo sistema. Toda execução fica registrada abaixo.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Regras</CardTitle>
          <CardDescription>{can(role, "editWorkspaceSettings") ? "Alterações valem para todo o workspace." : "Somente administradores podem alterar."}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-lg border">
            {RULES.map((r) => {
              const row = byKey.get(r.key);
              const params = (row?.params ?? {}) as Record<string, number>;
              return (
                <RuleRow
                  key={r.key}
                  slug={slug}
                  ruleKey={r.key}
                  title={r.title}
                  description={r.description}
                  enabled={row?.enabled ?? true}
                  canAdmin={can(role, "editWorkspaceSettings")}
                  param={r.param ? { key: r.param.key, label: r.param.label, value: params[r.param.key] ?? r.param.def, min: r.param.min, max: r.param.max } : undefined}
                />
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Execuções recentes</CardTitle>
        </CardHeader>
        <CardContent>
          {(runs?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma execução registrada.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {runs!.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                  <span>{RULES.find((x) => x.key === r.rule_key)?.title ?? r.rule_key}</span>
                  <span className="text-muted-foreground">
                    {OUTCOMES[r.outcome] ?? r.outcome} · {fmt.format(new Date(r.created_at))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
