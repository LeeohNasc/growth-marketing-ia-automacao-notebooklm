"use client";
import { useState } from "react";
import { FIELDS, INVALID, manualPublishingTime } from "./calc";
import { PRESETS } from "./content";
import s from "./landing.module.css";

export function TimeCalculator() {
  const [v, setV] = useState({ videos: "3", minutes: "4", days: "25" });
  const result = manualPublishingTime(v.videos, v.minutes, v.days);
  const field = (key: keyof typeof v, label: string) => (
    <label className={s.calcField}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={FIELDS[key].min}
        max={FIELDS[key].max}
        step={FIELDS[key].step}
        value={v[key]}
        onChange={(e) => setV((cur) => ({ ...cur, [key]: e.target.value }))}
      />
    </label>
  );
  return (
    <div className={s.calcPanel}>
      <div className={s.calcInputs}>
        <div className={s.presets} role="group" aria-label="Exemplos prontos">
          {PRESETS.map((p) => {
            const active = v.videos === String(p.videos) && v.minutes === String(p.minutes) && v.days === String(p.days);
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={active}
                className={s.preset}
                onClick={() => setV({ videos: String(p.videos), minutes: String(p.minutes), days: String(p.days) })}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {field("videos", "Vídeos por dia")}
        {field("minutes", "Minutos por vídeo")}
        {field("days", "Dias por mês")}
      </div>
      <div className={s.calcResult}>
        <h3>Tempo de publicação manual</h3>
        <p className={result ? s.calcValue : s.calcInvalid} aria-live="polite" data-testid="calc-result">
          {result ?? INVALID}
        </p>
        <p className={s.muted}>Para estimar a economia, desconte o tempo que você ainda dedicaria ao envio, à revisão e ao acompanhamento.</p>
      </div>
    </div>
  );
}
