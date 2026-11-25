export const CAMPAIGN_STATUS = {
  draft: { label: "Rascunho", variant: "secondary" },
  active: { label: "Ativa", variant: "success" },
  paused: { label: "Pausada", variant: "warning" },
  completed: { label: "Concluída", variant: "outline" },
  archived: { label: "Arquivada", variant: "outline" },
} as const;

export const NOTIFICATION_LABELS: Record<string, string> = {
  "upload.completed": "Upload concluído",
  "upload.failed": "Upload com falha",
  "campaign.started": "Campanha iniciada",
  "campaign.completed": "Campanha concluída",
  "publication.published": "Publicação realizada",
  "publication.failed": "Publicação com erro",
  "publication.late": "Publicação atrasada enviada para revisão",
  "publication.needs_review": "Publicação requer revisão",
  "account.disconnected": "Conta desconectada",
  "account.token_expiring": "Autorização expirando",
  "queue.low": "Pouco conteúdo na fila",
  "plan.limit_reached": "Limite do plano atingido",
  "system.worker_stalled": "Processamento de publicações interrompido (as vencidas aguardam)",
};

/** Avisos que também podem ir por e-mail (mesma lista do banco: app.email_worthy). */
export const EMAIL_NOTIFICATION_TYPES = [
  "publication.failed",
  "publication.needs_review",
  "publication.late",
  "account.disconnected",
  "account.token_expiring",
  "system.worker_stalled",
  "upload.failed",
  "plan.limit_reached",
] as const;

export const REVIEW_REASONS: Record<string, string> = {
  late: "Passou do horário além da tolerância (ex.: sistema indisponível).",
  uncertain_unresolved: "Não foi possível confirmar na plataforma se foi publicado.",
  scheduled_time_passed_before_activation: "O horário passou antes da ativação da campanha.",
};

export const ERROR_CLASS_LABELS: Record<string, string> = {
  transient: "Falha temporária da plataforma",
  rate_limited: "Limite de requisições",
  auth: "Autorização da conta",
  permanent: "Rejeitado pela plataforma",
  timeout: "Tempo esgotado",
  unknown: "Erro desconhecido",
  media_unavailable: "Vídeo excluído ou indisponível",
  lease_expired: "Processamento interrompido",
};

/**
 * O que o usuário vê quando uma publicação dá erro: o que aconteceu e o que fazer, sem jargão.
 * O detalhe técnico (classe + mensagem da plataforma) continua disponível em "Detalhes técnicos".
 */
export const FRIENDLY_ERRORS: Record<string, string> = {
  transient: "A rede social falhou por um instante. Vamos tentar de novo automaticamente.",
  rate_limited: "O Instagram pediu para esperar um pouco. Vamos tentar de novo automaticamente.",
  auth: "Não conseguimos publicar. Verifique a conexão da conta em Configurações → Contas.",
  permanent: "O Instagram recusou esta publicação. Confira o vídeo e a legenda e tente de novo.",
  timeout: "A rede social demorou a responder. Vamos confirmar se saiu antes de tentar de novo.",
  unknown: "Não conseguimos publicar. Tente de novo; se continuar, fale com o suporte.",
  media_unavailable: "O vídeo foi excluído ou não está mais disponível. Escolha outro vídeo.",
  lease_expired: "O envio foi interrompido. Vamos retomar automaticamente.",
};
export const friendlyError = (cls: string | null | undefined) => (cls ? (FRIENDLY_ERRORS[cls] ?? FRIENDLY_ERRORS.unknown!) : null);
