"use client";
import { useMemo, useState } from "react";
import { PLATFORMS, PLATFORM_LABELS, formatDuration, type Compatibility } from "@reelsflow/domain";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type PickerVideo = { id: string; name: string; duration_ms: number | null; compatibility: unknown; thumbUrl: string | null; created_at: string };

/** Seleção de vídeos prontos (envia `media[]` na ordem de seleção). */
export function VideoPicker({ videos, error, exclude = [], initialSelected = [] }: { videos: PickerVideo[]; error?: string; exclude?: string[]; initialSelected?: string[] }) {
  const [q, setQ] = useState("");
  // Pré-seleção (ex.: "Agendar" a partir de um Card Editorial pronto); só ids existentes na lista.
  const [selected, setSelected] = useState<string[]>(() => initialSelected.filter((id) => videos.some((v) => v.id === id)));
  const available = useMemo(() => videos.filter((v) => !exclude.includes(v.id)), [videos, exclude]);
  const shown = available.filter((v) => v.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allShown = shown.length > 0 && shown.every((v) => selected.includes(v.id));

  return (
    <div className="grid gap-3">
      {selected.map((id) => (
        <input key={id} type="hidden" name="media" value={id} />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="video-search" className="sr-only">
          Buscar vídeos
        </Label>
        <Input id="video-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar vídeos prontos" className="max-w-xs" />
        <button
          type="button"
          className="text-sm text-primary underline-offset-4 hover:underline"
          onClick={() => setSelected(allShown ? selected.filter((id) => !shown.some((v) => v.id === id)) : [...new Set([...selected, ...shown.map((v) => v.id)])])}
        >
          {allShown ? "Desmarcar exibidos" : `Selecionar exibidos (${shown.length})`}
        </button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {selected.length} selecionado(s) · a ordem de seleção é usada na “ordem personalizada”
        </span>
      </div>
      {available.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhum vídeo pronto disponível. Envie vídeos e aguarde a análise.</p>
      ) : (
        <ul className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto rounded-lg border p-2 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((v) => {
            const idx = selected.indexOf(v.id);
            const compat = v.compatibility as Compatibility | null;
            const blocked = PLATFORMS.filter((p) => compat?.platforms?.[p]?.status === "error").map((p) => PLATFORM_LABELS[p]);
            return (
              <li key={v.id}>
                <label className={cn("flex cursor-pointer gap-2 rounded-md border p-2 text-sm", idx >= 0 ? "border-primary bg-primary/10" : "hover:bg-accent")}>
                  <input type="checkbox" checked={idx >= 0} onChange={() => toggle(v.id)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                  {v.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária
                    <img src={v.thumbUrl} alt="" className="h-14 w-8 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="h-14 w-8 shrink-0 rounded bg-muted" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{v.name}</span>
                    <span className="block text-xs text-muted-foreground">{formatDuration(v.duration_ms)}</span>
                    {blocked.length > 0 && <span className="block text-xs text-warning">Incompatível: {blocked.join(", ")}</span>}
                    {idx >= 0 && <span className="block text-xs text-primary">#{idx + 1}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
