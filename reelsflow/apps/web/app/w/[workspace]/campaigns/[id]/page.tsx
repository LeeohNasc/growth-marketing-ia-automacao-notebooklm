import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus, TriangleAlert } from "lucide-react";
import {
  LAYER_LABELS,
  MODE_LABELS,
  ORDER_LABELS,
  SOCIAL_PLATFORM_LABELS,
  can,
  detectConflicts,
  isCompatible,
  resolveContent,
  type Compatibility,
  type JobStatus,
  type OrderStrategy,
  type SocialPlatform,
} from "@reelsflow/domain";
import { JobStatusBadge } from "@/components/job-status";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CAMPAIGN_STATUS } from "@/lib/labels";
import { signPaths } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { CampaignActions, ItemsList, SettingsForm, TargetEditor } from "./campaign-client";

export const metadata: Metadata = { title: "Campanha" };

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ created?: string; added?: string; plan_error?: string }>;
}) {
  const { workspace: slug, id } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const canEdit = can(role, "editContent");
  const supabase = await createClient();

  const { data: campaign } = await supabase.from("campaigns").select("*").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!campaign) notFound();

  const [{ data: targets }, { data: items }, { data: jobs }] = await Promise.all([
    supabase.from("campaign_targets").select("*").eq("campaign_id", id).order("created_at"),
    supabase.from("campaign_media").select("*").eq("campaign_id", id).order("position").order("added_at"),
    supabase.from("publication_jobs").select("id, target_id, campaign_media_id, media_asset_id, scheduled_at, status, social_account_id").eq("campaign_id", id).order("scheduled_at"),
  ]);
  const accountIds = (targets ?? []).map((t) => t.social_account_id);
  const mediaIds = [...new Set((items ?? []).map((i) => i.media_asset_id))];
  const [{ data: accounts }, { data: media }, { data: otherJobs }] = await Promise.all([
    accountIds.length ? supabase.from("social_accounts").select("*").in("id", accountIds) : Promise.resolve({ data: [] }),
    mediaIds.length
      ? supabase.from("media_assets").select("id, name, status, deleted_at, compatibility, thumbnail_path, default_caption").in("id", mediaIds)
      : Promise.resolve({ data: [] }),
    accountIds.length
      ? supabase
          .from("publication_jobs")
          .select("id, social_account_id, scheduled_at, campaign_id")
          .in("social_account_id", accountIds)
          .in("status", ["draft", "scheduled", "queued"])
          .gt("scheduled_at", new Date().toISOString())
      : Promise.resolve({ data: [] }),
  ]);
  const accById = new Map((accounts ?? []).map((a) => [a.id, a]));
  const mediaById = new Map((media ?? []).map((m) => [m.id, m]));
  const thumbs = await signPaths((media ?? []).map((m) => m.thumbnail_path).filter((p): p is string => Boolean(p)), 3600);
  const tz = campaign.timezone;
  const fmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz });

  // Contagens
  const live = (jobs ?? []).filter((j) => j.status !== "cancelled");
  const count = (s: string[]) => live.filter((j) => s.includes(j.status)).length;
  const upcoming = live.filter((j) => ["draft", "scheduled", "queued"].includes(j.status));
  const lastAt = upcoming.at(-1)?.scheduled_at;

  // Conflitos (espaçamento por conta, incluindo outras campanhas)
  const conflicts = (accounts ?? []).flatMap((a) =>
    detectConflicts(
      (otherJobs ?? []).filter((j) => j.social_account_id === a.id).map((j) => ({ id: j.id, accountId: a.id, scheduledAt: j.scheduled_at })),
      a.min_spacing_minutes,
    ),
  );
  const conflictJobs = new Set(conflicts.flatMap((c) => [c.a, c.b]));
  const ownConflicts = conflicts.filter((c) => (otherJobs ?? []).some((j) => j.campaign_id === id && (j.id === c.a || j.id === c.b)));

  // Vídeos sem publicação e por quê
  const jobsByItemTarget = new Set(live.map((j) => `${j.campaign_media_id}:${j.target_id}`));
  const missing: { name: string; account: string; reason: string }[] = [];
  for (const it of items ?? []) {
    const m = mediaById.get(it.media_asset_id);
    for (const t of targets ?? []) {
      if (campaign.mode === "independent" && it.target_id !== t.id) continue;
      if (jobsByItemTarget.has(`${it.id}:${t.id}`)) continue;
      const acc = accById.get(t.social_account_id);
      const reason = !m || m.deleted_at
        ? "vídeo excluído"
        : m.status !== "ready"
          ? "vídeo ainda não está pronto"
          : acc && !isCompatible({ campaignMediaId: it.id, mediaId: m.id, name: m.name, compatibility: m.compatibility as Compatibility }, acc.platform as SocialPlatform)
            ? "incompatível com a rede"
            : campaign.end_date
              ? "sem horário disponível até a data final"
              : "não planejado (recalcule)";
      missing.push({ name: m?.name ?? "—", account: acc?.display_name ?? "—", reason });
    }
  }

  // Valores efetivos por conta (camada vídeo varia por vídeo)
  const wsSettings = (workspace.settings ?? {}) as { default_caption?: string; default_hashtags?: string[] };
  const withOwnCaption = (items ?? []).filter((i) => i.caption_override || mediaById.get(i.media_asset_id)?.default_caption).length;
  const targetView = (targets ?? []).map((t) => {
    const acc = accById.get(t.social_account_id);
    const accSettings = (acc?.settings ?? {}) as { default_caption?: string; default_hashtags?: string[] };
    const eff = resolveContent({
      campaign: { caption: t.caption_override ?? campaign.caption, hashtags: t.hashtags_override ?? campaign.hashtags },
      account: { caption: accSettings.default_caption, hashtags: accSettings.default_hashtags },
      global: { caption: wsSettings.default_caption, hashtags: wsSettings.default_hashtags },
    });
    return {
      id: t.id,
      name: acc?.display_name ?? "Conta removida",
      platform: acc ? SOCIAL_PLATFORM_LABELS[acc.platform] : "—",
      offset: t.offset_minutes,
      weekdays: t.weekdays,
      times: t.times,
      caption: t.caption_override,
      effectiveCaption: [eff.caption.value, eff.hashtags.value.join(" ")].filter(Boolean).join(" · "),
      captionSource: eff.caption.source === "none" ? "nenhuma" : LAYER_LABELS[eff.caption.source],
    };
  });

  // Lista de vídeos (primeiro alvo no modo independente: agrupado por alvo)
  const firstJob = new Map<string, (typeof live)[number]>();
  for (const j of live) if (j.campaign_media_id && !firstJob.has(j.campaign_media_id)) firstJob.set(j.campaign_media_id, j);
  const itemView = (targetId: string | null) =>
    (items ?? [])
      .filter((i) => (campaign.mode === "independent" ? i.target_id === targetId : true))
      .map((i) => {
        const m = mediaById.get(i.media_asset_id);
        const j = firstJob.get(i.id);
        return {
          cmId: i.id,
          name: m?.name ?? "Vídeo removido",
          thumbUrl: m?.thumbnail_path ? (thumbs.get(m.thumbnail_path) ?? null) : null,
          status: m?.status ?? "missing",
          scheduled: j ? `${fmt.format(new Date(j.scheduled_at))} · ${j.status === "published" ? "publicado" : j.status === "draft" ? "rascunho" : "agendado"}` : null,
          jobStatus: j?.status ?? null,
          caption: i.caption_override,
          hashtags: i.hashtags_override,
          note: m && m.status !== "ready" ? "Vídeo ainda não está pronto" : null,
        };
      });
  const editable = ["draft", "active", "paused"].includes(campaign.status);
  const st = CAMPAIGN_STATUS[campaign.status];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <Link href={`/w/${slug}/campaigns`} className="text-sm text-muted-foreground hover:underline">
            ← Campanhas
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {campaign.name} <Badge variant={st.variant}>{st.label}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {MODE_LABELS[campaign.mode]} · {campaign.times.length}× por dia ({campaign.times.join(", ")}) · {tz.replaceAll("_", " ")} ·{" "}
            {ORDER_LABELS[campaign.order_strategy as OrderStrategy]}
          </p>
        </div>
        <CampaignActions slug={slug} id={id} status={campaign.status} canEdit={canEdit} />
      </div>

      {sp.created && campaign.status === "draft" && (
        <Alert>
          Calendário gerado como rascunho. Revise as datas, os valores efetivos e os avisos abaixo; depois clique em <strong>Ativar automação</strong>.
        </Alert>
      )}
      {sp.added && <Alert variant="success">{sp.added} vídeo(s) adicionados ao fim da fila.</Alert>}
      {sp.plan_error && <Alert variant="destructive">A campanha foi criada, mas o calendário não pôde ser gerado. Use “Recalcular calendário”.</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Planejadas", count(["draft", "scheduled", "queued"])],
          ["Publicadas", count(["published"])],
          ["Com problema", count(["failed_permanent", "needs_review", "uncertain", "failed_retryable"])],
          ["Conteúdo até", lastAt ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: tz }).format(new Date(lastAt)) : "—"],
        ].map(([k, v]) => (
          <Card key={k as string}>
            <CardHeader className="pb-1">
              <CardDescription>{k}</CardDescription>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">{v}</CardContent>
          </Card>
        ))}
      </div>

      {(missing.length > 0 || ownConflicts.length > 0) && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-warning" aria-hidden /> Pontos de atenção
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {ownConflicts.length > 0 && (
              <p>
                {ownConflicts.length} par(es) de publicações na mesma conta com intervalo menor que o espaçamento mínimo (inclui outras campanhas). O
                sistema respeita o espaçamento e pode atrasar a segunda publicação.
              </p>
            )}
            {missing.length > 0 && (
              <details>
                <summary className="cursor-pointer">{missing.length} combinação(ões) vídeo/conta sem publicação</summary>
                <ul className="mt-2 grid gap-1 text-muted-foreground">
                  {missing.slice(0, 50).map((m, i) => (
                    <li key={i}>
                      {m.name} → {m.account}: {m.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Próximas publicações</CardTitle>
            <CardDescription>Horários em {tz.replaceAll("_", " ")}.</CardDescription>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma publicação futura.</p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {upcoming.slice(0, 12).map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="w-40 tabular-nums">{fmt.format(new Date(j.scheduled_at))}</span>
                    <span className="min-w-0 flex-1 truncate">{mediaById.get(j.media_asset_id ?? "")?.name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">{accById.get(j.social_account_id ?? "")?.display_name}</span>
                    {conflictJobs.has(j.id) && <Badge variant="warning">Conflito</Badge>}
                    <JobStatusBadge status={j.status as JobStatus} />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/w/${slug}/calendar?campaign=${id}`}>Ver no calendário</Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/w/${slug}/queue?campaign=${id}`}>Ver na fila</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Contas</CardTitle>
            <CardDescription>
              Precedência: vídeo &gt; campanha &gt; conta &gt; padrão do workspace. {withOwnCaption} vídeo(s) têm legenda própria.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border">
              {targetView.map((t) => (
                <TargetEditor key={t.id} slug={slug} campaignId={id} target={t} independent={campaign.mode === "independent"} canEdit={canEdit && editable} />
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Vídeos ({campaign.mode === "independent" ? `${(items ?? []).length} itens em ${targetView.length} filas` : (items ?? []).length})</CardTitle>
            <CardDescription>
              {campaign.order_strategy === "manual" ? "Ordem personalizada: use as setas para reordenar." : `Ordem: ${ORDER_LABELS[campaign.order_strategy as OrderStrategy]}.`}
            </CardDescription>
          </div>
          {canEdit && editable && (
            <Button asChild size="sm">
              <Link href={`/w/${slug}/campaigns/${id}/add`}>
                <Plus /> Adicionar vídeos
              </Link>
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-6">
          {campaign.mode === "independent" ? (
            targetView.map((t) => (
              <section key={t.id} className="grid gap-2">
                <h3 className="text-sm font-medium">{t.name}</h3>
                <ItemsList slug={slug} campaignId={id} items={itemView(t.id)} manual={campaign.order_strategy === "manual"} canEdit={canEdit && editable} />
              </section>
            ))
          ) : (
            <ItemsList slug={slug} campaignId={id} items={itemView(null)} manual={campaign.order_strategy === "manual"} canEdit={canEdit && editable} />
          )}
        </CardContent>
      </Card>

      {canEdit && editable && (
        <Card>
          <details>
            <summary className="cursor-pointer px-5 py-4 font-semibold">Configuração da campanha</summary>
            <CardContent>
              <SettingsForm slug={slug} campaign={campaign} />
            </CardContent>
          </details>
        </Card>
      )}

      {campaign.summary && (
        <Card>
          <CardHeader>
            <CardTitle>Resumo</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3 text-sm">
            {Object.entries(campaign.summary as Record<string, number>).map(([k, v]) => (
              <span key={k} className="flex items-center gap-2">
                <JobStatusBadge status={k as JobStatus} /> {v}
              </span>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
