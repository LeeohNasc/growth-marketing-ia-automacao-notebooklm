"use client";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, Pin } from "lucide-react";
import { EDITABLE_STATUSES, LAYER_LABELS, SOCIAL_PLATFORM_LABELS, type JobStatus, type Layer, type SocialPlatform } from "@reelsflow/domain";
import {
  cancelJobsAction,
  confirmPublishedAction,
  getJobDetailsAction,
  rescheduleJobAction,
  retryJobsAction,
  updateJobCaptionAction,
  type JobDetails,
} from "@/app/w/[workspace]/queue/actions";
import { JobStatusBadge } from "@/components/job-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ERROR_CLASS_LABELS, REVIEW_REASONS } from "@/lib/labels";

export function JobSheet({ slug, jobId, onClose, canEdit, displayTz }: { slug: string; jobId: string | null; onClose: () => void; canEdit: boolean; displayTz: string }) {
  const [details, setDetails] = useState<JobDetails | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    getJobDetailsAction(slug, jobId).then((d) => {
      if (!active) return;
      setDetails(d);
      setLoadedId(jobId);
    });
    return () => {
      active = false;
    };
  }, [slug, jobId, version]);
  const loading = Boolean(jobId) && loadedId !== jobId;

  return (
    <Sheet open={Boolean(jobId)} onOpenChange={(o) => !o && onClose()}>
      {jobId && (
        <SheetContent side="right" aria-describedby={undefined}>
          <div className="border-b px-5 py-4 pr-12">
            <SheetTitle className="text-lg font-semibold">Publicação</SheetTitle>
          </div>
          {loading || !details ? (
            <div className="grid place-items-center p-10 text-muted-foreground">
              {loading ? <Loader2 className="size-6 animate-spin" aria-label="Carregando" /> : "Publicação não encontrada."}
            </div>
          ) : (
            <JobBody key={`${details.id}-${version}`} slug={slug} d={details} canEdit={canEdit} displayTz={displayTz} onChanged={() => setVersion((v) => v + 1)} />
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}

function JobBody({ slug, d, canEdit, displayTz, onChanged }: { slug: string; d: JobDetails; canEdit: boolean; displayTz: string; onChanged: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [date, setDate] = useState(d.localDate);
  const [time, setTime] = useState(d.localTime);
  const [caption, setCaption] = useState(d.captionOverride ?? "");
  const [permalink, setPermalink] = useState("");
  const status = d.status as JobStatus;
  const editable = canEdit && EDITABLE_STATUSES.includes(status);
  const fmt = (iso: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short", timeZone: displayTz }).format(new Date(iso));

  const run = (fn: () => Promise<{ ok: boolean; message?: string; conflict?: boolean }>, retryForce?: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      let r = await fn();
      if (!r.ok && r.conflict && retryForce && window.confirm(r.message)) r = await retryForce();
      setMsg(r.message ? { ok: r.ok, text: r.message } : null);
      if (r.ok) {
        router.refresh();
        onChanged();
      }
    });

  return (
    <div className="grid gap-5 overflow-y-auto p-5 text-sm">
      <div className="flex gap-3">
        {d.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária
          <img src={d.thumbUrl} alt="" className="h-24 w-14 rounded object-cover" />
        ) : (
          <span className="h-24 w-14 rounded bg-muted" />
        )}
        <div className="grid content-start gap-1">
          <span className="font-medium">{d.mediaName ?? "Vídeo removido"}</span>
          <span className="text-muted-foreground">
            {d.accountName ?? "Conta removida"} {d.platform && `· ${SOCIAL_PLATFORM_LABELS[d.platform as SocialPlatform]}`}
          </span>
          {d.campaignId && (
            <Link href={`/w/${slug}/campaigns/${d.campaignId}`} className="text-primary hover:underline">
              {d.campaignName}
            </Link>
          )}
          <div className="flex flex-wrap gap-1">
            <JobStatusBadge status={status} />
            {d.pinned && (
              <Badge variant="outline" title="Reagendada manualmente: preservada ao recalcular a campanha">
                <Pin className="mr-1 size-3" /> Fixada
              </Badge>
            )}
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Prevista</dt>
          <dd>{fmt(d.scheduledAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Efetiva</dt>
          <dd>{d.publishedAt ? fmt(d.publishedAt) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Tentativas</dt>
          <dd>
            {d.attemptCount} de {d.maxAttempts}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">ID externo</dt>
          <dd className="truncate">{d.external?.externalId ?? "—"}</dd>
        </div>
      </dl>

      {d.external?.permalink && (
        <a href={d.external.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          Abrir publicação <ExternalLink className="size-3.5" />
        </a>
      )}
      {d.platform === "mock" && <p className="text-xs text-warning">Conta simulada: o link não leva a uma publicação real.</p>}

      {(d.lastErrorClass || d.reviewReason) && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
          {d.reviewReason && <p>{REVIEW_REASONS[d.reviewReason] ?? d.reviewReason}</p>}
          {d.lastErrorClass && (
            <p>
              <strong>{ERROR_CLASS_LABELS[d.lastErrorClass] ?? d.lastErrorClass}</strong>
              {d.lastErrorMessage ? `: ${d.lastErrorMessage}` : ""}
            </p>
          )}
        </div>
      )}

      {d.effective?.caption !== undefined && (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">
            Texto enviado (legenda: {LAYER_LABELS[d.effective.sources?.caption as Layer] ?? "nenhuma"}; hashtags: {LAYER_LABELS[d.effective.sources?.hashtags as Layer] ?? "nenhuma"})
          </span>
          <p className="whitespace-pre-wrap rounded-md bg-muted p-2">{d.effective.caption || "—"}</p>
        </div>
      )}

      {editable && (
        <section className="grid gap-3 rounded-md border p-3">
          <h3 className="font-medium">Reagendar</h3>
          <p className="text-xs text-muted-foreground">Horário no fuso da publicação ({d.timezone.replaceAll("_", " ")}).</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="rs-date" className="text-xs">
                Data
              </Label>
              <Input id="rs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rs-time" className="text-xs">
                Horário
              </Label>
              <Input id="rs-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9" />
            </div>
            <Button size="sm" disabled={pending} onClick={() => run(() => rescheduleJobAction(slug, d.id, date, time), () => rescheduleJobAction(slug, d.id, date, time, true))}>
              Salvar horário
            </Button>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="rs-cap" className="text-xs">
              Legenda só desta publicação (opcional)
            </Label>
            <textarea id="rs-cap" value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={2200} className="rounded-md border border-input bg-transparent px-3 py-2" />
            <Button size="sm" variant="outline" className="justify-self-start" disabled={pending} onClick={() => run(() => updateJobCaptionAction(slug, d.id, caption))}>
              Salvar legenda
            </Button>
          </div>
        </section>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {["failed_permanent", "failed_retryable", "needs_review"].includes(status) && (
            <Button size="sm" disabled={pending} onClick={() => run(() => retryJobsAction(slug, [d.id]))}>
              Tentar novamente
            </Button>
          )}
          {editable && (
            <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => window.confirm("Cancelar esta publicação?") && run(() => cancelJobsAction(slug, [d.id]))}>
              Cancelar publicação
            </Button>
          )}
        </div>
      )}

      {canEdit && status === "needs_review" && (
        <section className="grid gap-2 rounded-md border p-3">
          <h3 className="font-medium">Já foi publicado?</h3>
          <p className="text-xs text-muted-foreground">Se você confirmou na rede que o vídeo está no ar, registre aqui para não publicar de novo.</p>
          <Input value={permalink} onChange={(e) => setPermalink(e.target.value)} placeholder="Link da publicação (opcional)" aria-label="Link da publicação" className="h-9" />
          <Button size="sm" variant="outline" className="justify-self-start" disabled={pending} onClick={() => run(() => confirmPublishedAction(slug, d.id, permalink))}>
            Marcar como publicado
          </Button>
        </section>
      )}

      {msg && (
        <p role="status" className={msg.ok ? "text-success" : "text-destructive"}>
          {msg.text}
        </p>
      )}

      <section className="grid gap-2">
        <h3 className="font-medium">Tentativas</h3>
        {d.attempts.length === 0 ? (
          <p className="text-muted-foreground">Nenhuma tentativa ainda.</p>
        ) : (
          <ol className="grid gap-2">
            {d.attempts.map((a, i) => (
              <li key={i} className="rounded-md border px-3 py-2 text-xs">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>
                    {a.kind === "reconcile" ? "Verificação na plataforma" : `Tentativa ${a.no}`} · {fmt(a.startedAt)}
                  </span>
                  <span className="font-medium">{a.outcome ?? "em andamento"}</span>
                </div>
                {a.errorClass && (
                  <p className="mt-1 text-muted-foreground">
                    {ERROR_CLASS_LABELS[a.errorClass] ?? a.errorClass}
                    {a.errorMessage ? `: ${a.errorMessage}` : ""}
                    {a.retryAfter ? ` (aguardar ${a.retryAfter}s)` : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
