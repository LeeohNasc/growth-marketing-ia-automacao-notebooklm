"use client";
import { useActionState, useState } from "react";
import { MODE_LABELS, SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@reelsflow/domain";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { ContentFields, ScheduleFields } from "@/components/schedule-fields";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import type { TemplateRow } from "@/lib/database.types";
import { createCampaignAction } from "../actions";
import { VideoPicker, type PickerVideo } from "../video-picker";

type Account = { id: string; display_name: string; username: string | null; provider: "native" | "zernio"; platform: SocialPlatform; status: string; paused: boolean };

export function CampaignWizard(props: {
  preselectedMedia?: string[];
  slug: string;
  templates: TemplateRow[];
  accounts: Account[];
  videos: PickerVideo[];
  collections: { id: string; name: string; count: number }[];
  defaultTimezone: string;
  today: string;
}) {
  const [state, action] = useActionState(createCampaignAction, initialActionState);
  const [templateId, setTemplateId] = useState("");
  const [source, setSource] = useState<"videos" | "collection">("videos");
  const [mode, setMode] = useState<"mirrored" | "independent">("mirrored");
  const t = props.templates.find((x) => x.id === templateId);
  const e = state.fieldErrors ?? {};

  return (
    <form action={action} className="grid gap-6" noValidate>
      <input type="hidden" name="slug" value={props.slug} />
      <FormMessage state={state} />

      <Card>
        <CardHeader>
          <CardTitle>1. Vídeos</CardTitle>
          <CardDescription>Somente vídeos prontos (já analisados) podem ser agendados.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Origem dos vídeos">
            {(["videos", "collection"] as const).map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                <input type="radio" name="source" value={s} checked={source === s} onChange={() => setSource(s)} className="accent-[var(--primary)]" />
                {s === "videos" ? "Escolher vídeos" : "Usar uma coleção"}
              </label>
            ))}
          </div>
          {source === "videos" ? (
            <VideoPicker videos={props.videos} error={e.media} initialSelected={props.preselectedMedia} />
          ) : (
            <div className="grid gap-3">
              <div className="grid max-w-sm gap-2">
                <Label htmlFor="collection">Coleção</Label>
                <NativeSelect id="collection" name="collection" defaultValue="">
                  <option value="">Escolha…</option>
                  {props.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.count})
                    </option>
                  ))}
                </NativeSelect>
                {e.collection && <p className="text-xs text-destructive">{e.collection}</p>}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="follow_collection" defaultChecked className="mt-0.5 size-4 accent-[var(--primary)]" />
                <span>
                  Incluir automaticamente novos vídeos desta coleção no fim da fila
                  <span className="block text-xs text-muted-foreground">Regra de automação “Novos vídeos da coleção”, configurável em Automações.</span>
                </span>
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Contas e modelo</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field label="Nome da campanha" name="name" placeholder="Ex.: Dezembro — dicas rápidas" error={e.name} />
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Publicar em</legend>
            {props.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma conta conectada. Conecte uma conta (ou crie uma conta simulada para testes) em Contas Conectadas.</p>
            ) : (
              <ul className="grid gap-2">
                {props.accounts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
                    <label className="flex flex-1 items-center gap-2">
                      <input type="checkbox" name="accounts" value={a.id} className="size-4 accent-[var(--primary)]" />
                      {a.display_name}
                      {a.username && <span className="text-muted-foreground">@{a.username}</span>}
                      {a.provider === "zernio" && <span className="text-xs text-muted-foreground">via Zernio</span>}
                      <Badge variant={a.platform === "mock" ? "warning" : "secondary"}>{SOCIAL_PLATFORM_LABELS[a.platform]}</Badge>
                      {(a.paused || a.status !== "active") && <Badge variant="outline">{a.paused ? "Pausada" : "Requer reconexão"}</Badge>}
                    </label>
                    {mode === "mirrored" && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Label htmlFor={`offset_${a.id}`}>Deslocamento</Label>
                        <Input id={`offset_${a.id}`} name={`offset_${a.id}`} type="number" min={-720} max={720} defaultValue={0} className="h-8 w-20" />
                        min
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {e.accounts && <p className="text-xs text-destructive">{e.accounts}</p>}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="template">Modelo</Label>
              <NativeSelect id="template" name="template" value={templateId} onChange={(ev) => {
                setTemplateId(ev.target.value);
                const tpl = props.templates.find((x) => x.id === ev.target.value);
                if (tpl) setMode(tpl.mode);
              }}>
                <option value="">Configuração personalizada</option>
                {props.templates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mode">Distribuição</Label>
              <NativeSelect id="mode" name="mode" value={mode} onChange={(ev) => setMode(ev.target.value as typeof mode)}>
                <option value="mirrored">{MODE_LABELS.mirrored}</option>
                <option value="independent">{MODE_LABELS.independent}</option>
              </NativeSelect>
            </div>
          </div>
          {mode === "independent" && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Cada conta recebe sua própria fila com os vídeos escolhidos. Depois de criar, você pode definir horários e remover vídeos por conta.
            </p>
          )}
          {/* key: remonta os campos com os valores do modelo escolhido */}
          <div key={templateId} className="grid gap-5">
            <ScheduleFields
              errors={e}
              defaults={{
                timezone: t?.timezone ?? props.defaultTimezone,
                weekdays: t?.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
                times: t?.times ?? ["09:00", "13:00", "19:00"],
                orderStrategy: t?.order_strategy,
                maxLatenessMinutes: t?.max_lateness_minutes,
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Data inicial" name="start_date" type="date" defaultValue={props.today} min={props.today} error={e.startDate} />
              <Field label="Data final (opcional)" name="end_date" type="date" min={props.today} error={e.endDate} />
            </div>
            <ContentFields caption={t?.caption} hashtags={t?.hashtags} captionLabel="Legenda da campanha" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Revisar</CardTitle>
          <CardDescription>
            A campanha é criada como <strong>rascunho</strong> com o calendário calculado. Na próxima tela você revisa datas, valores
            efetivos, conflitos e vídeos incompatíveis antes de ativar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SubmitButton pendingText="Gerando calendário…">Gerar calendário</SubmitButton>
        </CardContent>
      </Card>
    </form>
  );
}
