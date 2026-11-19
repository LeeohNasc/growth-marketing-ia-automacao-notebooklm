import type { Metadata } from "next";
import { LegalLayout } from "@/components/legal-layout";

export const metadata: Metadata = { title: "Termos de Uso" };

export default function TermsPage() {
  return (
    <LegalLayout title="Termos de Uso" updated="19/11/2026">
      <h2>1. O serviço</h2>
      <p>
        O ReelsFlow organiza vídeos e os publica automaticamente nas contas que você conectar, por meio das APIs oficiais das plataformas. A
        disponibilidade de cada rede depende das regras e aprovações da própria plataforma, que podem mudar sem aviso.
      </p>
      <h2>2. Sua responsabilidade pelo conteúdo</h2>
      <ul>
        <li>Você declara ter os direitos sobre os vídeos, músicas, imagens e textos que publica.</li>
        <li>Você é responsável pelo conteúdo publicado e pelo cumprimento dos termos de cada plataforma.</li>
        <li>É proibido usar o serviço para spam, conteúdo ilegal, violação de direitos de terceiros ou para contornar limites das plataformas.</li>
      </ul>
      <h2>3. Publicação automática</h2>
      <p>
        Publicações ocorrem nos horários configurados, sujeitas a limites, indisponibilidades e decisões das plataformas. Quando não for possível
        confirmar se uma publicação ocorreu, ela será marcada para revisão em vez de repetida automaticamente. Não garantimos alcance, engajamento
        ou que um vídeo será classificado em formato específico (ex.: Reels, Shorts).
      </p>
      <h2>4. Contas conectadas</h2>
      <p>Você pode desconectar contas a qualquer momento. Nunca solicitamos a senha das suas redes sociais.</p>
      <h2>5. Planos e cobrança</h2>
      <p><strong>[Preços, limites, cobrança e cancelamento a definir. Nenhuma cobrança é realizada nesta versão.]</strong></p>
      <h2>6. Limitação de responsabilidade e foro</h2>
      <p><strong>[A definir com assessoria jurídica.]</strong></p>
    </LegalLayout>
  );
}
