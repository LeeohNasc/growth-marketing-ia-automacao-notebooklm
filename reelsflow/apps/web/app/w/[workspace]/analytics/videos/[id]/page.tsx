import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Temporal } from "temporal-polyfill";
import { ArrowLeft, CalendarDays, ExternalLink, Film, Megaphone } from "lucide-react";
import { PERFORMANCE_RULE, SOCIAL_PLATFORM_LABELS, performanceIndicator } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadContentPost } from "@/lib/content-analytics";
import { requireWorkspace } from "@/lib/session";
import { Metric, PerformanceBadge, fmtDateTime, fmtInt, fmtPct, fmtSecs } from "../../content-ui";
import { postTitle } from "../../tabs";

export const metadata: Metadata = { title: "Análise do vídeo" };

export default async function VideoAnalyticsPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  const tz = workspace.default_timezone;
  const data = await loadContentPost(workspace.id, id);
  if (!data) notFound();
  const { post: p, history, peers, job } = data;
  const perf = performanceIndicator(p, peers);

  const rows: { label: string; value: string | null; hint?: string }[] = [
    { label: "Visualizações", value: fmtInt(p.views) },
    { label: "Alcance", value: fmtInt(p.reach), hint: "contas únicas" },
    { label: "Impressões", value: fmtInt(p.impressions) },
    { label: "Curtidas", value: fmtInt(p.likes) },
    { label: "Comentários", value: fmtInt(p.comments) },
    { label: "Compartilhamentos", value: fmtInt(p.shares) },
    { label: "Salvamentos", value: fmtInt(p.saves) },
    { label: "Engajamento", value: fmtInt(p.engagement), hint: "soma de interações, pela definição da rede" },
    { label: "Taxa de engajamento", value: fmtPct(p.engagementRate), hint: "definição da Zernio/rede" },
    { label: "Novos seguidores", value: fmtInt(p.follows) },
    { label: "Visitas ao perfil", value: fmtInt(p.profile_views) },
    { label: "Tempo médio assistido", value: fmtSecs(p.avgWatchMs) },
    { label: "Taxa de conclusão", value: fmtPct(p.completionRate) },
  ];
  const day = p.publishedAt ? Temporal.Instant.from(p.publishedAt).toZonedDateTimeISO(tz).toPlainDate().toString() : null;

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div>
        <Link href={`/w/${slug}/analytics?tab=ranking`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> Ranking de vídeos
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{postTitle(p)}</h1>
        <p className="text-sm text-muted-foreground">
          {p.accountName ?? "—"} · {SOCIAL_PLATFORM_LABELS[p.platform]} · publicado em {fmtDateTime(p.publishedAt, tz)} · {p.origin === "reelsflow" ? "publicado pelo ReelsFlow" : "publicado fora do ReelsFlow"}
        </p>
      </div>

      {!p.metricsUpdatedAt && <Alert variant="warning">A integração ainda não sincronizou as métricas deste vídeo{p.syncStatus ? ` (situação: ${p.syncStatus})` : ""}. Os valores aparecem como Indisponível até lá.</Alert>}
      {p.syncError && <Alert variant="warning">A Zernio informou um problema ao ler este post: {p.syncError}</Alert>}

      <div className="flex flex-wrap gap-2">
        {p.permalink && (
          <Button asChild size="sm" variant="outline">
            <a href={p.permalink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden /> Abrir na rede
            </a>
          </Button>
        )}
        {p.mediaName && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/w/${slug}/library?q=${encodeURIComponent(p.mediaName)}`}>
              <Film className="size-4" aria-hidden /> Na Biblioteca
            </Link>
          </Button>
        )}
        {day && p.origin === "reelsflow" && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/w/${slug}/calendar?date=${day}`}>
              <CalendarDays className="size-4" aria-hidden /> No Calendário
            </Link>
          </Button>
        )}
        {job?.campaign_id && (
          <Button asChild size="sm" variant="outline">
            <Link href={`/w/${slug}/campaigns/${job.campaign_id}`}>
              <Megaphone className="size-4" aria-hidden /> Campanha {job.campaign ?? ""}
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Métricas acumuladas</CardTitle>
            <CardDescription>Desde a publicação até {fmtDateTime(p.metricsUpdatedAt, tz) ?? "—"} (última leitura). Dado da rede: {fmtDateTime(p.providerSyncedAt, tz) ?? "—"}.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {rows.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-3 border-b pb-2">
                  <dt className="text-sm text-muted-foreground">
                    {r.label}
                    {r.hint && <span className="block text-xs">{r.hint}</span>}
                  </dt>
                  <dd className="text-base font-medium">
                    <Metric value={r.value} />
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Indicador de desempenho</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <PerformanceBadge label={perf.label} />
            {perf.label === "insufficient" ? (
              <p className="text-muted-foreground">{perf.peers} vídeo(s) comparável(is); são necessários pelo menos {PERFORMANCE_RULE.minPeers}.</p>
            ) : (
              <p className="text-muted-foreground">
                {Math.round((perf.ratio ?? 0) * 100)}% da mediana ({fmtInt(perf.median)} visualizações) de {perf.peers} vídeos da mesma conta com idade parecida.
              </p>
            )}
            <p className="text-xs text-muted-foreground">{PERFORMANCE_RULE.description}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Histórico diário</CardTitle>
          <CardDescription>Uma foto por dia, registrada pelo ReelsFlow. Não há histórico antes da primeira sincronização; nada é reconstruído ou estimado.</CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem fotos diárias ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1.5">Dia (UTC)</th>
                    <th scope="col" className="py-1.5 text-right">Visualizações</th>
                    <th scope="col" className="py-1.5 text-right">Curtidas</th>
                    <th scope="col" className="py-1.5 text-right">Comentários</th>
                    <th scope="col" className="py-1.5 text-right">Compart.</th>
                    <th scope="col" className="py-1.5 text-right">Salvos</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...history].reverse().map((h) => (
                    <tr key={h.day}>
                      <td className="py-1.5">{h.day.split("-").reverse().join("/")}</td>
                      <td className="py-1.5 text-right"><Metric value={fmtInt(h.views)} /></td>
                      <td className="py-1.5 text-right"><Metric value={fmtInt(h.likes)} /></td>
                      <td className="py-1.5 text-right"><Metric value={fmtInt(h.comments)} /></td>
                      <td className="py-1.5 text-right"><Metric value={fmtInt(h.shares)} /></td>
                      <td className="py-1.5 text-right"><Metric value={fmtInt(h.saves)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
