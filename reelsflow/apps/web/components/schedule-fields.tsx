"use client";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ORDER_LABELS, ORDER_STRATEGIES, WEEKDAY_LABELS, type OrderStrategy } from "@reelsflow/domain";
import { CaptionField } from "@/components/caption-field";
import { TimezoneSelect } from "@/components/timezone-select";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ScheduleDefaults = {
  timezone: string;
  weekdays: number[];
  times: string[];
  orderStrategy?: string;
  maxLatenessMinutes?: number;
};

/** Dias da semana + horários + fuso + ordem. Envia `weekdays[]`, `times[]`, `timezone`, `order_strategy`, `max_lateness_minutes`. */
export function ScheduleFields({ defaults, errors = {}, showOrder = true }: { defaults: ScheduleDefaults; errors?: Record<string, string>; showOrder?: boolean }) {
  const [times, setTimes] = useState<string[]>(defaults.times.length ? defaults.times : ["09:00"]);
  const [draft, setDraft] = useState("12:00");
  const add = () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft) || times.includes(draft) || times.length >= 24) return;
    setTimes([...times, draft].sort());
  };
  return (
    <div className="grid gap-5">
      <TimezoneSelect defaultValue={defaults.timezone} error={errors.timezone} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Dias da semana</legend>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
              <input type="checkbox" name="weekdays" value={d} defaultChecked={defaults.weekdays.includes(d)} className="size-4 accent-[var(--primary)]" />
              {WEEKDAY_LABELS[d]}
            </label>
          ))}
        </div>
        {errors.weekdays && <p className="text-xs text-destructive">{errors.weekdays}</p>}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Horários ({times.length} por dia)</legend>
        <div className="flex flex-wrap items-center gap-2">
          {times.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-secondary py-1 pl-3 pr-1 text-sm tabular-nums">
              <input type="hidden" name="times" value={t} />
              {t}
              <button type="button" onClick={() => setTimes(times.filter((x) => x !== t))} className="rounded-full p-0.5 hover:bg-background" aria-label={`Remover ${t}`}>
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          <div className="flex items-center gap-1">
            <Label htmlFor="new-time" className="sr-only">
              Novo horário
            </Label>
            <Input id="new-time" type="time" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9 w-28" />
            <Button type="button" size="sm" variant="outline" onClick={add}>
              <Plus /> Adicionar
            </Button>
          </div>
        </div>
        {errors.times && <p className="text-xs text-destructive">{errors.times}</p>}
      </fieldset>
      {showOrder && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="order_strategy">Ordem dos vídeos</Label>
            <NativeSelect id="order_strategy" name="order_strategy" defaultValue={defaults.orderStrategy ?? "upload"}>
              {ORDER_STRATEGIES.map((o) => (
                <option key={o} value={o}>
                  {ORDER_LABELS[o as OrderStrategy]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="max_lateness_minutes">Tolerância de atraso (min)</Label>
            <Input id="max_lateness_minutes" name="max_lateness_minutes" type="number" min={5} max={10080} defaultValue={defaults.maxLatenessMinutes ?? 120} />
            <p className="text-xs text-muted-foreground">Se o sistema ficar indisponível e a publicação passar disto, ela vai para revisão em vez de sair atrasada.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContentFields({ caption, hashtags, captionLabel = "Legenda padrão" }: { caption?: string | null; hashtags?: string[]; captionLabel?: string }) {
  return <CaptionField caption={caption} hashtags={hashtags} label={captionLabel} rows={3} hint="Usada quando o vídeo não tem legenda própria. Escreva as hashtags no próprio texto." />;
}
