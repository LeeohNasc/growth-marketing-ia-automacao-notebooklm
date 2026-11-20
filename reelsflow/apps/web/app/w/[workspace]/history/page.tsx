import type { Metadata } from "next";
import Link from "next/link";
import { SOCIAL_PLATFORM_LABELS, type JobStatus, type SocialPlatform } from "@reelsflow/domain";
import { JobStatusBadge } from "@/components/job-status";
import { Button } from "@/components/ui/button";
import { listJobs } from "@/lib/jobs";
import { ERROR_CLASS_LABELS } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Histórico" };
const PAGE = 50;

export default async function HistoryPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ page?: string; show?: string; account?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace } = await requireWorkspace(slug);
  const page = Math.max(1, Number(sp.page) || 1);
  const statuses = sp.show === "failed" ? (["failed_permanent"] as const) : sp.show === "published" ? (["published"] as const) : (["published", "failed_permanent"] as const);
  const supabase = await createClient();
  const { data: accounts } = await supabase.from("social_accounts").select("id, display_name, platform, settings").eq("workspace_id", workspace.id).order("display_name");
  const account = accounts?.some((a) => a.id === sp.account) ? sp.account : undefined;
  const { items, total } = await listJobs(workspace.id, { statuses: [...statuses], account, order: "desc", limit: PAGE, offset: (page - 1) * PAGE });
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: workspace.default_timezone });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const link = (patch: Record<string, string>) =>
    `/w/${slug}/history?${new URLSearchParams({ ...(sp.show ? { show: sp.show } : {}), ...(account ? { account } : {}), ...patch })}`;

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Histórico</h1>
          <p className="text-sm text-muted-foreground">Publicações concluídas e falhas definitivas. Registros são mantidos mesmo se o vídeo for excluído.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={`/w/${slug}/history`} className="flex items-center gap-2">
            {sp.show && <input type="hidden" name="show" value={sp.show} />}
            <label htmlFor="account" className="text-sm text-muted-foreground">
              Conta
            </label>
            <select id="account" name="account" defaultValue={account ?? ""} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
              <option value="">Todas</option>
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                  {(a.settings as { username?: string } | null)?.username ? ` (@${(a.settings as { username: string }).username})` : ""} ·{" "}
                  {SOCIAL_PLATFORM_LABELS[a.platform as SocialPlatform]}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline">
              Filtrar
            </Button>
          </form>
          {[
            ["", "Tudo"],
            ["published", "Publicadas"],
            ["failed", "Falhas"],
          ].map(([v, l]) => (
            <Button key={v} asChild size="sm" variant={(sp.show ?? "") === v ? "secondary" : "ghost"}>
              <Link href={`/w/${slug}/history?${new URLSearchParams({ ...(v ? { show: v } : {}), ...(account ? { account } : {}) })}`}>{l}</Link>
            </Button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Prevista</th>
              <th className="px-3 py-2 font-medium">Efetiva</th>
              <th className="px-3 py-2 font-medium">Vídeo</th>
              <th className="px-3 py-2 font-medium">Conta</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Resultado</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  Nada por aqui ainda.
                </td>
              </tr>
            ) : (
              items.map((j) => (
                <tr key={j.id}>
                  <td className="px-3 py-2 tabular-nums">{fmt.format(new Date(j.scheduled_at))}</td>
                  <td className="px-3 py-2 tabular-nums">{j.published_at ? fmt.format(new Date(j.published_at)) : "—"}</td>
                  <td className="max-w-56 truncate px-3 py-2">{j.media ?? "Vídeo removido"}</td>
                  <td className="px-3 py-2">
                    {j.account ?? "—"}
                    {j.platform && <span className="block text-xs text-muted-foreground">{SOCIAL_PLATFORM_LABELS[j.platform as SocialPlatform]}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <JobStatusBadge status={j.status as JobStatus} />
                  </td>
                  <td className="max-w-64 px-3 py-2 text-xs">
                    {j.permalink ? (
                      <a href={j.permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Abrir publicação
                        {j.externalId && <span className="block font-mono text-muted-foreground">ID {j.externalId}</span>}
                      </a>
                    ) : j.externalId ? (
                      <span className="font-mono" title="Publicado; link não informado pela plataforma">
                        ID {j.externalId}
                      </span>
                    ) : j.last_error_class ? (
                      <span title={j.last_error_message ?? ""}>{ERROR_CLASS_LABELS[j.last_error_class] ?? j.last_error_class}{j.last_error_message ? `: ${j.last_error_message}` : ""}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="Paginação">
          {page > 1 && (
            <Button asChild size="sm" variant="outline">
              <Link href={link({ page: String(page - 1) })}>Anterior</Link>
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            Página {page} de {pages}
          </span>
          {page < pages && (
            <Button asChild size="sm" variant="outline">
              <Link href={link({ page: String(page + 1) })}>Próxima</Link>
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}
