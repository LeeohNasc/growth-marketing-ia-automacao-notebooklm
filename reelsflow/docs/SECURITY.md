# Segurança e privacidade — ReelsFlow

Versão 0.1 · Fase 0

## 1. Ativos a proteger
1. Tokens OAuth das redes sociais (permitem publicar em nome do cliente — o ativo mais sensível).
2. Vídeos privados ainda não publicados.
3. Dados pessoais (e-mail, nome, IP) — LGPD.
4. Integridade do agendamento (ninguém publica em conta alheia nem altera fila de outro workspace).

## 2. Ameaças e controles

| Ameaça | Controle |
|---|---|
| Usuário acessa dados de outro workspace | RLS em todas as tabelas de domínio; `workspace_id` em todas; testes automatizados de acesso cruzado (banco e storage) |
| Escalada de papel (viewer edita) | Papéis checados em RLS por operação; mudanças de membro só `admin+` |
| Vazamento de tokens | AES-256-GCM na aplicação; chave em variável de ambiente só no servidor/worker; tabela de tokens sem policies para clientes; nunca em localStorage, logs ou respostas da API |
| Service role exposta | Usada apenas no worker e em código server-only (`import 'server-only'`); lint que bloqueia `SUPABASE_SERVICE_ROLE_KEY` em código cliente; varredura de segredos no CI |
| CSRF / OAuth injection | `state` aleatório vinculado à sessão + PKCE quando suportado; redirect URIs exatos |
| Upload malicioso | Validação de MIME e assinatura do arquivo; `ffprobe` em processo isolado com timeout e limite de memória; nunca executar conteúdo; tamanho máximo por plano |
| URL assinada vazada | Expiração curta (minutos para reprodução; poucas horas para a Meta buscar o vídeo) |
| Abuso / spam via plataforma | Limites por plano, espaçamento mínimo por conta, cotas da plataforma respeitadas; termos de uso proibindo conteúdo ilícito |
| Alteração de histórico | `audit_logs` e `publication_attempts` append-only (sem update/delete pelo cliente) |
| Dependências vulneráveis | `pnpm audit` e Dependabot no CI; versões fixadas |

## 3. Sessões e autenticação
- Supabase Auth com cookies httpOnly via `@supabase/ssr`; validação de sessão no servidor com `getUser()` (não confiar apenas no cookie decodificado).
- Confirmação de e-mail obrigatória antes de conectar contas sociais.
- Exclusão de conta: remove membros, revoga tokens nas plataformas (quando a API permitir), apaga arquivos e dados pessoais; registro mínimo anonimizado para auditoria.

## 4. Logs
- Nunca registrar: tokens, códigos OAuth, URLs assinadas, cabeçalhos `Authorization`, conteúdo de legenda completo em erro (truncar).
- Mensagens de erro das plataformas passam por sanitizador antes de ir para `publication_attempts`.

## 5. LGPD (pontos a validar com assessoria jurídica — não sou fonte jurídica)
- Bases legais: execução de contrato (operação do serviço) e consentimento explícito para conexão das redes.
- Papel provável: ReelsFlow como **operador** em relação aos dados de terceiros que aparecem nos vídeos dos clientes, e **controlador** dos dados de cadastro.
- Direitos do titular: exportação e exclusão via tela de configurações.
- Política de privacidade e termos de uso — também exigidos pelos App Reviews.
- Callback de exclusão de dados exigido pela Meta.
- Subprocessadores a declarar: Supabase, Vercel, provedor do worker, Sentry, plataformas sociais.

## 6. Checklist de segurança por fase
- **Fase 1:** RLS + testes de isolamento; segredos fora do repositório; CI com varredura de segredos.
- **Fase 2:** policies de storage + testes; validação de upload; URLs assinadas.
- **Fase 3:** RPCs de edição com checagem de estado; trigger de transição; auditoria.
- **Fase 4:** criptografia de tokens, rotação de chave documentada, revogação, sanitização de erros; revisão de segurança antes do App Review.
