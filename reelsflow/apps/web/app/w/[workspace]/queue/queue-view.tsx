"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Pause, Play } from "lucide-react";
import { EDITABLE_STATUSES, SOCIAL_PLATFORM_LABELS, type JobStatus, type SocialPlatform } from "@reelsflow/domain";
import { JobSheet } from "@/components/job-sheet";
import { JobStatusBadge } from "@/components/job-status";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { JobListItem } from "@/lib/jobs";
import { ERROR_CLASS_LABELS, friendlyError } from "@/lib/labels";
import { cancelJobsAction, retryJobsAction, setQueuePausedAction } from "./actions";

type Props = {
  slug: string;
  items: JobListItem[];
  total: number;
  page: number;
  pageSize: number;
  groups: { key: string; label: string }[];
  filters: { group: string; campaign: string; account: string };
  campaigns: { id: string; name: string }[];
  accounts: { id: string; display_name: string }[];
  canEdit: boolean;
  canAdmin: boolean;
  queuePaused: boolean;
  tz: string;
};

export function QueueView(p: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: p.tz });
  const go = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) n.set(k, v);
      else n.delete(k);
    }
    if (!("page" in patch)) n.delete("page");
    router.push(`/w/${p.slug}/queue?${n.toString()}`);
  };
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.message ? { ok: r.ok, text: r.message } : null);
      setSelected(new Set());
      router.refresh();
    });
  const sel = [...selected];
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="grid gap-4">
      {p.queuePaused && (
        <Alert variant="warning">A fila do workspace está pausada: nenhuma publicação será enviada até ser retomada.</Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {[
          { id: "group", label: "Situação", value: p.filters.group, options: p.groups.map((g) => [g.key, g.label]) },
          { id: "campaign", label: "Campanha", value: p.filters.campaign, options: [["", "Todas"], ...p.campaigns.map((c) => [c.id, c.name])] },
          { id: "account", label: "Conta", value: p.filters.account, options: [["", "Todas"], ...p.accounts.map((a) => [a.id, a.display_name])] },
        ].map((f) => (
          <div key={f.id} className="grid gap-1">
            <Label htmlFor={`f-${f.id}`} className="text-xs text-muted-foreground">
              {f.label}
            </Label>
            <NativeSelect id={`f-${f.id}`} value={f.value} onChange={(e) => go({ [f.id]: e.target.value })} className="w-auto min-w-40">
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </div>
        ))}
        {p.canAdmin && (
          <Button className="ml-auto" variant={p.queuePaused ? "default" : "outline"} disabled={pending} onClick={() => run(() => setQueuePausedAction(p.slug, !p.queuePaused))}>
            {p.queuePaused ? (
              <>
                <Play /> Retomar fila
              </>
            ) : (
              <>
                <Pause /> Pausar fila
              </>
            )}
          </Button>
        )}
      </div>

      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-success" : "text-sm text-destructive"}>
          {msg.text}
        </p>
      )}

      {p.canEdit && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
          <span className="px-2 text-sm font-medium">{selected.size} selecionada(s)</span>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => retryJobsAction(p.slug, sel))}>
            Tentar novamente (falhas/revisão)
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => window.confirm(`Cancelar ${selected.size} publicação(ões)?`) && run(() => cancelJobsAction(p.slug, sel))}>
            Cancelar
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Limpar seleção
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              {p.canEdit && (
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Selecionar todas"
                    className="size-4 accent-[var(--primary)]"
                    checked={p.items.length > 0 && p.items.every((i) => selected.has(i.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(p.items.map((i) => i.id)) : new Set())}
                  />
                </th>
              )}
              <th className="px-3 py-2 font-medium">Prevista</th>
              <th className="px-3 py-2 font-medium">Vídeo</th>
              <th className="px-3 py-2 font-medium">Conta</th>
              <th className="px-3 py-2 font-medium">Campanha</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Situação / link</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {p.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  Nenhuma publicação neste filtro.
                </td>
              </tr>
            ) : (
              p.items.map((j) => (
                <tr key={j.id} className="hover:bg-accent/40">
                  {p.canEdit && (
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label="Selecionar publicação" checked={selected.has(j.id)} onChange={() => toggle(j.id)} disabled={!EDITABLE_STATUSES.includes(j.status as JobStatus)} className="size-4 accent-[var(--primary)]" />
                    </td>
                  )}
                  <td className="px-3 py-2 tabular-nums">
                    <button type="button" className="text-left hover:underline" onClick={() => setOpenId(j.id)}>
                      {fmt.format(new Date(j.scheduled_at))}
                    </button>
                    {j.published_at && <span className="block text-xs text-muted-foreground">efetiva {fmt.format(new Date(j.published_at))}</span>}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2">{j.media ?? "—"}</td>
                  <td className="px-3 py-2">
                    {j.account ?? "—"}
                    {j.platform && <span className="block text-xs text-muted-foreground">{SOCIAL_PLATFORM_LABELS[j.platform as SocialPlatform]}</span>}
                  </td>
                  <td className="max-w-40 truncate px-3 py-2">{j.campaign ?? "—"}</td>
                  <td className="px-3 py-2">
                    <JobStatusBadge status={j.status as JobStatus} />
                  </td>
                  <td className="max-w-56 px-3 py-2 text-xs">
                    {j.permalink ? (
                      <a href={j.permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {j.externalId ?? "Abrir"}
                      </a>
                    ) : j.last_error_class ? (
                      <span className="text-muted-foreground" title={`${ERROR_CLASS_LABELS[j.last_error_class] ?? j.last_error_class}${j.last_error_message ? `: ${j.last_error_message}` : ""} · ${j.attempt_count} tentativa(s)`}>
                        {friendlyError(j.last_error_class)}
                      </span>
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
          <Button size="sm" variant="outline" disabled={p.page <= 1} onClick={() => go({ page: String(p.page - 1) })}>
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">
            Página {p.page} de {pages} · {p.total} publicações
          </span>
          <Button size="sm" variant="outline" disabled={p.page >= pages} onClick={() => go({ page: String(p.page + 1) })}>
            Próxima
          </Button>
        </nav>
      )}

      <JobSheet slug={p.slug} jobId={openId} onClose={() => setOpenId(null)} canEdit={p.canEdit} displayTz={p.tz} />
    </div>
  );
}
