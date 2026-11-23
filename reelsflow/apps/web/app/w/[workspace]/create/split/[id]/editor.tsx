"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, Download, Loader2, Pause, Play, RotateCcw, Upload } from "lucide-react";
import {
  SPLIT_OUTPUT,
  SPLIT_RATIOS,
  clipLength,
  coverCrop,
  outputDuration,
  sourceTime,
  splitRects,
  swapSlots,
  validateSplit,
  type AudioMode,
  type ClipConfig,
  type DurationMode,
  type SplitConfig,
  type SplitSlot,
} from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CardRenderStatus } from "@/lib/database.types";
import { MAX_SPLIT_BYTES, uploadToLibrary } from "@/lib/split/library";
import { SplitRenderError, probeSplitSource, renderSplitVideo, type SplitSourceInfo } from "@/lib/split/render";
import { createClient } from "@/lib/supabase/client";
import { getPlaybackUrlAction } from "../../../library/actions";

export type LibraryVideo = { id: string; name: string; durationS: number | null; size: string | null; hasAudio: boolean | null; status: string };
type Source = { mediaId: string; name: string; blob: Blob; url: string; info: SplitSourceInfo };
type Props = {
  slug: string;
  workspaceId: string;
  canEdit: boolean;
  project: { id: string; title: string; config: SplitConfig; topMediaId: string | null; bottomMediaId: string | null; renderStatus: CardRenderStatus; renderError: string | null };
  library: LibraryVideo[];
  rendered: { id: string; status: string } | null;
};

const SLOTS: SplitSlot[] = ["top", "bottom"];
const NAME: Record<SplitSlot, string> = { top: "superior", bottom: "inferior" };
const PREVIEW_W = 360;
const SCALE = PREVIEW_W / SPLIT_OUTPUT.width;
const fmtS = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const num = (v: string, d: number) => (v.trim() === "" || !Number.isFinite(Number(v.replace(",", "."))) ? d : Number(v.replace(",", ".")));

async function sniffVideo(file: Blob): Promise<"video/mp4" | "video/quicktime" | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(4, "ftyp")) return at(8, "qt  ") ? "video/quicktime" : "video/mp4";
  if (at(4, "moov") || at(4, "wide") || at(4, "mdat") || at(4, "free")) return "video/quicktime";
  return null;
}

export function SplitEditor(props: Props) {
  const supabase = useMemo(() => createClient(), []);
  const [title, setTitle] = useState(props.project.title);
  const [cfg, setCfg] = useState<SplitConfig>(props.project.config);
  const [ids, setIds] = useState<Record<SplitSlot, string | null>>({ top: props.project.topMediaId, bottom: props.project.bottomMediaId });
  const [src, setSrc] = useState<Record<SplitSlot, Source | null>>({ top: null, bottom: null });
  const [loading, setLoading] = useState<Record<SplitSlot, string | null>>({ top: null, bottom: null });
  const [slotError, setSlotError] = useState<Record<SplitSlot, string | null>>({ top: null, bottom: null });
  const [library, setLibrary] = useState(props.library);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "error">("saved");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rights, setRights] = useState(false);
  const [render, setRender] = useState<{ phase: "idle" | "rendering" | "uploading" | "done" | "error"; progress: number; message?: string; url?: string; mediaId?: string; audioPath?: string }>({ phase: "idle", progress: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videos = { top: useRef<HTMLVideoElement>(null), bottom: useRef<HTMLVideoElement>(null) };
  const abortRef = useRef<AbortController | null>(null);
  // Último quadro bom de cada vídeo: durante uma busca (seek) a prévia mantém a imagem em vez de piscar.
  const lastFrame = useRef<Record<SplitSlot, HTMLCanvasElement | null>>({ top: null, bottom: null });
  const first = useRef(true);

  const durations = { top: src.top?.info.durationS ?? 0, bottom: src.bottom?.info.durationS ?? 0 };
  const ready = Boolean(src.top && src.bottom);
  const total = ready ? outputDuration(cfg, durations) : 0;
  const issues = validateSplit(cfg, { top: src.top?.info ?? null, bottom: src.bottom?.info ?? null });
  const blocking = issues.filter((i) => i.blocking);
  const edit = props.canEdit && render.phase !== "rendering" && render.phase !== "uploading";

  // ------------------------------------------------------------ carregar origem (Biblioteca ou envio)
  const loadFromLibrary = useCallback(
    async (slot: SplitSlot, mediaId: string | null) => {
      setSlotError((e) => ({ ...e, [slot]: null }));
      if (!mediaId) {
        setSrc((s) => ({ ...s, [slot]: null }));
        return;
      }
      setLoading((l) => ({ ...l, [slot]: "Carregando vídeo…" }));
      try {
        const url = await getPlaybackUrlAction(props.slug, mediaId);
        if (!url) throw new SplitRenderError("fetch", "Vídeo não encontrado na Biblioteca.");
        const res = await fetch(url);
        if (!res.ok) throw new SplitRenderError("fetch", "Não foi possível baixar o vídeo da Biblioteca.");
        const blob = await res.blob();
        const info = await probeSplitSource(blob);
        const name = library.find((m) => m.id === mediaId)?.name ?? "Vídeo";
        setSrc((s) => {
          if (s[slot]) URL.revokeObjectURL(s[slot]!.url);
          lastFrame.current[slot] = null;
          return { ...s, [slot]: { mediaId, name, blob, url: URL.createObjectURL(blob), info } };
        });
      } catch (e) {
        setSlotError((x) => ({ ...x, [slot]: e instanceof SplitRenderError ? e.message : "Falha ao carregar o vídeo." }));
        setSrc((s) => ({ ...s, [slot]: null }));
      } finally {
        setLoading((l) => ({ ...l, [slot]: null }));
      }
    },
    [library, props.slug],
  );

  useEffect(() => {
    void loadFromLibrary("top", props.project.topMediaId);
    void loadFromLibrary("bottom", props.project.bottomMediaId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadFor(slot: SplitSlot, file: File) {
    setSlotError((e) => ({ ...e, [slot]: null }));
    try {
      if (file.size > MAX_SPLIT_BYTES) throw new SplitRenderError("too_large", "Arquivo grande demais: o limite atual é 50 MB por vídeo.");
      const mime = await sniffVideo(file);
      if (!mime) throw new SplitRenderError("bad_type", "Formato não aceito. Use MP4 ou MOV.");
      setLoading((l) => ({ ...l, [slot]: "Verificando o vídeo…" }));
      const info = await probeSplitSource(file); // valida ANTES de enviar
      setLoading((l) => ({ ...l, [slot]: "Enviando para a Biblioteca…" }));
      const name = file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
      const { mediaId } = await uploadToLibrary(supabase, { workspaceId: props.workspaceId, blob: file, name, mime });
      setLibrary((l) => [{ id: mediaId, name, durationS: info.durationS, size: `${info.width}×${info.height}`, hasAudio: info.hasAudio, status: "uploaded" }, ...l]);
      setIds((x) => ({ ...x, [slot]: mediaId }));
      setSrc((s) => {
        if (s[slot]) URL.revokeObjectURL(s[slot]!.url);
        lastFrame.current[slot] = null;
        return { ...s, [slot]: { mediaId, name, blob: file, url: URL.createObjectURL(file), info } };
      });
    } catch (e) {
      setSlotError((x) => ({ ...x, [slot]: e instanceof SplitRenderError ? e.message : "Falha ao enviar o vídeo." }));
    } finally {
      setLoading((l) => ({ ...l, [slot]: null }));
    }
  }

  // ------------------------------------------------------------ salvamento automático (só configuração)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!props.canEdit) return;
    setSaveState("pending");
    const h = setTimeout(async () => {
      const { error } = await supabase
        .from("split_projects")
        .update({ title: title.trim() || "Tela dividida sem título", config: cfg, top_media_id: ids.top, bottom_media_id: ids.bottom })
        .eq("id", props.project.id);
      setSaveState(error ? "error" : "saved");
    }, 700);
    return () => clearTimeout(h);
  }, [cfg, ids, title, props.canEdit, props.project.id, supabase]);

  // ------------------------------------------------------------ prévia: mesmo layout/tempo do arquivo final
  const draw = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, SPLIT_OUTPUT.width, SPLIT_OUTPUT.height);
    const rects = splitRects(cfg.ratio);
    for (const s of SLOTS) {
      const v = videos[s].current;
      const r = rects[s];
      const live = v && src[s] && v.readyState >= 2 && !v.seeking && v.videoWidth;
      if (live) {
        let cache = lastFrame.current[s];
        if (!cache || cache.width !== v.videoWidth || cache.height !== v.videoHeight) {
          cache = document.createElement("canvas");
          cache.width = v.videoWidth;
          cache.height = v.videoHeight;
          lastFrame.current[s] = cache;
        }
        cache.getContext("2d")!.drawImage(v, 0, 0);
      }
      const frame = src[s] ? lastFrame.current[s] : null;
      if (frame) {
        const crop = coverCrop({ width: frame.width, height: frame.height }, r, cfg[s]);
        ctx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = s === "top" ? "#1c1c24" : "#15151c";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "#8b8b99";
        ctx.font = "600 44px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(loading[s] ?? `Vídeo ${NAME[s]}`, r.x + r.w / 2, r.y + r.h / 2);
      }
    }
    // linha de divisão (só na prévia, para orientar)
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(0, rects.bottom.y - 1, SPLIT_OUTPUT.width, 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, src, loading]);

  const seek = useCallback(
    (time: number) => {
      const tt = Math.max(0, Math.min(time, total));
      setT(tt);
      for (const s of SLOTS) {
        const v = videos[s].current;
        if (v && src[s]) v.currentTime = sourceTime(cfg, s, tt, src[s]!.info.durationS);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, src, total],
  );

  // reposiciona quando muda trecho/fonte; redesenha a cada quadro buscado
  useEffect(() => {
    if (!playing) seek(Math.min(t, total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.top.startS, cfg.bottom.startS, cfg.top.endS, cfg.bottom.endS, cfg.duration, cfg.main, src.top, src.bottom]);
  useEffect(() => {
    const vs = SLOTS.map((s) => videos[s].current).filter(Boolean) as HTMLVideoElement[];
    vs.forEach((v) => v.addEventListener("seeked", draw));
    vs.forEach((v) => v.addEventListener("loadeddata", draw));
    draw();
    return () => vs.forEach((v) => (v.removeEventListener("seeked", draw), v.removeEventListener("loadeddata", draw)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  // áudio da prévia conforme a escolha
  useEffect(() => {
    for (const s of SLOTS) {
      const v = videos[s].current;
      if (!v) continue;
      const on = cfg.audio.mode === s || cfg.audio.mode === "mix";
      v.muted = !on;
      v.volume = Math.min(1, s === "top" ? cfg.audio.topVolume : cfg.audio.bottomVolume);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.audio, src]);

  // reprodução: o vídeo principal dá o relógio; o outro é ressincronizado se desviar
  useEffect(() => {
    if (!playing || !ready) return;
    const main = cfg.main;
    const sec: SplitSlot = main === "top" ? "bottom" : "top";
    const mv = videos[main].current!;
    const sv = videos[sec].current!;
    void mv.play().catch(() => setPlaying(false));
    void sv.play().catch(() => undefined);
    let raf = 0;
    const tick = () => {
      const tt = Math.max(0, mv.currentTime - cfg[main].startS);
      if (tt >= total - 0.04 || mv.ended) {
        mv.pause();
        sv.pause();
        setPlaying(false);
        setT(total);
        draw();
        return;
      }
      const target = sourceTime(cfg, sec, tt, durations[sec]);
      const frozen = cfg.duration === "main" && tt >= clipLength(cfg[sec], durations[sec]);
      if (frozen) sv.pause();
      else {
        if (sv.paused) void sv.play().catch(() => undefined);
        if (Math.abs(sv.currentTime - target) > 0.25) sv.currentTime = target;
      }
      setT(tt);
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      mv.pause();
      sv.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const togglePlay = () => {
    if (!ready) return;
    if (!playing && t >= total - 0.05) seek(0);
    setPlaying((p) => !p);
  };

  // ------------------------------------------------------------ edição
  const setClip = (s: SplitSlot, patch: Partial<ClipConfig>) => setCfg((c) => ({ ...c, [s]: { ...c[s], ...patch } }));
  const swap = () => {
    setPlaying(false);
    setCfg((c) => swapSlots(c));
    setIds((x) => ({ top: x.bottom, bottom: x.top }));
    setSrc((x) => ({ top: x.bottom, bottom: x.top }));
    lastFrame.current = { top: lastFrame.current.bottom, bottom: lastFrame.current.top };
    setSlotError((x) => ({ top: x.bottom, bottom: x.top }));
  };
  const currentSourceTime = (s: SplitSlot) => (src[s] ? sourceTime(cfg, s, t, src[s]!.info.durationS) : 0);

  // ------------------------------------------------------------ gerar vídeo final
  async function generate() {
    if (!src.top || !src.bottom || blocking.length || !rights) return;
    setPlaying(false);
    const ac = new AbortController();
    abortRef.current = ac;
    setRender({ phase: "rendering", progress: 0 });
    await supabase.rpc("set_split_render_state", { p_project: props.project.id, p_state: "rendering" });
    try {
      const r = await renderSplitVideo(cfg, { top: src.top.blob, bottom: src.bottom.blob }, { signal: ac.signal, onProgress: (p) => setRender((x) => ({ ...x, progress: p })) });
      const url = URL.createObjectURL(r.blob);
      setRender({ phase: "uploading", progress: 1, url, audioPath: r.audioPath });
      const { mediaId } = await uploadToLibrary(supabase, { workspaceId: props.workspaceId, blob: r.blob, name: title || "Tela dividida", thumbnail: r.thumbnail });
      const { error } = await supabase.rpc("attach_split_render", { p_project: props.project.id, p_media: mediaId });
      if (error) throw new SplitRenderError("attach", "O vídeo foi para a Biblioteca, mas não foi possível ligá-lo ao projeto.");
      setRender({ phase: "done", progress: 1, url, mediaId, audioPath: r.audioPath });
    } catch (e) {
      const message = e instanceof SplitRenderError ? e.message : "Falha inesperada ao gerar o vídeo.";
      await supabase.rpc("set_split_render_state", { p_project: props.project.id, p_state: e instanceof SplitRenderError && e.code === "canceled" ? "draft" : "error", p_error: message });
      setRender((x) => ({ ...x, phase: "error", message }));
    } finally {
      abortRef.current = null;
    }
  }

  // ------------------------------------------------------------ UI
  const radio = "relative cursor-pointer rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";
  const pct = Math.round(render.progress * 100);

  return (
    <div className="grid gap-4 md:h-full md:min-h-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:gap-6 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* Prévia fixa */}
      <section aria-label="Prévia" className="grid content-start justify-items-center gap-3 md:min-h-0 md:overflow-y-auto">
        <canvas
          ref={canvasRef}
          width={PREVIEW_W}
          height={Math.round(SPLIT_OUTPUT.height * SCALE)}
          className="h-auto max-h-[62dvh] w-auto max-w-full rounded-xl border bg-black md:max-h-[calc(100dvh-16rem)]"
          role="img"
          aria-label="Prévia da tela dividida (9:16)"
        />
        {SLOTS.map((s) => (
          <video key={s} ref={videos[s]} src={src[s]?.url} playsInline preload="auto" className="pointer-events-none fixed left-0 top-0 size-px opacity-0" aria-hidden tabIndex={-1} />
        ))}
        <div className="grid w-full max-w-[360px] gap-1">
          <div className="flex items-center gap-2">
            <Button type="button" size="icon" variant="secondary" onClick={togglePlay} disabled={!ready} aria-label={playing ? "Pausar" : "Reproduzir"}>
              {playing ? <Pause /> : <Play />}
            </Button>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, total)}
              step={0.05}
              value={Math.min(t, total)}
              onChange={(e) => (setPlaying(false), seek(Number(e.target.value)))}
              disabled={!ready}
              aria-label="Posição na linha do tempo"
              className="min-w-0 flex-1 accent-[var(--color-primary)]"
            />
            <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
              {fmtS(t)} / {fmtS(total)}
            </span>
          </div>
          {ready && (
            <div className="grid gap-1 text-[11px] text-muted-foreground" aria-label="Trechos usados">
              {SLOTS.map((s) => {
                const len = clipLength(cfg[s], durations[s]);
                const shown = Math.min(1, len / Math.max(0.1, total));
                return (
                  <div key={s} className="flex items-center gap-2">
                    <span className="w-14 capitalize">{NAME[s]}</span>
                    <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-muted">
                      <span className={`absolute inset-y-0 left-0 rounded ${s === cfg.main ? "bg-primary" : "bg-primary/50"}`} style={{ width: `${(cfg.duration === "loop_other" && s !== cfg.main ? 1 : shown) * 100}%` }} />
                    </span>
                    <span className="w-28 text-right tabular-nums">
                      {fmtS(cfg[s].startS)}–{fmtS(cfg[s].startS + len)}
                      {s === cfg.main ? " · principal" : cfg.duration === "loop_other" ? " · repete" : len < total ? " · congela" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Ferramentas (rolagem independente) */}
      <div className="scrollbar-rf grid content-start gap-4 md:min-h-0 md:overflow-y-auto md:overscroll-contain md:pr-3">
        {!props.canEdit && <Alert>Você tem acesso de leitura: pode ver, mas não editar.</Alert>}
        <section className="grid gap-2 rounded-xl border p-4">
          <Label htmlFor="split-title">Nome do projeto</Label>
          <Input id="split-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={!edit} />
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {saveState === "pending" ? "Salvando…" : saveState === "error" ? "Não foi possível salvar. Verifique a conexão." : "Alterações salvas."}
          </p>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">Vídeos</h2>
            <Button type="button" size="sm" variant="outline" onClick={swap} disabled={!edit}>
              <ArrowUpDown /> Trocar posição
            </Button>
          </div>
          {SLOTS.map((s) => (
            <div key={s} className="grid gap-1.5">
              <Label htmlFor={`src-${s}`}>Vídeo {NAME[s]}</Label>
              <div className="flex flex-wrap gap-2">
                <NativeSelect
                  id={`src-${s}`}
                  className="min-w-0 flex-1"
                  value={ids[s] ?? ""}
                  disabled={!edit || Boolean(loading[s])}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setIds((x) => ({ ...x, [s]: v }));
                    void loadFromLibrary(s, v);
                  }}
                >
                  <option value="">Escolher da Biblioteca…</option>
                  {library.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.durationS ? ` · ${fmtS(m.durationS)}` : ""}
                      {m.size ? ` · ${m.size}` : ""}
                    </option>
                  ))}
                </NativeSelect>
                <label className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent ${!edit ? "pointer-events-none opacity-60" : ""}`}>
                  <Upload className="size-4" aria-hidden /> Enviar
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime"
                    className="sr-only"
                    aria-label={`Enviar vídeo ${NAME[s]}`}
                    disabled={!edit}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void uploadFor(s, f);
                    }}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {loading[s] ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" aria-hidden /> {loading[s]}
                  </span>
                ) : src[s] ? (
                  `${fmtS(src[s]!.info.durationS)} · ${src[s]!.info.width}×${src[s]!.info.height} · ${src[s]!.info.hasAudio ? `áudio ${src[s]!.info.audioCodec ?? ""}` : "sem áudio"}`
                ) : (
                  "MP4 ou MOV até 50 MB. Use só vídeos seus ou que você tem autorização para usar."
                )}
              </p>
              {slotError[s] && <p className="text-xs text-destructive" role="alert">{slotError[s]}</p>}
            </div>
          ))}
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Divisão</h2>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Proporção da divisão">
            {SPLIT_RATIOS.map((r) => (
              <label key={r} className={radio}>
                <input type="radio" name="ratio" className="sr-only" checked={cfg.ratio === r} onChange={() => setCfg((c) => ({ ...c, ratio: r }))} disabled={!edit} />
                {r} <span className="text-xs text-muted-foreground">({splitRects(r).top.h}/{splitRects(r).bottom.h} px)</span>
              </label>
            ))}
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border p-4">
          <h2 className="font-medium">Enquadramento</h2>
          {SLOTS.map((s) => (
            <fieldset key={s} className="grid gap-2" disabled={!edit || !src[s]}>
              <div className="flex items-center justify-between">
                <legend className="text-sm font-medium capitalize">{NAME[s]}</legend>
                <Button type="button" size="sm" variant="ghost" onClick={() => setClip(s, { zoom: 1, offsetX: 0, offsetY: 0 })}>
                  <RotateCcw /> Centralizar
                </Button>
              </div>
              {(
                [
                  ["zoom", "Zoom", 1, 3, 0.05, (v: number) => `${Math.round(v * 100)}%`],
                  ["offsetX", "Horizontal", -1, 1, 0.02, (v: number) => (v === 0 ? "centro" : v < 0 ? "esquerda" : "direita")],
                  ["offsetY", "Vertical", -1, 1, 0.02, (v: number) => (v === 0 ? "centro" : v < 0 ? "acima" : "abaixo")],
                ] as const
              ).map(([k, label, min, max, step, show]) => (
                <label key={k} className="grid grid-cols-[6rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <input type="range" min={min} max={max} step={step} value={cfg[s][k]} onChange={(e) => setClip(s, { [k]: Number(e.target.value) })} className="accent-[var(--color-primary)]" />
                  <span className="text-right text-xs tabular-nums text-muted-foreground">{show(cfg[s][k])}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </section>

        <section className="grid gap-4 rounded-xl border p-4">
          <h2 className="font-medium">Trechos e duração</h2>
          {SLOTS.map((s) => (
            <fieldset key={s} className="grid gap-2" disabled={!edit || !src[s]}>
              <legend className="text-sm font-medium capitalize">{NAME[s]}</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Início (s)
                  <Input inputMode="decimal" value={String(cfg[s].startS)} onChange={(e) => setClip(s, { startS: Math.max(0, num(e.target.value, 0)) })} />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Fim (s) — vazio = até o final
                  <Input inputMode="decimal" value={cfg[s].endS === null ? "" : String(cfg[s].endS)} onChange={(e) => setClip(s, { endS: e.target.value.trim() === "" ? null : num(e.target.value, 0) })} />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setClip(s, { startS: Math.round(currentSourceTime(s) * 10) / 10 })}>
                  Início = posição atual
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setClip(s, { endS: Math.round(currentSourceTime(s) * 10) / 10 })}>
                  Fim = posição atual
                </Button>
              </div>
            </fieldset>
          ))}
          <fieldset className="grid gap-2" disabled={!edit}>
            <legend className="text-sm font-medium">Vídeo principal (define a duração)</legend>
            <div className="flex flex-wrap gap-2">
              {SLOTS.map((s) => (
                <label key={s} className={radio}>
                  <input type="radio" name="main" className="sr-only" checked={cfg.main === s} onChange={() => setCfg((c) => ({ ...c, main: s }))} />
                  <span className="capitalize">{NAME[s]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-2" disabled={!edit}>
            <legend className="text-sm font-medium">Quando o outro vídeo for mais curto</legend>
            {(
              [
                ["main", "Encerrar com o principal (o outro para no último quadro)"],
                ["loop_other", "Repetir o outro vídeo até o principal acabar"],
                ["shortest", "Encerrar quando o mais curto acabar"],
              ] as [DurationMode, string][]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="radio" name="duration" checked={cfg.duration === k} onChange={() => setCfg((c) => ({ ...c, duration: k }))} />
                {label}
              </label>
            ))}
            {ready && <p className="text-xs text-muted-foreground">Duração final: {fmtS(total)}</p>}
          </fieldset>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Áudio</h2>
          <fieldset className="grid gap-2" disabled={!edit}>
            <legend className="sr-only">Origem do áudio</legend>
            {(
              [
                ["top", "Só o áudio do vídeo superior"],
                ["bottom", "Só o áudio do vídeo inferior"],
                ["mix", "Misturar os dois"],
                ["mute", "Silenciar ambos"],
              ] as [AudioMode, string][]
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="radio" name="audio" checked={cfg.audio.mode === k} onChange={() => setCfg((c) => ({ ...c, audio: { ...c.audio, mode: k } }))} />
                {label}
              </label>
            ))}
          </fieldset>
          {cfg.audio.mode !== "mute" &&
            SLOTS.filter((s) => cfg.audio.mode === "mix" || cfg.audio.mode === s).map((s) => {
              const key = s === "top" ? "topVolume" : "bottomVolume";
              return (
                <label key={s} className="grid grid-cols-[6rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-sm">
                  <span className="capitalize text-muted-foreground">Volume {NAME[s]}</span>
                  <input type="range" min={0} max={2} step={0.05} value={cfg.audio[key]} disabled={!edit} onChange={(e) => setCfg((c) => ({ ...c, audio: { ...c.audio, [key]: Number(e.target.value) } }))} className="accent-[var(--color-primary)]" />
                  <span className="text-right text-xs tabular-nums text-muted-foreground">{Math.round(cfg.audio[key] * 100)}%</span>
                </label>
              );
            })}
          <p className="text-xs text-muted-foreground">
            Um só áudio em 100% é copiado sem perda. Mistura ou volume diferente de 100% recodifica o áudio (AAC). Volumes acima de 100% só se aplicam no arquivo final. Música de fundo: em breve.
          </p>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Gerar vídeo final</h2>
          {issues.length > 0 && (
            <ul className="grid gap-1 text-sm" aria-label="Pendências">
              {issues.map((i) => (
                <li key={i.code} className={i.blocking ? "text-destructive" : "text-warning"}>
                  {i.blocking ? "• " : "Aviso: "}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} disabled={!edit} />
            Confirmo que os dois vídeos são meus ou que tenho autorização para usá-los e publicá-los.
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={generate} disabled={!edit || !ready || blocking.length > 0 || !rights}>
              {render.phase === "rendering" || render.phase === "uploading" ? <Loader2 className="animate-spin" /> : null} Gerar vídeo final
            </Button>
            {render.phase === "rendering" && (
              <Button type="button" variant="ghost" onClick={() => abortRef.current?.abort()}>
                Cancelar
              </Button>
            )}
          </div>
          {(render.phase === "rendering" || render.phase === "uploading") && (
            <div className="grid gap-1" aria-live="polite">
              <div className="h-2 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progresso da renderização">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {render.phase === "rendering" ? `Renderizando no seu navegador… ${pct}%. Mantenha esta aba aberta.` : "Enviando para a Biblioteca…"}
              </p>
            </div>
          )}
          {render.phase === "error" && <Alert variant="destructive">{render.message}</Alert>}
          {render.phase === "done" && (
            <Alert variant="success">
              Vídeo gerado e salvo na Biblioteca como uma mídia nova (os vídeos de origem não foram alterados). Ele fica pronto para agendar depois da verificação automática.{" "}
              <Link href={`/w/${props.slug}/library`} className="underline">
                Abrir Biblioteca
              </Link>
            </Alert>
          )}
          {render.url && (
            <div className="grid justify-items-start gap-2">
              <video src={render.url} controls playsInline className="max-h-80 rounded-lg border bg-black" aria-label="Vídeo final gerado" />
              <Button asChild size="sm" variant="outline">
                <a href={render.url} download={`${(title || "tela-dividida").replace(/[\\/:*?"<>|]+/g, " ").trim()}.mp4`}>
                  <Download /> Baixar MP4
                </a>
              </Button>
            </div>
          )}
          {render.phase === "idle" && props.rendered && (
            <p className="text-xs text-muted-foreground">
              Último vídeo gerado: {props.rendered.status === "ready" ? "pronto na Biblioteca" : props.rendered.status === "failed" ? "recusado na verificação" : "em verificação"}.
              {props.project.renderStatus === "draft" ? " A configuração mudou desde então; gere de novo para atualizar." : ""}
            </p>
          )}
          {props.project.renderError && render.phase === "idle" && props.project.renderStatus === "error" && <p className="text-xs text-destructive">Última tentativa: {props.project.renderError}</p>}
        </section>
      </div>
    </div>
  );
}
