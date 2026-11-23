"use client";
import { useRef, useState } from "react";
import { CALENDAR, HISTORY, LIBRARY, type CalendarDay } from "./content";
import s from "./landing.module.css";

type View = "calendario" | "biblioteca" | "historico";
const VIEWS: { key: View; label: string }[] = [
  { key: "calendario", label: "Calendário" },
  { key: "biblioteca", label: "Biblioteca" },
  { key: "historico", label: "Histórico" },
];

const Play = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5.5v13l10-6.5-10-6.5Z" />
  </svg>
);

/** Demonstração local do painel (dados ilustrativos, sem chamadas ao servidor). */
export function PanelDemo() {
  const [view, setView] = useState<View>("calendario");
  const [switched, setSwitched] = useState(false); // anima só ao trocar de tela, não no carregamento
  const [detail, setDetail] = useState<{ day: string; event: NonNullable<CalendarDay["event"]> } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const openDetail = (d: CalendarDay, el: HTMLButtonElement) => {
    if (!d.event) return;
    opener.current = el;
    setDetail({ day: d.day, event: d.event });
    dialog.current?.showModal();
  };
  const onClose = () => {
    opener.current?.focus();
  };

  return (
    <div className={s.demoFrame}>
      <div className={s.demoBar}>
        <span>
          <strong>ReelsFlow</strong> <span className={s.muted}>/ Planejamento</span>
        </span>
        <span className={s.demoTag}>Dados ilustrativos</span>
      </div>
      <div className={s.demoBody}>
        <div className={s.demoSide} role="group" aria-label="Telas da demonstração">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" aria-pressed={view === v.key} className={s.demoTab} onClick={() => {
                setView(v.key);
                setSwitched(true);
              }}>
              {v.label}
            </button>
          ))}
        </div>
        <div className={s.demoMain}>
          <p className={s.srOnly} aria-live="polite">
            Exibindo {VIEWS.find((v) => v.key === view)!.label}
          </p>
          <div key={view} className={switched ? s.demoView : undefined}>
            {view === "calendario" && (
              <>
                <div className={s.demoHead}>
                  <h3>Calendário de publicações</h3>
                  <span className={s.chip}>18–22 de maio</span>
                </div>
                <ul className={s.calendar}>
                  {CALENDAR.map((d) => (
                    <li key={d.day} className={d.event ? s.calDay : `${s.calDay} ${s.calEmpty}`}>
                      <span className={s.calLabel}>{d.day}</span>
                      {d.event ? (
                        <button
                          type="button"
                          className={`${s.calEvent} ${s[`tone_${d.event.tone}`]}`}
                          aria-haspopup="dialog"
                          onClick={(e) => openDetail(d, e.currentTarget)}
                        >
                          <span className={s.calTime}>{d.event.time}</span>
                          <span className={s.calVideo}>{d.event.video}</span>
                          <span className={s.calStatus}>{d.event.status}</span>
                        </button>
                      ) : (
                        <span className={s.calNone} aria-label="Sem publicações">
                          —
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {view === "biblioteca" && (
              <>
                <div className={s.demoHead}>
                  <h3>Vídeos da semana</h3>
                </div>
                <ul className={s.rows}>
                  {LIBRARY.map((r) => (
                    <li key={r.name} className={s.row}>
                      <span className={s.rowIcon}>
                        <Play />
                      </span>
                      <span className={s.rowName}>{r.name}</span>
                      <span className={s.rowMeta}>{r.duration}</span>
                      <span className={`${s.badge} ${s[`badge_${r.tone}`]}`}>{r.status}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {view === "historico" && (
              <>
                <div className={s.demoHead}>
                  <h3>Publicações anteriores</h3>
                </div>
                <ul className={s.rows}>
                  {HISTORY.map((r) => (
                    <li key={r.name} className={s.row}>
                      <span className={s.rowIcon}>
                        <Play />
                      </span>
                      <span className={s.rowName}>{r.name}</span>
                      <span className={s.rowMeta}>{r.when}</span>
                      <span className={`${s.badge} ${s[`badge_${r.tone}`]}`}>{r.status}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      <dialog ref={dialog} className={s.dialog} aria-labelledby="demo-dialog-title" onClose={onClose}>
        {detail && (
          <div className={s.dialogBody}>
            <div className={s.dialogTop}>
              <span className={s.demoTag}>Agendamento ilustrativo</span>
              <button type="button" className={s.dialogClose} aria-label="Fechar detalhes" onClick={() => dialog.current?.close()}>
                ×
              </button>
            </div>
            <h3 id="demo-dialog-title">{detail.event.video}</h3>
            <dl className={s.dialogData}>
              <div>
                <dt>Dia</dt>
                <dd>{detail.day}</dd>
              </div>
              <div>
                <dt>Horário</dt>
                <dd>{detail.event.time}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{detail.event.status}</dd>
              </div>
            </dl>
          </div>
        )}
      </dialog>
    </div>
  );
}
