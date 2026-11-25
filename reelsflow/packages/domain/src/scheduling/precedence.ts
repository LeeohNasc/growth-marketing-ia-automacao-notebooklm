import { extraHashtags } from "../media";

/**
 * Precedência explícita de configuração:
 * vídeo > campanha > conta > global (workspace).
 * Retorna o valor efetivo e a camada de origem, para exibir na revisão.
 */
export type Layer = "media" | "campaign" | "account" | "global";
export const LAYER_LABELS: Record<Layer, string> = { media: "Vídeo", campaign: "Campanha", account: "Conta", global: "Padrão do workspace" };

export type ContentConfig = { caption?: string | null; hashtags?: string[] | null };
export type Effective<T> = { value: T; source: Layer | "none" };
export type EffectiveContent = { caption: Effective<string>; hashtags: Effective<string[]> };

const ORDER: Layer[] = ["media", "campaign", "account", "global"];

export function resolveContent(layers: Partial<Record<Layer, ContentConfig | null | undefined>>): EffectiveContent {
  const pick = <K extends keyof ContentConfig>(key: K, isSet: (v: ContentConfig[K]) => boolean) => {
    for (const layer of ORDER) {
      const v = layers[layer]?.[key];
      if (v !== undefined && v !== null && isSet(v)) return { value: v, source: layer };
    }
    return null;
  };
  const caption = pick("caption", (v) => typeof v === "string" && v.trim().length > 0);
  const hashtags = pick("hashtags", (v) => Array.isArray(v) && v.length > 0);
  return {
    caption: caption ? { value: caption.value as string, source: caption.source } : { value: "", source: "none" },
    hashtags: hashtags ? { value: hashtags.value as string[], source: hashtags.source } : { value: [], source: "none" },
  };
}

/**
 * Texto final publicado: legenda + hashtags, respeitando limite de caracteres.
 * Hashtags que já aparecem no texto da legenda não são repetidas no fim (sem diferenciar maiúsculas).
 * Sem repetição, o resultado é idêntico ao de antes (compatível com campanhas antigas).
 */
export function composeCaption(content: { caption: string; hashtags: string[] }, maxLength = 2200): { text: string; truncated: boolean } {
  const tags = extraHashtags(content.caption, content.hashtags).join(" ");
  const full = [content.caption.trim(), tags].filter(Boolean).join("\n\n");
  if (full.length <= maxLength) return { text: full, truncated: false };
  return { text: full.slice(0, maxLength), truncated: true };
}
