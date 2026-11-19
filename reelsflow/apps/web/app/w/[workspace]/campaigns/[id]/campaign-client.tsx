"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pause, Play, RefreshCw, Archive, Trash2 } from "lucide-react";
import { WEEKDAY_LABELS } from "@reelsflow/domain";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { ContentFields, ScheduleFields } from "@/components/schedule-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import type { CampaignRow } from "@/lib/database.types";
import {
  campaignStatusAction,
  moveCampaignMediaAction,
  removeCampaignMediaAction,
  replanAction,
  setMediaCaptionAction,
  updateCampaignSettingsAction,
  updateTargetAction,
} from "../actions";

type Res = { ok: boolean; message?: string };

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<Res>, success?: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.message || success ? { ok: true, text: r.message ?? success! } : null) : { ok: false, text: r.message ?? "Não foi possível concluir." });
      router.refresh();
    });
  return { pending, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p role="status" className={msg.ok ? "text-sm text-success" : "text-sm text-destructive"}>
      {msg.text}
    </p>
  );
}

export function CampaignActions({ slug, id, status, canEdit }: { slug: string; id: string; status: CampaignRow["status"]; canEdit: boolean }) {
  const { pending, msg, run } = useAction();
  if (!canEdit) return null;
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "draft" && (
          <Button disabled={pending} onClick={() => run(() => campaignStatusAction(slug, id, "activate"), "Campanha ativada. As publicações seguirão o calendário.")}>
            <Play /> Ativar automação
          </Button>
        )}
        {status === "active" && (
          <Button variant="outline" disabled={pending} onClick={() => run(() => campaignStatusAction(slug, id, "pause"), "Campanha pausada.")}>
            <Pause /> Pausar
          </Button>
        )}
        {status === "paused" && (
          <Button disabled={pending} onClick={() => run(() => campaignStatusAction(slug, id, "resume"), "Campanha retomada. Publicações vencidas durante a pausa vão para revisão.")}>
            <Play /> Retomar
          </Button>
        )}
        {["draft", "active", "paused"].includes(status) && (
          <Button variant="outline" disabled={pending} onClick={() => run(() => replanAction(slug, id))}>
            <RefreshCw /> Recalcular calendário
          </Button>
        )}
        {status !== "archived" && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              window.confirm("Arquivar a campanha? Publicações futuras serão canceladas; o histórico é mantido.") &&
              run(() => campaignStatusAction(slug, id, "archive"), "Campanha arquivada.")
            }
          >
            <Archive /> Arquivar
          </Button>
        )}
      </div>
      <Msg msg={msg} />
    </div>
  );
}

export function SettingsForm({ slug, campaign }: { slug: string; campaign: CampaignRow }) {
  const [state, action] = useActionState(updateCampaignSettingsAction, initialActionState);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-5" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={campaign.id} />
      <input type="hidden" name="mode" value={campaign.mode} />
      <Field label="Nome" name="name" defaultValue={campaign.name} error={e.name} />
      <ScheduleFields
        errors={e}
        defaults={{
          timezone: campaign.timezone,
          weekdays: campaign.weekdays,
          times: campaign.times,
          orderStrategy: campaign.order_strategy,
          maxLatenessMinutes: campaign.max_lateness_minutes,
        }}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Data inicial" name="start_date" type="date" defaultValue={campaign.start_date} error={e.startDate} />
        <Field label="Data final (opcional)" name="end_date" type="date" defaultValue={campaign.end_date ?? ""} error={e.endDate} />
      </div>
      <ContentFields caption={campaign.caption} hashtags={campaign.hashtags} captionLabel="Legenda da campanha" />
      <SubmitButton className="justify-self-start" pendingText="Recalculando…">
        Salvar e recalcular
      </SubmitButton>
      <p className="text-xs text-muted-foreground">Somente publicações futuras ainda não iniciadas são recalculadas. Reagendamentos manuais são preservados.</p>
    </form>
  );
}

type Target = {
  id: string;
  name: string;
  platform: string;
  offset: number;
  weekdays: number[] | null;
  times: string[] | null;
  caption: string | null;
  effectiveCaption: string;
  captionSource: string;
};

export function TargetEditor({ slug, campaignId, target, independent, canEdit }: { slug: string; campaignId: string; target: Target; independent: boolean; canEdit: boolean }) {
  const { pending, msg, run } = useAction();
  const [days, setDays] = useState<number[]>(target.weekdays ?? []);
  const [times, setTimes] = useState((target.times ?? []).join(", "));
  const [offset, setOffset] = useState(target.offset);
  const [caption, setCaption] = useState(target.caption ?? "");
  return (
    <li className="grid gap-3 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{target.name}</span>
        <span className="text-xs text-muted-foreground">{target.platform}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Legenda efetiva (quando o vídeo não tem própria): <span className="text-foreground">{target.effectiveCaption || "— (sem legenda)"}</span> · origem:{" "}
        {target.captionSource}
      </p>
      {canEdit && (
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm">Configuração desta conta na campanha</summary>
          <div className="mt-3 grid gap-3">
            {independent ? (
              <>
                <fieldset className="grid gap-1">
                  <legend className="text-xs text-muted-foreground">Dias próprios (vazio = os da campanha)</legend>
                  <div className="flex flex-wrap gap-1">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <label key={d} className="flex items-center gap-1 rounded border px-2 py-1 text-xs has-[:checked]:border-primary">
                        <input type="checkbox" checked={days.includes(d)} onChange={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())} className="accent-[var(--primary)]" />
                        {WEEKDAY_LABELS[d]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-1">
                  <Label htmlFor={`times-${target.id}`} className="text-xs text-muted-foreground">
                    Horários próprios (ex.: 10:00, 18:30)
                  </Label>
                  <Input id={`times-${target.id}`} value={times} onChange={(e) => setTimes(e.target.value)} className="h-9" />
                </div>
              </>
            ) : (
              <div className="grid gap-1">
                <Label htmlFor={`off-${target.id}`} className="text-xs text-muted-foreground">
                  Deslocamento em relação ao horário da campanha (min)
                </Label>
                <Input id={`off-${target.id}`} type="number" min={-720} max={720} value={offset} onChange={(e) => setOffset(Number(e.target.value))} className="h-9 w-28" />
              </div>
            )}
            <div className="grid gap-1">
              <Label htmlFor={`cap-${target.id}`} className="text-xs text-muted-foreground">
                Legenda específica desta conta (opcional)
              </Label>
              <textarea id={`cap-${target.id}`} value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={2200} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
            </div>
            <Button
              size="sm"
              className="justify-self-start"
              disabled={pending}
              onClick={() =>
                run(() =>
                  updateTargetAction(slug, campaignId, target.id, {
                    offset,
                    caption,
                    ...(independent ? { weekdays: days, times: times.split(/[,\s]+/).filter(Boolean) } : {}),
                  }),
                )
              }
            >
              Salvar e recalcular
            </Button>
          </div>
        </details>
      )}
      <Msg msg={msg} />
    </li>
  );
}

type Item = { cmId: string; name: string; thumbUrl: string | null; status: string; scheduled: string | null; jobStatus: string | null; caption: string | null; hashtags: string[] | null; note: string | null };

export function ItemsList({ slug, campaignId, items, manual, canEdit }: { slug: string; campaignId: string; items: Item[]; manual: boolean; canEdit: boolean }) {
  const { pending, msg, run } = useAction();
  return (
    <div className="grid gap-2">
      <Msg msg={msg} />
      <ol className="divide-y rounded-lg border">
        {items.map((it, i) => (
          <li key={it.cmId} className="grid gap-2 px-3 py-2 text-sm">
            <div className="flex items-center gap-3">
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              {it.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária
                <img src={it.thumbUrl} alt="" className="h-10 w-6 shrink-0 rounded object-cover" />
              ) : (
                <span className="h-10 w-6 shrink-0 rounded bg-muted" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{it.name}</span>
                <span className="block text-xs text-muted-foreground">{it.scheduled ?? it.note ?? "Sem publicação planejada"}</span>
              </span>
              {canEdit && manual && (
                <span className="flex gap-1">
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Mover para cima" disabled={pending || i === 0} onClick={() => run(() => moveCampaignMediaAction(slug, campaignId, it.cmId, -1))}>
                    <ArrowUp />
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Mover para baixo" disabled={pending || i === items.length - 1} onClick={() => run(() => moveCampaignMediaAction(slug, campaignId, it.cmId, 1))}>
                    <ArrowDown />
                  </Button>
                </span>
              )}
              {canEdit && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  aria-label={`Remover ${it.name} da campanha`}
                  disabled={pending}
                  onClick={() => window.confirm(`Remover "${it.name}" da campanha? Publicações futuras dele serão canceladas.`) && run(() => removeCampaignMediaAction(slug, campaignId, [it.cmId]))}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
            {canEdit && <CaptionException slug={slug} campaignId={campaignId} item={it} run={run} pending={pending} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CaptionException({ slug, campaignId, item, run, pending }: { slug: string; campaignId: string; item: Item; run: (fn: () => Promise<Res>) => void; pending: boolean }) {
  const [caption, setCaption] = useState(item.caption ?? "");
  const [tags, setTags] = useState((item.hashtags ?? []).join(" "));
  return (
    <details className="ml-9 text-xs">
      <summary className="cursor-pointer text-muted-foreground">{item.caption || item.hashtags?.length ? "Exceção de legenda definida" : "Definir exceção de legenda para este vídeo"}</summary>
      <div className="mt-2 grid gap-2">
        <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={2200} aria-label="Legenda do vídeo nesta campanha" className="rounded-md border border-input bg-transparent px-2 py-1 text-sm" />
        <Input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Hashtags do vídeo nesta campanha" placeholder="#hashtags" className="h-8" />
        <Button size="sm" variant="outline" className="justify-self-start" disabled={pending} onClick={() => run(() => setMediaCaptionAction(slug, campaignId, item.cmId, caption, tags))}>
          Salvar exceção
        </Button>
      </div>
    </details>
  );
}
