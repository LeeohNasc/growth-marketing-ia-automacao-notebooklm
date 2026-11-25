"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { CalendarCheck, Loader2, Newspaper, RefreshCw } from "lucide-react";
import { composeCaption, extraHashtags, normalizeHashtags, resolveContent } from "@reelsflow/domain";
import { CaptionField } from "@/components/caption-field";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCardAction } from "../actions";
import { Uploader } from "../../upload/uploader";
import { quickScheduleAction, type QuickResult } from "./actions";

export type QuickVideo = { id: string; name: string; durationMs: number | null; caption: string | null; hashtags: string[]; fromCard: boolean };
export type QuickAccount = { id: string; name: string; platform: string; username: string | null; defaultCaption: string | null; defaultHashtags: string[] };

const step = "grid gap-3 rounded-xl border bg-card p-4";
const stepTitle = "flex items-center gap-2 font-medium";
const num = "grid size-6 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary";

/**
 * Publicação rápida em UMA tela: 1. Vídeo · 2. Personalizar · 3. Quando · 4. Revisar e agendar.
 * A prévia do texto final usa as mesmas regras do worker (precedência + composição sem hashtag repetida).
 */
export function QuickPublish(props: {
  slug: string;
  workspaceId: string;
  maxBytes: number;
  timezone: string;
  videos: QuickVideo[];
  accounts: QuickAccount[];
  defaults: { media: string; account: string; date: string; time: string; today: string };
  workspaceDefaults: { caption: string | null; hashtags: string[] };
  /** A Biblioteca tem mais vídeos prontos do que os carregados aqui. */
  truncated?: boolean;
}) {
  const router = useRouter();
  const [mediaId, setMediaId] = useState(props.defaults.media);
  const [q, setQ] = useState("");
  const [accountId, setAccountId] = useState(props.defaults.account);
  const [date, setDate] = useState(props.defaults.date);
  const [time, setTime] = useState(props.defaults.time);
  const video = props.videos.find((v) => v.id === mediaId) ?? null;
  const account = props.accounts.find((a) => a.id === accountId) ?? null;
  const [caption, setCaption] = useState(video?.caption ?? "");
  const [extra, setExtra] = useState((video?.hashtags ?? []).join(" "));
  const [result, setResult] = useState<QuickResult | null>(null);
  const [pending, start] = useTransition();

  const pickVideo = (id: string) => {
    const v = props.videos.find((x) => x.id === id);
    setMediaId(id);
    setCaption(v?.caption ?? "");
    setExtra((v?.hashtags ?? []).join(" "));
    setResult(null);
  };

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (term ? props.videos.filter((v) => v.name.toLowerCase().includes(term)) : props.videos).slice(0, 60);
    // o vídeo escolhido fica sempre visível no topo (ex.: vindo do Card Editorial com ?media=)
    const sel = props.videos.find((v) => v.id === mediaId);
    return sel && (!term || sel.name.toLowerCase().includes(term)) ? [sel, ...list.filter((v) => v.id !== sel.id)] : list;
  }, [q, props.videos, mediaId]);

  // Texto final exatamente como o worker vai montar: esta publicação > vídeo > conta > workspace.
  const finalText = useMemo(() => {
    if (!video) return "";
    const tags = extraHashtags(caption, normalizeHashtags(extra));
    const r = resolveContent({
      media: { caption: caption.trim() || video.caption, hashtags: tags.length ? tags : video.hashtags },
      account: { caption: account?.defaultCaption ?? null, hashtags: account?.defaultHashtags ?? null },
      global: { caption: props.workspaceDefaults.caption, hashtags: props.workspaceDefaults.hashtags },
    });
    return composeCaption({ caption: r.caption.value, hashtags: r.hashtags.value }).text;
  }, [video, caption, extra, account, props.workspaceDefaults]);

  const whenLabel = useMemo(() => {
    if (!date || !time) return "";
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y} às ${time}`;
  }, [date, time]);

  const ready = Boolean(video && account && date && time);
  const submit = () =>
    start(async () => {
      setResult(await quickScheduleAction({ slug: props.slug, mediaId, accountId, date, time, caption, hashtags: extra }));
      router.refresh();
    });

  if (result?.ok) {
    return (
      <section className={step} aria-live="polite">
        <h2 className={stepTitle}>
          <CalendarCheck className="size-5 text-success" aria-hidden /> Agendado
        </h2>
        <p className="text-sm">
          <strong>{video?.name}</strong> será publicado em <strong>{account?.name}</strong> no dia <strong>{whenLabel}</strong> ({props.timezone.replaceAll("_", " ")}).
          {result.note === "already_scheduled" && " Essa publicação já estava agendada — nada foi duplicado."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/w/${props.slug}/calendar`}>Ver no Calendário</Link>
          </Button>
          <Button variant="outline" onClick={() => (setResult(null), setMediaId(""))}>
            Agendar outro vídeo
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className="grid gap-4">
      {/* 1. Vídeo */}
      <section className={step} aria-labelledby="qp-1">
        <h2 id="qp-1" className={stepTitle}>
          <span className={num}>1</span> Vídeo
        </h2>
        <Input type="search" placeholder="Buscar na Biblioteca…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar vídeo na Biblioteca" />
        <div role="radiogroup" aria-label="Vídeos da Biblioteca" className="grid max-h-72 gap-1 overflow-y-auto rounded-md border p-1">
          {shown.length === 0 && <p className="p-3 text-sm text-muted-foreground">Nenhum vídeo pronto encontrado.</p>}
          {shown.map((v) => (
            <label key={v.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent has-[:checked]:bg-primary/10">
              <input type="radio" name="media" value={v.id} checked={mediaId === v.id} onChange={() => pickVideo(v.id)} className="accent-[var(--primary)]" />
              <span className="flex-1 truncate">{v.name}</span>
              {v.fromCard && <Badge variant="outline">Card Editorial</Badge>}
              {v.durationMs ? <span className="tabular-nums text-xs text-muted-foreground">{Math.round(v.durationMs / 1000)} s</span> : null}
            </label>
          ))}
        </div>
        {props.truncated && <p className="text-xs text-muted-foreground">Mostrando os 1.000 vídeos prontos mais recentes. Para um vídeo mais antigo, use a Biblioteca.</p>}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Enviar um vídeo novo</summary>
          <div className="mt-3 grid gap-2">
            <Uploader workspaceId={props.workspaceId} slug={props.slug} maxBytes={props.maxBytes} embedded />
            <p className="text-xs text-muted-foreground">
              Depois do envio, o vídeo passa por uma análise rápida e aparece na lista acima.{" "}
              <button type="button" className="inline-flex items-center gap-1 underline" onClick={() => router.refresh()}>
                <RefreshCw className="size-3" /> Atualizar lista
              </button>
            </p>
          </div>
        </details>
      </section>

      {/* 2. Personalizar */}
      <section className={step} aria-labelledby="qp-2">
        <h2 id="qp-2" className={stepTitle}>
          <span className={num}>2</span> Personalizar
        </h2>
        {video && !video.fromCard && (
          <form action={createCardAction} className="flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="slug" value={props.slug} />
            <input type="hidden" name="media" value={video.id} />
            <Button type="submit" variant="outline" size="sm">
              <Newspaper /> Aplicar Card Editorial (opcional)
            </Button>
            <span className="text-xs text-muted-foreground">Abre o editor com este vídeo; ao terminar, “Agendar” volta para cá.</span>
          </form>
        )}
        <CaptionField
          key={mediaId}
          caption={caption}
          hashtags={normalizeHashtags(extra)}
          label="Legenda"
          onChange={(c, x) => (setCaption(c), setExtra(x))}
        />
      </section>

      {/* 3. Quando */}
      <section className={step} aria-labelledby="qp-3">
        <h2 id="qp-3" className={stepTitle}>
          <span className={num}>3</span> Quando
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="qp-account">Conta</Label>
            <NativeSelect id="qp-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.platform === "mock" ? " (simulada)" : ""}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qp-date">Data</Label>
            <Input id="qp-date" type="date" min={props.defaults.today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qp-time">Horário</Label>
            <Input id="qp-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Fuso: {props.timezone.replaceAll("_", " ")}. Pelo menos 10 minutos a partir de agora.</p>
      </section>

      {/* 4. Revisar e agendar */}
      <section className={step} aria-labelledby="qp-4">
        <h2 id="qp-4" className={stepTitle}>
          <span className={num}>4</span> Revisar e agendar
        </h2>
        {ready ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Vídeo</dt>
            <dd className="truncate">{video!.name}</dd>
            <dt className="text-muted-foreground">Conta</dt>
            <dd>{account!.name}</dd>
            <dt className="text-muted-foreground">Quando</dt>
            <dd>{whenLabel}</dd>
            <dt className="text-muted-foreground">Texto publicado</dt>
            <dd>
              <p className="whitespace-pre-wrap rounded-md bg-muted p-2" data-testid="final-text">
                {finalText || "— (sem legenda)"}
              </p>
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Escolha o vídeo, a conta, a data e o horário.</p>
        )}
        {result && !result.ok && (
          <Alert variant="destructive" role="alert">
            {result.message}
          </Alert>
        )}
        <Button type="button" className="justify-self-start" disabled={!ready || pending} onClick={submit}>
          {pending ? <Loader2 className="animate-spin" /> : <CalendarCheck />}
          {pending ? "Agendando…" : result && !result.ok && result.retry ? "Tentar de novo" : "Agendar"}
        </Button>
      </section>
    </div>
  );
}
