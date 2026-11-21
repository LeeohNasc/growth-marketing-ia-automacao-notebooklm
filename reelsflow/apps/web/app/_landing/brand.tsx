import { BrandLockup } from "@/components/logo";
import s from "./landing.module.css";

/** Assinatura oficial (texto #F7F7F8 sobre o fundo escuro da landing). Clique volta ao topo. */
export function Brand({ size = "header" }: { size?: "header" | "footer" }) {
  return (
    <a href="#topo" className={s.brand} aria-label="ReelsFlow — voltar ao topo">
      <BrandLockup className={size === "footer" ? s.brandFooter : s.brandHeader} />
    </a>
  );
}
