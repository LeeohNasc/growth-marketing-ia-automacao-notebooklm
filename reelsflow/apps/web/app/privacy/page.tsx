import type { Metadata } from "next";
import { LegalLayout } from "@/components/legal-layout";

export const metadata: Metadata = { title: "Política de Privacidade" };

export default function PrivacyPage() {
  return (
    <LegalLayout title="Política de Privacidade" updated="19/11/2026">
      <p>
        Esta política descreve como o ReelsFlow (“nós”) trata dados pessoais ao oferecer o serviço de organização, agendamento e publicação
        automática de vídeos em redes sociais, nos termos da Lei nº 13.709/2018 (LGPD). Controlador: <strong>[razão social, CNPJ e endereço a definir]</strong>.
        Encarregado (DPO): <strong>[nome e e-mail a definir]</strong>.
      </p>
      <h2>1. Dados que tratamos</h2>
      <ul>
        <li>Cadastro: nome, e-mail, senha (armazenada apenas como hash pelo provedor de autenticação), fuso horário.</li>
        <li>Conteúdo enviado por você: vídeos, legendas, hashtags e metadados técnicos extraídos dos arquivos (duração, resolução, codecs).</li>
        <li>
          Contas conectadas da Meta (Facebook e Instagram): identificadores das Páginas e contas profissionais, nome de exibição, foto de perfil,
          identificador do usuário no app e tokens de acesso. Tokens são armazenados criptografados (AES-256-GCM) e usados somente para
          publicar o conteúdo que você agendou e consultar o status dessas publicações.
        </li>
        <li>Registros operacionais: histórico de publicações, tentativas, erros e auditoria de ações no workspace.</li>
      </ul>
      <h2>2. Permissões solicitadas à Meta e finalidade</h2>
      <ul>
        <li>pages_show_list, pages_read_engagement: listar as Páginas que você administra e ler informações necessárias à publicação.</li>
        <li>pages_manage_posts: publicar Reels nas Páginas que você escolher.</li>
        <li>instagram_basic, instagram_content_publish: identificar a conta profissional vinculada e publicar Reels nela.</li>
      </ul>
      <p>Não vendemos dados, não usamos dados das redes para publicidade e não acessamos mensagens privadas.</p>
      <h2>3. Bases legais</h2>
      <p>Execução de contrato (prestação do serviço), consentimento (conexão das contas, revogável a qualquer momento) e legítimo interesse (segurança e prevenção a fraudes).</p>
      <h2>4. Compartilhamento</h2>
      <p>
        Com operadores necessários ao serviço: provedor de banco de dados e armazenamento, hospedagem da aplicação e do processador de
        publicações, monitoramento de erros e as próprias plataformas (Meta) quando você agenda uma publicação. <strong>[Lista de subprocessadores e países a definir.]</strong>
      </p>
      <h2>5. Retenção</h2>
      <ul>
        <li>Vídeos excluídos: removidos definitivamente em até 30 dias.</li>
        <li>Tokens de acesso: apagados ao desconectar a conta, excluir o workspace ou a conta, ou mediante solicitação de exclusão pela Meta.</li>
        <li>Registros de tentativas: 180 dias; auditoria: 1 ano. <strong>[Prazos a validar juridicamente.]</strong></li>
      </ul>
      <h2>6. Seus direitos</h2>
      <p>
        Você pode acessar, corrigir, exportar e excluir seus dados, revogar consentimentos e desconectar contas a qualquer momento em
        Configurações. A exclusão da conta remove seus dados pessoais e os workspaces em que você é o único membro.
      </p>
      <h2>7. Exclusão de dados solicitada pela Meta</h2>
      <p>
        Se você remover o ReelsFlow das configurações do Facebook, recebemos uma solicitação de exclusão e apagamos as credenciais e os dados das
        contas vinculadas. Você recebe um código para acompanhar o status em <code>/data-deletion/&lt;código&gt;</code>.
      </p>
      <h2>8. Segurança</h2>
      <p>Isolamento de dados por workspace no banco, criptografia de tokens, armazenamento privado com links temporários e registros de auditoria.</p>
      <h2>9. Contato</h2>
      <p><strong>[E-mail de contato a definir.]</strong></p>
    </LegalLayout>
  );
}
