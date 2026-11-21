"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import s from "./landing.module.css";

type Line = { d: string; end: [number, number] };
type Geometry = { w: number; h: number; origin: [number, number]; lines: Line[] };

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Conexões do card central (monograma) até cada rede, desenhadas sobre a posição REAL dos cards
 * (sem esticar o SVG). Os pulsos usam exatamente os mesmos caminhos: núcleo e halo andam com
 * `offset-path`; o rastro é um traço curto que percorre o próprio path. Decorativo: aria-hidden,
 * fora do teclado e sem interceptar cliques. Pausa fora da tela; com movimento reduzido, só as linhas.
 */
export function NetworkConnectors() {
  const ref = useRef<SVGSVGElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const svg = ref.current;
    const panel = svg?.parentElement;
    if (!svg || !panel) return;
    const compute = () => {
      const hub = panel.querySelector("[data-hub]");
      const cards = [...panel.querySelectorAll("[data-network]")];
      if (!hub || cards.length === 0) return;
      const pb = panel.getBoundingClientRect();
      const hb = hub.getBoundingClientRect();
      const ox = r1(hb.left + hb.width / 2 - pb.left);
      const oy = r1(hb.bottom - pb.top);
      const boxes = cards.map((c) => c.getBoundingClientRect());
      const firstTop = boxes[0]!.top;
      const row0 = boxes.filter((b) => Math.abs(b.top - firstTop) < 4);
      const row0Bottom = Math.max(...row0.map((b) => b.bottom));
      const lines = boxes.map((b): Line => {
        const tx = r1(b.left + b.width / 2 - pb.left);
        const ty = r1(b.top - pb.top);
        if (Math.abs(b.top - firstTop) < 4) {
          // primeira fileira: curva suave do centro até o topo do card (como na arte)
          const dy = ty - oy;
          return { d: `M${ox} ${oy}C${ox} ${r1(oy + dy * 0.55)} ${tx} ${r1(oy + dy * 0.35)} ${tx} ${ty}`, end: [tx, ty] };
        }
        // fileiras de baixo (celular 2×2): desce pelo vão central, segue pelo vão entre as fileiras
        // e entra pelo topo do card — a linha fica sempre visível entre os cards.
        const gapY = r1((row0Bottom - pb.top + ty) / 2);
        const dir = tx < ox ? -1 : 1;
        const r = Math.max(2, Math.min(8, Math.abs(tx - ox) / 2, ty - gapY));
        return {
          d: `M${ox} ${oy}V${r1(gapY - r)}Q${ox} ${gapY} ${r1(ox + dir * r)} ${gapY}H${r1(tx - dir * r)}Q${tx} ${gapY} ${tx} ${r1(gapY + r)}V${ty}`,
          end: [tx, ty],
        };
      });
      setGeo({ w: r1(pb.width), h: r1(pb.height), origin: [ox, oy], lines });
    };
    compute();
    void document.fonts?.ready.then(compute); // posições finais após carregar a fonte
    const ro = new ResizeObserver(compute);
    ro.observe(panel);
    const io = new IntersectionObserver(([e]) => setActive(Boolean(e?.isIntersecting)), { threshold: 0.2 });
    io.observe(panel);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return (
    <svg
      ref={ref}
      className={s.connectorsLayer}
      data-active={active ? "true" : "false"}
      viewBox={geo ? `0 0 ${geo.w} ${geo.h}` : "0 0 1 1"}
      width={geo?.w}
      height={geo?.h}
      aria-hidden
      focusable="false"
    >
      {geo && (
        <>
          <defs>
            <filter id="rf-pulse-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          {geo.lines.map((l, i) => {
            const delay = { "--rf-delay": `${i * 350}ms` } as CSSProperties;
            const motion = { ...delay, offsetPath: `path('${l.d}')` } as CSSProperties;
            return (
              <g key={i} data-line={i}>
                <path d={l.d} className={s.connectorBase} />
                <path d={l.d} pathLength={100} className={`${s.trail} ${s.trailLong}`} style={delay} />
                <path d={l.d} pathLength={100} className={`${s.trail} ${s.trailMid}`} style={delay} />
                <path d={l.d} pathLength={100} className={`${s.trail} ${s.trailShort}`} style={delay} />
                <circle r={7} className={s.pulseHalo} style={motion} filter="url(#rf-pulse-glow)" />
                <circle r={2.6} className={s.pulseCore} style={motion} data-pulse={i} />
                <circle cx={l.end[0]} cy={l.end[1]} r={3.2} className={s.endDot} style={delay} data-end={i} />
              </g>
            );
          })}
          <circle cx={geo.origin[0]} cy={geo.origin[1]} r={3.6} className={s.originDot} data-origin />
        </>
      )}
    </svg>
  );
}
