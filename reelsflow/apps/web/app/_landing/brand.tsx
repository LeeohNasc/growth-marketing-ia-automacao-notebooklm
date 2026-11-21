import s from "./landing.module.css";

/** Marca: texto branco + ícone de reprodução vermelho (mesmo símbolo do app). Clique volta ao topo. */
export function Brand() {
  return (
    <a href="#topo" className={s.brand} aria-label="ReelsFlow — voltar ao topo">
      <span className={s.brandMark} aria-hidden>
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13l10-6.5-10-6.5Z" />
        </svg>
      </span>
      <span>ReelsFlow</span>
    </a>
  );
}
