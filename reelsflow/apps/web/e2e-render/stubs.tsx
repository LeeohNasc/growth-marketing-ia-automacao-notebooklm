/** Stubs de módulos do Next para montar o editor fora do Next (somente testes). */
import type { AnchorHTMLAttributes } from "react";
export default function Link({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href} {...rest} />;
}
export async function createCardAction() {}
export async function duplicateCardAction() {}
export async function deleteCardAction() {}
