"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type Day = { day: string; published: number; failed: number; other: number };

const fmtDay = (d: string) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

/** Teto "limpo" do eixo (1, 2, 5 × 10^n). */
function niceMax(n: number) {
  if (n <= 4) return Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= n)!;
}

/**
 * Publicações realizadas por dia: série única (uma cor), colunas finas com
 * cantos de 4px no topo e 2px de espaço entre elas; tooltip ao passar o mouse
 * ou focar pelo teclado; tabela equivalente abaixo.
 */
export function DailyColumns({ days }: { days: Day[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...days.map((d) => d.published)));
  const ticks = [0, max / 2, max].filter((v, i, a) => a.indexOf(v) === i && Number.isInteger(v));
  return (
    <figure className="grid gap-3">
      <div className="relative grid grid-cols-[2rem_1fr] gap-2">
        <div className="relative h-48 text-right text-xs tabular-nums text-muted-foreground" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / max) * 100}%` }}>
              {t.toLocaleString("pt-BR")}
            </span>
          ))}
        </div>
        <div className="relative h-48">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-border/60" style={{ top: `${100 - (t / max) * 100}%` }} aria-hidden />
          ))}
          <ol className="absolute inset-0 flex items-end gap-0.5" aria-label="Publicações realizadas por dia">
            {days.map((d, i) => (
              <li key={d.day} className="relative flex h-full flex-1 items-end justify-center">
                <button
                  type="button"
                  className="flex h-full w-full items-end justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  aria-label={`${fmtDay(d.day)}: ${d.published} publicadas, ${d.failed} falhas, ${d.other} pendentes ou em revisão`}
                >
                  <span
                    className={cn("w-full max-w-6 rounded-t bg-chart-1 transition-opacity", active !== null && active !== i && "opacity-50")}
                    style={{ height: `${(d.published / max) * 100}%`, minHeight: d.published ? 2 : 0 }}
                  />
                </button>
                {active === i && (
                  <div role="tooltip" className="pointer-events-none absolute bottom-full z-10 mb-2 w-max rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
                    <p className="font-medium">{fmtDay(d.day)}</p>
                    <p>
                      <span className="mr-1.5 inline-block size-2 rounded-sm bg-chart-1 align-middle" />
                      {d.published} publicadas
                    </p>
                    <p className="text-muted-foreground">{d.failed} falhas definitivas</p>
                    <p className="text-muted-foreground">{d.other} pendentes/em revisão</p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="grid grid-cols-[2rem_1fr] gap-2 text-xs text-muted-foreground" aria-hidden>
        <span />
        <div className="flex justify-between">
          <span>{days[0] && fmtDay(days[0].day)}</span>
          <span>{days.at(-1) && fmtDay(days.at(-1)!.day)}</span>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Ver tabela</summary>
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Dia</th>
              <th className="py-1 text-right font-medium">Publicadas</th>
              <th className="py-1 text-right font-medium">Falhas</th>
              <th className="py-1 text-right font-medium">Outras</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {days.filter((d) => d.published + d.failed + d.other > 0).map((d) => (
              <tr key={d.day} className="tabular-nums">
                <td className="py-1">{fmtDay(d.day)}</td>
                <td className="py-1 text-right">{d.published}</td>
                <td className="py-1 text-right">{d.failed}</td>
                <td className="py-1 text-right">{d.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export type AccountRow = { account: string; platform: string; published: number; failed: number; total: number };

/** Barras horizontais ordenadas (uma cor), valor na ponta; falhas como texto. */
export function AccountBars({ rows, platformLabel }: { rows: AccountRow[]; platformLabel: Record<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => r.published));
  return (
    <ul className="grid gap-3" aria-label="Publicações realizadas por conta">
      {rows.map((r) => (
        <li key={`${r.account}-${r.platform}`} className="grid gap-1 text-sm sm:grid-cols-[12rem_1fr] sm:items-center sm:gap-3">
          <span className="truncate">
            {r.account} <span className="text-xs text-muted-foreground">{platformLabel[r.platform] ?? r.platform}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="h-3 rounded-r bg-chart-1" style={{ width: `${(r.published / max) * 85}%`, minWidth: r.published ? 4 : 0 }} aria-hidden />
            <span className="whitespace-nowrap tabular-nums">
              {r.published}
              <span className="text-muted-foreground"> publicadas{r.failed ? ` · ${r.failed} falhas` : ""}</span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
