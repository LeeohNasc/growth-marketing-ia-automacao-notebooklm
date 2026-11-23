"use client";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./brand";
import { MOBILE_NAV, NAV } from "./content";
import s from "./landing.module.css";

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onResize = () => window.matchMedia("(min-width: 900px)").matches && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <Brand />
        <nav aria-label="Principal" className={s.nav}>
          {NAV.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className={s.headerActions}>
          <a href="/login" className={s.loginLink}>
            Entrar
          </a>
          <a href="#planos" className={`${s.btn} ${s.btnPrimary} ${s.btnSm} ${s.desktopOnly}`}>
            Ver planos
          </a>
          <button
            ref={btn}
            type="button"
            className={`${s.btn} ${s.btnGhost} ${s.btnSm} ${s.menuBtn}`}
            aria-expanded={open}
            aria-controls="menu-mobile"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Fechar" : "Menu"}
          </button>
        </div>
      </div>
      <nav id="menu-mobile" aria-label="Menu" className={s.mobileMenu} hidden={!open}>
        {MOBILE_NAV.map((l) => (
          <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
            {l.label}
          </a>
        ))}
        <a href="/login" onClick={() => setOpen(false)}>
          Entrar
        </a>
      </nav>
    </header>
  );
}
