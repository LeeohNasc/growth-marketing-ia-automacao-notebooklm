import Link from "next/link";
import marks from "@/lib/brand/marks.json";
import { cn } from "@/lib/utils";

/**
 * Marca oficial do ReelsFlow — geometria única em lib/brand/marks.json (a mesma dos arquivos em
 * public/brand, gerados por scripts/brand/build-brand.mjs). Os SVGs são decorativos (aria-hidden):
 * o nome acessível fica no link.
 */
const RED = marks.colors.symbol;

/** Monograma R isolado (espaços compactos). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox={marks.monogram.viewBox} className={cn("h-7 w-auto shrink-0", className)} aria-hidden focusable="false">
      <path fill={RED} d={marks.monogram.back} />
      <path fill={RED} fillRule="evenodd" d={marks.monogram.front} />
    </svg>
  );
}

/** Assinatura horizontal: monograma vermelho + "ReelsFlow" em contornos (cor do texto = currentColor). */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <svg viewBox={marks.lockup.viewBox} className={cn("h-7 w-auto shrink-0", className)} aria-hidden focusable="false">
      <path fill={RED} d={marks.monogram.back} />
      <path fill={RED} fillRule="evenodd" d={marks.monogram.front} />
      <path fill="currentColor" d={marks.lockup.wordmark} />
    </svg>
  );
}

/** Só o nome "ReelsFlow" em contornos (recorte da assinatura; cor = currentColor). */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="370 78 990 160" className={cn("h-6 w-auto shrink-0", className)} aria-hidden focusable="false">
      <path fill="currentColor" d={marks.lockup.wordmark} />
    </svg>
  );
}

/**
 * Link da marca. `variant="lockup"` (padrão) quando há espaço para o nome; `"mark"` em espaços
 * compactos ou ao lado de um "ReelsFlow" já escrito. Texto: #0B0B0C no claro, #F7F7F8 no escuro.
 */
export function Logo({
  href = "/",
  variant = "lockup",
  label = "ReelsFlow",
  className,
}: {
  href?: string;
  variant?: "lockup" | "mark";
  label?: string;
  className?: string;
}) {
  return (
    <Link href={href} aria-label={label} className={cn("inline-flex items-center rounded-md text-[#0B0B0C] dark:text-[#F7F7F8]", className)}>
      {variant === "mark" ? <BrandMark /> : <BrandLockup />}
    </Link>
  );
}
