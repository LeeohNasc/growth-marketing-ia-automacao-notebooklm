"use client";
import { useState } from "react";
import { extraHashtags, hashtagsInText, normalizeHashtags } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Legenda em UM campo principal: hashtags podem ser escritas no próprio texto e são reconhecidas na hora.
 * O campo separado de hashtags continua existindo (compatibilidade), recolhido em "Hashtags extras";
 * as que já estão no texto não são repetidas ao salvar.
 */
export function CaptionField({
  caption,
  hashtags,
  label = "Legenda",
  hint,
  rows = 4,
  error,
  onChange,
}: {
  caption?: string | null;
  hashtags?: string[];
  label?: string;
  hint?: string;
  rows?: number;
  error?: string;
  /** Avisa o texto e as hashtags extras a cada mudança (para prévias ao vivo). */
  onChange?: (caption: string, extra: string) => void;
}) {
  const [text, setText] = useState(caption ?? "");
  const [extra, setExtra] = useState((hashtags ?? []).join(" "));
  const inText = hashtagsInText(text);
  const typed = normalizeHashtags(extra);
  const kept = extraHashtags(text, typed);
  const repeated = typed.length - kept.length;
  return (
    <div className="grid gap-2">
      <Label htmlFor="caption">{label}</Label>
      <textarea
        id="caption"
        name="caption"
        rows={rows}
        maxLength={2200}
        value={text}
        onChange={(e) => (setText(e.target.value), onChange?.(e.target.value, extra))}
        aria-describedby="caption-help"
        className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p id="caption-help" className="text-xs text-muted-foreground">
        {hint ?? "Escreva as hashtags no próprio texto, onde quiser."} {text.length}/2200
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {inText.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" aria-label="Hashtags reconhecidas no texto">
          <span className="text-xs text-muted-foreground">Hashtags no texto:</span>
          {inText.map((t) => (
            <Badge key={t} variant="secondary" className="font-normal">
              {t}
            </Badge>
          ))}
        </div>
      )}
      <details className="text-sm" open={typed.length > 0}>
        <summary className="cursor-pointer text-xs text-muted-foreground">Hashtags extras (opcional)</summary>
        <div className="mt-2 grid gap-1.5">
          <Input id="hashtags" name="hashtags" value={extra} onChange={(e) => (setExtra(e.target.value), onChange?.(text, e.target.value))} placeholder="#reels #dica" aria-label="Hashtags extras" />
          <p className="text-xs text-muted-foreground">
            Entram no fim da legenda. Separe por espaço ou vírgula (máximo de 30).
            {repeated > 0 && ` ${repeated === 1 ? "1 já está" : `${repeated} já estão`} no texto e não ${repeated === 1 ? "será repetida" : "serão repetidas"}.`}
          </p>
        </div>
      </details>
    </div>
  );
}
