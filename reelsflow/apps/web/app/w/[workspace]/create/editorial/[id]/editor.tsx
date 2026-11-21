"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, ImageIcon, Loader2, Pause, Play, Save, Sparkles, Trash2, Volume2, VolumeX } from "lucide-react";
import {
  CARD_FORMATS,
  CARD_FORMAT_KEYS,
  DEFAULT_CARD_STYLE,
  HEADLINE_MAX_CHARS,
  cardPublishRestrictions,
  headlineLength,
  normalizeUsername,
  type CardContent,
  type CardFit,
  type CardFormat,
  type CardLayout,
  type CardMediaKind,
  type CardStyle,
  type FocalPoint,
} from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import type { CardRenderStatus, EditorialCardRow } from "@/lib/database.types";
import type { Drawable } from "@/lib/editorial/draw";
import { CardRenderError, renderCardImage, renderCardVideo, type CardRenderInput } from "@/lib/editorial/export";
import { ensureCardFonts } from "@/lib/editorial/fonts";
import { renderPreview } from "@/lib/editorial/preview";
import { uploadFinalRender, waitForRenderVerdict } from "@/lib/editorial/publish-render";
import { fetchSource, sourceAccept, sourceHint, uploadSource, validateSource, type LoadedSource, type SourceKind } from "@/lib/editorial/sources";
import { deleteCardAction, duplicateCardAction } from "../../actions";

type Account = { id: string; display_name: string; username: string | null; platform: string; provider: "native" | "zernio" };
type Slot = { src: LoadedSource | null; path: string | null; dirty: boolean };
type Style = CardStyle & { watermark: CardStyle["watermark"] & { logoPath?: string | null } };

const STATUS: Record<CardRenderStatus, { label: string; variant: "secondary" | "warning" | "success" | "outline" }> = {
  draft: { label: "Rascunho", variant: "secondary" },
  rendering: { label: "Renderizando", variant: "warning" },
  processing: { label: "Verificando o arquivo final", variant: "warning" },
  ready: { label: "Pronto para agendar", variant: "success" },
  error: { label: "Erro de render", variant: "outline" },
};
const KIND_LABEL: Record<CardMediaKind, string> = { image: "Foto", image_pair: "Duas imagens lado a lado", video: "Vídeo" };
const emptySlot = (): Slot => ({ src: null, path: null, dirty: false });

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function EditorialEditor(props: {
  slug: string;
  workspaceId: string;
  canEdit: boolean;
  card: EditorialCardRow;
  sourceUrls: { avatar: string | null; media: (string | null)[]; logo: string | null };
  accounts: Account[];
  renderedUrl: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const c = props.card;
  const [title, setTitle] = useState(c.title);
  const [pageName, setPageName] = useState(c.page_name);
  const [username, setUsername] = useState(c.username);
  const [headline, setHeadline] = useState(c.headline);
  const [caption, setCaption] = useState(c.caption ?? "");
  const [format, setFormat] = useState<CardFormat>(c.format);
  const [mediaKind, setMediaKind] = useState<CardMediaKind>(c.media_kind);
  const [fit, setFit] = useState<CardFit>(c.fit);
  const [focal, setFocal] = useState<FocalPoint[]>(() => {
    const f = Array.isArray(c.focal) ? (c.focal as FocalPoint[]) : [];
    return [f[0] ?? { x: 0.5, y: 0.5 }, f[1] ?? { x: 0.5, y: 0.5 }];
  });
  const [style, setStyle] = useState<Style>(() => {
    const s = (c.style ?? {}) as Partial<Style>;
    return { ...DEFAULT_CARD_STYLE, ...s, watermark: { ...DEFAULT_CARD_STYLE.watermark, ...(s.watermark ?? {}) } } as Style;
  });
  const [accountId, setAccountId] = useState<string>(c.social_account_id ?? "");
  const [avatar, setAvatar] = useState<Slot>(emptySlot);
  const [media, setMedia] = useState<[Slot, Slot]>([emptySlot(), emptySlot()]);
  const [logo, setLogo] = useState<Slot>(emptySlot);
  const [status, setStatus] = useState<CardRenderStatus>(c.render_status);
  const [renderError, setRenderError] = useState<string | null>(c.render_error);
  const [renderedMediaId, setRenderedMediaId] = useState<string | null>(c.rendered_media_id);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [layout, setLayout] = useState<CardLayout | null>(null);
  const [showSafe, setShowSafe] = useState(format === "vertical");
  const [lastRender, setLastRender] = useState<{ blob: Blob; name: string } | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState({ t: 0, d: 0 });
  const touch = () => setDirty(true);

  // Carrega as origens já salvas (URLs assinadas de curta duração → Blob, sem contaminar o canvas).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureCardFonts();
        const load = async (kind: SourceKind, url: string | null, path: string | null): Promise<Slot> =>
          url ? { src: await fetchSource(kind, url).catch(() => null), path, dirty: false } : emptySlot();
        const [a, m0, m1, l] = await Promise.all([
          load("avatar", props.sourceUrls.avatar, c.avatar_path),
          load(c.media_kind === "video" ? "video" : "image", props.sourceUrls.media[0] ?? null, c.media_paths[0] ?? null),
          load("image", props.sourceUrls.media[1] ?? null, c.media_paths[1] ?? null),
          load("logo", props.sourceUrls.logo, ((c.style ?? {}) as Style).watermark?.logoPath ?? null),
        ]);
        if (!alive) return;
        setAvatar(a);
        setMedia([m0, m1]);
        setLogo(l);
      } finally {
        if (alive) setLoadingSources(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vídeo de origem → elemento <video> (prévia com controles; o arquivo final usa o vídeo inteiro).
  const videoBlob = mediaKind === "video" && media[0].src?.kind === "video" ? media[0].src.blob : null;
  const videoUrl = useMemo(() => (videoBlob ? URL.createObjectURL(videoBlob) : null), [videoBlob]);
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl]);

  const content: CardContent = useMemo(
    () => ({ format, pageName, username: normalizeUsername(username), headline, mediaKind, fit }),
    [format, pageName, username, headline, mediaKind, fit],
  );

  const renderInput = useCallback(
    (videoFrame?: Drawable | null): CardRenderInput => ({
      content,
      style,
      focal,
      avatar: avatar.src?.drawable ?? null,
      media: mediaKind === "video" ? [videoFrame ?? null] : mediaKind === "image_pair" ? [media[0].src?.drawable ?? null, media[1].src?.drawable ?? null] : [media[0].src?.drawable ?? null],
      logo: logo.src?.drawable ?? null,
    }),
    [content, style, focal, avatar, media, logo, mediaKind],
  );

  const videoDrawable = useCallback((): Drawable | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || v.readyState < 2) return null;
    return { width: v.videoWidth, height: v.videoHeight, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh) };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setLayout(renderPreview(canvas, renderInput(mediaKind === "video" ? videoDrawable() : null), { showSafeArea: showSafe }));
  }, [renderInput, mediaKind, videoDrawable, showSafe]);

  useEffect(() => {
    let raf = 0;
    ensureCardFonts().then(() => (raf = requestAnimationFrame(draw)));
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Enquanto o vídeo toca, redesenha a cada quadro.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const loop = () => {
      draw();
      setTime({ t: v.currentTime, d: v.duration || 0 });
      if (!v.paused && !v.ended) raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      setPlaying(true);
      raf = requestAnimationFrame(loop);
    };
    const onStop = () => {
      setPlaying(false);
      draw();
    };
    const onSeek = () => {
      draw();
      setTime({ t: v.currentTime, d: v.duration || 0 });
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onStop);
    v.addEventListener("ended", onStop);
    v.addEventListener("seeked", onSeek);
    v.addEventListener("loadeddata", onSeek);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onStop);
      v.removeEventListener("ended", onStop);
      v.removeEventListener("seeked", onSeek);
      v.removeEventListener("loadeddata", onSeek);
    };
  }, [draw, videoUrl]);

  const pick = async (kind: SourceKind, file: File | undefined, set: (s: Slot) => void) => {
    if (!file) return;
    setNotice(null);
    try {
      set({ src: await validateSource(kind, file), path: null, dirty: true });
      touch();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof CardRenderError ? e.message : "Não foi possível ler o arquivo." });
    }
  };

  const blocking = layout?.blocking ?? [];
  const warnings = layout?.warnings ?? [];
  const restrictions = cardPublishRestrictions(format, mediaKind);
  const needMedia = mediaKind === "image_pair" ? [media[0], media[1]] : [media[0]];
  const mediaMissing = needMedia.some((s) => !s.src) || (mediaKind === "video" ? media[0].src?.kind !== "video" : needMedia.some((s) => s.src?.kind !== "image"));
  const exportBlockers = [...blocking.map((b) => b.message), ...(mediaMissing ? [mediaKind === "image_pair" ? "Envie as duas imagens." : mediaKind === "video" ? "Envie o vídeo." : "Envie a foto."] : [])];
  const hlCount = headlineLength(headline);

  /** Salva o rascunho: envia origens novas e grava os campos. */
  const save = async (): Promise<boolean> => {
    setBusy("Salvando rascunho…");
    setNotice(null);
    try {
      const up = async (slot: Slot, set: (s: Slot) => void): Promise<string | null> => {
        if (!slot.src) return null;
        if (!slot.dirty && slot.path) return slot.path;
        const path = await uploadSource(supabase, props.workspaceId, c.id, slot.src);
        set({ ...slot, path, dirty: false });
        return path;
      };
      const avatarPath = await up(avatar, setAvatar);
      const m0 = await up(media[0], (s) => setMedia((m) => [s, m[1]]));
      const m1 = mediaKind === "image_pair" ? await up(media[1], (s) => setMedia((m) => [m[0], s])) : null;
      const logoPath = style.watermark.kind === "logo" ? await up(logo, setLogo) : null;
      const nextStyle: Style = { ...style, showSafeArea: undefined, watermark: { ...style.watermark, logoPath } };
      const { error } = await supabase
        .from("editorial_cards")
        .update({
          title: title.trim() || "Card sem título",
          page_name: pageName.trim(),
          username: normalizeUsername(username),
          headline,
          caption: caption.trim() || null,
          format,
          media_kind: mediaKind,
          fit,
          style: nextStyle,
          focal,
          avatar_path: avatarPath,
          media_paths: [m0, m1].filter((p): p is string => Boolean(p)),
          media_meta: { width: media[0].src?.width ?? null, height: media[0].src?.height ?? null, durationS: media[0].src?.durationS ?? null },
          social_account_id: accountId || null,
        })
        .eq("id", c.id);
      if (error) throw new CardRenderError("save", error.message.includes("check") ? "Algum campo está fora do permitido (ex.: @ com caracteres inválidos)." : "Não foi possível salvar o rascunho.");
      const { data: fresh } = await supabase.from("editorial_cards").select("render_status").eq("id", c.id).maybeSingle();
      if (fresh) setStatus((fresh as { render_status: CardRenderStatus }).render_status);
      setDirty(false);
      setNotice({ ok: true, text: "Rascunho salvo." });
      return true;
    } catch (e) {
      setNotice({ ok: false, text: e instanceof CardRenderError ? e.message : "Não foi possível salvar o rascunho." });
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** Renderiza o ARQUIVO FINAL, envia pelo pipeline de mídia e aguarda a verificação do servidor. */
  const render = async () => {
    if (exportBlockers.length) return;
    if (!(await save())) return;
    const abort = new AbortController();
    setRenderError(null);
    setProgress(0);
    try {
      await supabase.rpc("set_card_render_state", { p_card: c.id, p_state: "rendering" });
      setStatus("rendering");
      setBusy("Renderizando o arquivo final…");
      let final: { blob: Blob; mime: "image/jpeg" | "video/mp4"; thumbnail?: Blob | null };
      if (mediaKind === "video") {
        const v = videoRef.current;
        v?.pause();
        const r = await renderCardVideo(renderInput(null), media[0].src!.blob, { onProgress: (p) => setProgress(Math.round(p * 100)), signal: abort.signal });
        const frame = videoDrawable();
        final = { blob: r.blob, mime: "video/mp4", thumbnail: frame ? await renderCardImage(renderInput(frame), "image/jpeg").catch(() => null) : null };
      } else {
        final = { blob: await renderCardImage(renderInput(), "image/jpeg"), mime: "image/jpeg" };
      }
      setProgress(null);
      setLastRender({ blob: final.blob, name: `${title || "card"}.${final.mime === "video/mp4" ? "mp4" : "jpg"}` });
      const res = await uploadFinalRender(supabase, {
        workspaceId: props.workspaceId,
        cardId: c.id,
        title,
        render: final,
        onStep: (s) => setBusy(s === "hashing" ? "Verificando integridade…" : s === "uploading" ? "Enviando o arquivo final…" : "Concluindo envio…"),
      });
      setRenderedMediaId(res.mediaId);
      setStatus("processing");
      setBusy("O servidor está verificando o arquivo final…");
      const verdict = await waitForRenderVerdict(supabase, c.id);
      setStatus(verdict.status as CardRenderStatus);
      if (verdict.status === "ready") setNotice({ ok: true, text: "Arquivo final pronto. Ele já está na Biblioteca e pode ser agendado." });
      else if (verdict.status === "error") setRenderError(verdict.error ?? "O servidor recusou o arquivo final.");
      else setNotice({ ok: true, text: "O arquivo foi enviado e continua em verificação. Atualize a página em instantes." });
    } catch (e) {
      const msg = e instanceof CardRenderError ? e.message : "Falha inesperada na renderização.";
      setRenderError(msg);
      setStatus("error");
      await supabase.rpc("set_card_render_state", { p_card: c.id, p_state: "error", p_error: msg });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const downloadFinal = async () => {
    if (lastRender) return download(lastRender.blob, lastRender.name);
    if (props.renderedUrl) {
      const res = await fetch(props.renderedUrl);
      if (res.ok) download(await res.blob(), `${title || "card"}${mediaKind === "video" ? ".mp4" : ".jpg"}`);
    }
  };
  const downloadPng = async () => {
    try {
      download(await renderCardImage(renderInput(mediaKind === "video" ? videoDrawable() : null), "image/png"), `${title || "card"}.png`);
    } catch (e) {
      setNotice({ ok: false, text: e instanceof CardRenderError ? e.message : "Não foi possível gerar o PNG." });
    }
  };

  const prefill = (id: string) => {
    setAccountId(id);
    const a = props.accounts.find((x) => x.id === id);
    if (!a) return;
    setPageName(a.display_name.replace(/^@/, ""));
    if (a.username) setUsername(a.username);
    touch();
  };

  const ready = status === "ready" && !dirty && renderedMediaId;
  const dims = CARD_FORMATS[format];
  const disabled = !props.canEdit || Boolean(busy);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(340px,440px)_1fr]">
      {/* Controles */}
      <form className="order-2 grid content-start gap-5 lg:order-1" onSubmit={(e) => e.preventDefault()} aria-label="Configuração do card">
        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Card</h2>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-title">Título interno</Label>
            <Input id="ec-title" value={title} maxLength={120} onChange={(e) => (setTitle(e.target.value), touch())} disabled={!props.canEdit} />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Formato</legend>
            <div className="grid grid-cols-3 gap-2">
              {CARD_FORMAT_KEYS.map((f) => (
                <label key={f} className="flex cursor-pointer flex-col items-center gap-1 rounded-md border px-2 py-2 text-center text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                  <input type="radio" name="format" className="sr-only" checked={format === f} onChange={() => (setFormat(f), setShowSafe(f === "vertical"), touch())} disabled={!props.canEdit} />
                  <span className="font-medium">{f === "feed" ? "Feed 4:5" : f === "square" ? "Quadrado 1:1" : "Vertical 9:16"}</span>
                  <span className="text-muted-foreground">
                    {CARD_FORMATS[f].width}×{CARD_FORMATS[f].height}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Perfil</h2>
          {props.accounts.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="ec-account">Preencher com uma conta conectada</Label>
              <NativeSelect id="ec-account" value={accountId} onChange={(e) => prefill(e.target.value)} disabled={!props.canEdit}>
                <option value="">— escolher —</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                    {a.username ? ` (@${a.username})` : ""}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">Preenche nome e @ (editáveis). A foto você envia abaixo.</p>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="ec-avatar">Foto do perfil (recorte redondo central)</Label>
            <Input id="ec-avatar" type="file" accept={sourceAccept("avatar")} onChange={(e) => pick("avatar", e.target.files?.[0], setAvatar)} disabled={!props.canEdit} />
            <p className="text-xs text-muted-foreground">{sourceHint("avatar")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-name">Nome da página</Label>
            <Input id="ec-name" value={pageName} maxLength={60} onChange={(e) => (setPageName(e.target.value), touch())} disabled={!props.canEdit} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-user">@usuário</Label>
            <Input id="ec-user" value={username} maxLength={31} onChange={(e) => (setUsername(e.target.value), touch())} disabled={!props.canEdit} placeholder="seuperfil" />
          </div>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Manchete</h2>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ec-headline">Texto do card</Label>
              <span className={hlCount > HEADLINE_MAX_CHARS ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"} aria-live="polite">
                {hlCount}/{HEADLINE_MAX_CHARS}
              </span>
            </div>
            <textarea
              id="ec-headline"
              value={headline}
              rows={4}
              onChange={(e) => (setHeadline(e.target.value), touch())}
              disabled={!props.canEdit}
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              placeholder="🚨 VEJA | Escreva a manchete"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-scale">Tamanho da fonte da manchete: {Math.round(style.headlineScale * 100)}%</Label>
            <input id="ec-scale" type="range" min={0.7} max={1} step={0.05} value={style.headlineScale} onChange={(e) => (setStyle({ ...style, headlineScale: Number(e.target.value) }), touch())} disabled={!props.canEdit} />
            <p className="text-xs text-muted-foreground">Reduza só se precisar: o texto nunca é cortado sem aviso.</p>
          </div>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Mídia</h2>
          <fieldset className="grid gap-2">
            <legend className="sr-only">Tipo de mídia</legend>
            <div className="flex flex-wrap gap-2">
              {(["image", "image_pair", "video"] as const).map((k) => (
                <label key={k} className="cursor-pointer rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                  <input type="radio" name="kind" className="sr-only" checked={mediaKind === k} onChange={() => (setMediaKind(k), setMedia([emptySlot(), emptySlot()]), touch())} disabled={!props.canEdit} />
                  {KIND_LABEL[k]}
                </label>
              ))}
            </div>
          </fieldset>
          {(mediaKind === "image_pair" ? [0, 1] : [0]).map((i) => (
            <div key={i} className="grid gap-1.5">
              <Label htmlFor={`ec-media-${i}`}>{mediaKind === "video" ? "Arquivo do vídeo" : mediaKind === "image_pair" ? `Arquivo da imagem ${i + 1}` : "Arquivo da foto"}</Label>
              <Input
                id={`ec-media-${i}`}
                type="file"
                accept={sourceAccept(mediaKind === "video" ? "video" : "image")}
                onChange={(e) => pick(mediaKind === "video" ? "video" : "image", e.target.files?.[0], (s) => setMedia((m) => (i === 0 ? [s, m[1]] : [m[0], s])))}
                disabled={!props.canEdit}
              />
              <p className="text-xs text-muted-foreground">{sourceHint(mediaKind === "video" ? "video" : "image")}</p>
              {fit === "cover" && media[i]?.src && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="grid gap-1">
                    Foco horizontal
                    <input type="range" min={0} max={1} step={0.01} value={focal[i]!.x} onChange={(e) => (setFocal((f) => f.map((p, j) => (j === i ? { ...p, x: Number(e.target.value) } : p))), touch())} disabled={!props.canEdit} />
                  </label>
                  <label className="grid gap-1">
                    Foco vertical
                    <input type="range" min={0} max={1} step={0.01} value={focal[i]!.y} onChange={(e) => (setFocal((f) => f.map((p, j) => (j === i ? { ...p, y: Number(e.target.value) } : p))), touch())} disabled={!props.canEdit} />
                  </label>
                </div>
              )}
            </div>
          ))}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Enquadramento</legend>
            <div className="flex flex-wrap gap-2">
              {(["cover", "contain"] as const).map((f) => (
                <label key={f} className="cursor-pointer rounded-md border px-3 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                  <input type="radio" name="fit" className="sr-only" checked={fit === f} onChange={() => (setFit(f), touch())} disabled={!props.canEdit} />
                  {f === "cover" ? "Preencher (recortar)" : "Mostrar tudo"}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">A mídia nunca é esticada ou distorcida.</p>
          </fieldset>
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Estilo — Clássico</h2>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-pad">Respiro inferior: {style.bottomPadding}px</Label>
            <input id="ec-pad" type="range" min={0} max={240} step={4} value={style.bottomPadding} onChange={(e) => (setStyle({ ...style, bottomPadding: Number(e.target.value) }), touch())} disabled={!props.canEdit} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-wm">Marca-d’água (sua)</Label>
            <NativeSelect id="ec-wm" value={style.watermark.kind} onChange={(e) => (setStyle({ ...style, watermark: { ...style.watermark, kind: e.target.value as Style["watermark"]["kind"] } }), touch())} disabled={!props.canEdit}>
              <option value="none">Sem marca-d’água</option>
              <option value="username">Seu @usuário</option>
              <option value="logo">Seu logo</option>
            </NativeSelect>
          </div>
          {style.watermark.kind === "logo" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ec-logo">Logo (PNG com fundo transparente funciona melhor)</Label>
              <Input id="ec-logo" type="file" accept={sourceAccept("logo")} onChange={(e) => pick("logo", e.target.files?.[0], setLogo)} disabled={!props.canEdit} />
            </div>
          )}
          {style.watermark.kind !== "none" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ec-wm-pos">Posição</Label>
                <NativeSelect id="ec-wm-pos" value={style.watermark.position} onChange={(e) => (setStyle({ ...style, watermark: { ...style.watermark, position: e.target.value as "bottom-right" | "bottom-left" } }), touch())} disabled={!props.canEdit}>
                  <option value="bottom-right">Embaixo à direita</option>
                  <option value="bottom-left">Embaixo à esquerda</option>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ec-wm-op">Opacidade: {Math.round(style.watermark.opacity * 100)}%</Label>
                <input id="ec-wm-op" type="range" min={0.2} max={1} step={0.05} value={style.watermark.opacity} onChange={(e) => (setStyle({ ...style, watermark: { ...style.watermark, opacity: Number(e.target.value) } }), touch())} disabled={!props.canEdit} />
              </div>
            </div>
          )}
        </section>

        <section className="grid gap-3 rounded-xl border p-4">
          <h2 className="font-medium">Legenda da postagem</h2>
          <p className="text-xs text-muted-foreground">Texto publicado na rede social, separado do texto impresso no card.</p>
          <textarea id="ec-caption" aria-label="Legenda da postagem" value={caption} rows={3} maxLength={2200} onChange={(e) => (setCaption(e.target.value), touch())} disabled={!props.canEdit} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => (setCaption(headline), touch())} disabled={!props.canEdit || !headline.trim()}>
            <Copy /> Copiar a manchete para a legenda
          </Button>
        </section>
      </form>

      {/* Prévia */}
      <div className="order-1 grid content-start gap-3 lg:sticky lg:top-4 lg:order-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
            {dirty && <Badge variant="outline">Alterações não salvas</Badge>}
            {!dirty && status === "draft" && renderedMediaId && <Badge variant="outline">Aguardando nova renderização</Badge>}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} /> Guias de área segura (só na prévia)
          </label>
        </div>
        <div className="mx-auto w-full overflow-hidden rounded-xl border bg-white shadow-sm" style={{ maxWidth: format === "vertical" ? 380 : 520 }}>
          <canvas ref={canvasRef} width={dims.width} height={dims.height} className="block h-auto w-full" role="img" aria-label={`Prévia do card ${dims.width}×${dims.height}: ${pageName} @${normalizeUsername(username)} — ${headline}`} />
        </div>
        {loadingSources && <p className="text-center text-xs text-muted-foreground">Carregando arquivos salvos…</p>}
        {mediaKind === "video" && videoUrl && (
          <div className="mx-auto flex w-full max-w-[520px] items-center gap-2">
            <video ref={videoRef} src={videoUrl} muted={muted} playsInline preload="auto" className="hidden" />
            <Button type="button" size="icon" variant="outline" aria-label={playing ? "Pausar" : "Reproduzir"} onClick={() => (videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause())}>
              {playing ? <Pause /> : <Play />}
            </Button>
            <input
              type="range"
              aria-label="Posição do vídeo"
              className="flex-1"
              min={0}
              max={time.d || 0}
              step={0.01}
              value={time.t}
              onChange={(e) => videoRef.current && (videoRef.current.currentTime = Number(e.target.value))}
            />
            <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
              {time.t.toFixed(1)}s / {time.d.toFixed(1)}s
            </span>
            <Button type="button" size="icon" variant="ghost" aria-label={muted ? "Ativar som" : "Silenciar"} onClick={() => setMuted((m) => !m)}>
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
          </div>
        )}

        <div aria-live="polite" className="grid gap-2">
          {notice && <Alert variant={notice.ok ? "success" : "destructive"}>{notice.text}</Alert>}
          {renderError && <Alert variant="destructive">Erro de render: {renderError} Você pode corrigir e renderizar de novo; o rascunho foi preservado.</Alert>}
          {exportBlockers.length > 0 && (
            <Alert variant="destructive">
              <ul className="list-disc pl-4">{exportBlockers.map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
          {warnings.map((w) => (
            <p key={w.code} className="text-xs text-muted-foreground">
              {w.message}
            </p>
          ))}
          {restrictions.map((r) => (
            <p key={r.code} className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              {r.message}
            </p>
          ))}
          {busy && (
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden /> {busy}
              {progress !== null && <span className="tabular-nums">{progress}%</span>}
            </p>
          )}
        </div>

        {props.canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={save} disabled={disabled}>
              <Save /> Salvar rascunho
            </Button>
            <Button type="button" onClick={render} disabled={disabled || exportBlockers.length > 0} title={exportBlockers[0]}>
              <Sparkles /> Renderizar arquivo final
            </Button>
            <Button type="button" variant="outline" onClick={downloadPng} disabled={disabled || exportBlockers.length > 0}>
              <ImageIcon /> Baixar PNG
            </Button>
            <Button type="button" variant="outline" onClick={downloadFinal} disabled={disabled || (!lastRender && !props.renderedUrl)}>
              <Download /> Baixar arquivo final
            </Button>
            {ready ? (
              <Button asChild variant="default">
                <Link href={`/w/${props.slug}/campaigns/new?media=${renderedMediaId}`}>Agendar</Link>
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled title="Disponível quando o arquivo final estiver pronto e sem alterações pendentes">
                Agendar
              </Button>
            )}
          </div>
        )}
        {props.canEdit && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <form action={duplicateCardAction}>
              <input type="hidden" name="slug" value={props.slug} />
              <input type="hidden" name="card" value={c.id} />
              <Button type="submit" size="sm" variant="ghost" disabled={Boolean(busy)}>
                <Copy /> Duplicar
              </Button>
            </form>
            <form action={deleteCardAction} onSubmit={(e) => !window.confirm("Excluir este card? O arquivo final continua na Biblioteca.") && e.preventDefault()}>
              <input type="hidden" name="slug" value={props.slug} />
              <input type="hidden" name="card" value={c.id} />
              <Button type="submit" size="sm" variant="ghost" className="text-destructive" disabled={Boolean(busy)}>
                <Trash2 /> Excluir
              </Button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
