import type { Metadata } from "next";
import { Brand } from "./_landing/brand";
import { TimeCalculator } from "./_landing/calculator";
import { AUDIENCE, COMPARISON, FAQ, FEATURES, GLOSSARY, INTEGRATIONS, PLANS, TESTIMONIALS, USE_CASE_STEPS, type AvailabilityStatus } from "./_landing/content";
import { BrandMark, BrandWordmark } from "@/components/logo";
import { PanelDemo } from "./_landing/demo";
import { LandingHeader } from "./_landing/header";
import s from "./_landing/landing.module.css";
import { billingConfig } from "@/lib/billing/server";

const TITLE = "ReelsFlow — vídeos curtos organizados e programados";
const DESCRIPTION =
  "Transforme uma pasta cheia de vídeos em uma semana de publicações planejadas. Organize, programe e acompanhe tudo em um só painel.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  // Prévia comercial (pré-lançamento): fora dos buscadores. Restrito a esta página.
  robots: { index: false, follow: false },
  openGraph: { type: "website", locale: "pt_BR", siteName: "ReelsFlow", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

function Status({ value }: { value: AvailabilityStatus }) {
  if (!value) return null;
  return (
    <span className={s.status} data-status={value === "Planejado" ? "planned" : "testing"}>
      {value}
    </span>
  );
}

export default function LandingPage() {
  // CTAs de assinatura só aparecem com a cobrança (modo de teste) configurada no servidor.
  const billingOn = billingConfig().configured;
  return (
    <div className={s.root} id="topo">
      <a href="#conteudo" className={s.skip}>
        Ir para o conteúdo
      </a>
      <LandingHeader />

      <main id="conteudo" tabIndex={-1}>
        {/* Hero + demonstração */}
        <section className={s.hero} aria-labelledby="hero-title">
          <div className={s.container}>
            <h1 id="hero-title" className={s.heroTitle}>
              Seus vídeos prontos.
              <br />
              <span className={s.red}>A semana no automático.</span>
            </h1>
            <p className={s.heroLead}>
              Transforme uma pasta cheia de vídeos em uma semana de publicações planejadas. Organize, programe e acompanhe tudo em um só painel.
            </p>
            <div className={s.ctaRow}>
              <a href="#demonstracao" className={`${s.btn} ${s.btnPrimary}`}>
                Explorar demonstração ↘
              </a>
              <a href="#planos" className={`${s.btn} ${s.btnGhost}`}>
                Ver planos
              </a>
            </div>
          </div>
          <div id="demonstracao" className={s.demoWrap} aria-label="Demonstração do painel" role="region">
            <PanelDemo />
          </div>
        </section>

        {/* Como funciona */}
        <section id="como" className={s.section} aria-labelledby="como-title">
          <div className={s.container}>
            <div className={s.sectionHead}>
              <h2 id="como-title">Planeje uma vez. Acompanhe pelo painel.</h2>
              <p>A proposta é reduzir a repetição de abrir o app, localizar o vídeo e lembrar do horário a cada postagem.</p>
            </div>
            <ol className={s.steps}>
              <li className={s.card}>
                <div className={s.thumb} aria-hidden>
                  <span className={s.thumbFile}>▶ Corte do podcast.mp4</span>
                  <span className={s.thumbFile}>▶ Bastidores.mp4</span>
                </div>
                <h3>Envie seus vídeos</h3>
                <p>Reúna os arquivos que você quer incluir na programação.</p>
              </li>
              <li className={s.card}>
                <div className={`${s.thumb} ${s.thumbSlots}`} aria-hidden>
                  <span className={s.slot}>SEG 12:00</span>
                  <span className={`${s.slot} ${s.slotActive}`}>TER 18:00</span>
                  <span className={s.slot}>QUI 17:00</span>
                </div>
                <h3>Monte a programação</h3>
                <p>Organize a sequência dos conteúdos e revise os horários.</p>
              </li>
              <li className={s.card}>
                <div className={s.thumb} aria-hidden>
                  <span className={s.thumbStatus}>
                    Dica rápida <b className={s.badge_green}>Publicado</b>
                  </span>
                  <span className={s.thumbStatus}>
                    Resumo da semana <b className={s.badge_amber}>Em revisão</b>
                  </span>
                </div>
                <h3>Acompanhe os status</h3>
                <p>Consulte a agenda e veja exemplos de publicações concluídas ou com falha na demonstração.</p>
              </li>
            </ol>
          </div>
        </section>

        {/* Funcionalidades — composição em HTML (a arte final traz o Card Editorial sem o status "Em homologação") */}
        <section id="funcionalidades" className={`${s.section} ${s.featuresSection}`} aria-labelledby="func-title">
          <div className={s.container}>
            <div className={s.featuresPanel}>
              <h2 id="func-title" className={s.panelTitle}>
                Do vídeo à publicação, em um só lugar
              </h2>
              <div className={s.featuresGrid}>
                <div className={s.featuresHub} aria-hidden>
                  <BrandMark className={s.hubMark} />
                  <BrandWordmark className={s.hubWordmark} />
                </div>
                <ul className={s.featuresList}>
                  {FEATURES.map((f) => (
                    <li key={f.title} className={s.feature} data-slot={f.slot}>
                      <h3>
                        {f.title}
                        {f.status && <> <Status value={f.status} /></>}
                      </h3>
                      <p>{f.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={s.panelCta}>
                <a href="#demonstracao" className={`${s.btn} ${s.btnPrimary}`}>
                  Explorar demonstração
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Integrações — cards em HTML enquanto alguma rede estiver em teste ou planejada */}
        <section id="integracoes" className={s.section} aria-labelledby="integ-title">
          <div className={s.container}>
            <div className={s.integrationsPanel}>
              <h2 id="integ-title" className={s.panelTitle}>
                Suas redes, <span className={s.underline}>um só painel</span>
              </h2>
              <div className={s.hubCard} aria-hidden>
                <BrandMark className={s.hubCardMark} />
                <BrandWordmark className={s.hubCardWordmark} />
              </div>
              <svg className={s.connectors} viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden focusable="false">
                {[125, 375, 625, 875].map((x) => (
                  <path key={x} d={`M500 0 C500 60 ${x} 40 ${x} 120`} />
                ))}
              </svg>
              <ul className={s.networks}>
                {INTEGRATIONS.map((n) => (
                  <li key={n.name} className={s.network}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={n.icon} alt="" width={n.w} height={n.h} loading="lazy" decoding="async" className={s.networkIcon} />
                    <span className={s.networkName}>{n.name}</span>
                    <Status value={n.status} />
                  </li>
                ))}
              </ul>
              <p className={s.statusNote}>
                Em teste: conexão implementada, em validação com as plataformas. Planejado: depende de aprovação da rede. A disponibilidade para
                assinantes é confirmada antes da abertura das vendas.
              </p>
            </div>
          </div>
        </section>

        {/* Para quem é */}
        <section id="publico" className={`${s.section} ${s.sectionAlt}`} aria-labelledby="publico-title">
          <div className={s.container}>
            <div className={s.sectionHead}>
              <h2 id="publico-title">Para quem publica vídeos toda semana</h2>
            </div>
            <ul className={s.audience}>
              {AUDIENCE.map((a) => (
                <li key={a.title}>
                  <h3>{a.title}</h3>
                  <p>{a.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Calculadora */}
        <section id="calculadora" className={s.section} aria-labelledby="calc-title">
          <div className={s.container}>
            <div className={s.sectionHead}>
              <h2 id="calc-title">Quanto tempo você gasta publicando?</h2>
              <p>Estime o tempo dedicado à publicação manual em um mês típico.</p>
            </div>
            <TimeCalculator />
          </div>
        </section>

        {/* Caso de uso */}
        <section id="exemplo" className={s.section} aria-labelledby="exemplo-title">
          <div className={`${s.container} ${s.split}`}>
            <div>
              <h2 id="exemplo-title" className={s.splitTitle}>
                Uma semana de cortes, organizada em um só lugar.
              </h2>
              <p className={s.lead}>
                Imagine que você gravou um podcast e já separou os melhores trechos. Veja como poderia preparar a programação da semana no ReelsFlow.
              </p>
              <a href="#demonstracao" className={`${s.btn} ${s.btnGhost}`}>
                Explorar calendário interativo ↗
              </a>
            </div>
            <div className={s.card}>
              <span className={s.demoTag}>Exemplo ilustrativo</span>
              <h3 className={s.cardTitle}>Do episódio à programação</h3>
              <ol className={s.numbered}>
                {USE_CASE_STEPS.map((st, i) => (
                  <li key={st.title}>
                    <span className={s.num} aria-hidden>
                      {i + 1}
                    </span>
                    <div>
                      <h4>{st.title}</h4>
                      <p>{st.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Depoimentos ilustrativos */}
        <section id="avaliacoes" className={s.section} aria-labelledby="aval-title">
          <div className={s.container}>
            <div className={s.sectionHead}>
              <h2 id="aval-title">Como o ReelsFlow pode entrar na sua rotina</h2>
            </div>
            <p className={s.notice} role="note">
              Depoimentos fictícios para demonstrar a página. Os nomes, comentários e notas são ilustrativos.
            </p>
            <ul className={s.testimonials}>
              {TESTIMONIALS.map((t) => (
                <li key={t.user} className={s.card}>
                  <div className={s.person}>
                    <span className={s.avatar} aria-hidden>
                      {t.name[0]}
                    </span>
                    <div>
                      <strong>{t.name}</strong>
                      <span className={s.muted}>
                        {t.user} · <span className={s.fictitious}>Perfil fictício</span>
                      </span>
                    </div>
                  </div>
                  <hr className={s.divider} />
                  <span className={s.stars} role="img" aria-label="Nota ilustrativa: 5 de 5 estrelas">
                    ★★★★★
                  </span>
                  <span className={s.role}>{t.role}</span>
                  <blockquote>“{t.text}”</blockquote>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Planos */}
        <section id="planos" className={s.section} aria-labelledby="planos-title">
          <div className={s.container}>
            <div className={s.sectionHead}>
              <h2 id="planos-title">Planos do ReelsFlow</h2>
              <p>
                {billingOn
                  ? "Valores mensais. Assinaturas em modo de teste (sandbox da Stripe): nenhum valor é cobrado. Preços anuais seguem a definir."
                  : "Proposta para teste comercial. Os valores são mensais e as assinaturas ainda não estão abertas."}
              </p>
            </div>
            <ul className={s.plans}>
              {PLANS.map((p) => (
                <li key={p.key} className={p.featured ? `${s.plan} ${s.planFeatured}` : s.plan} data-plan={p.key}>
                  <h3>{p.name}</h3>
                  <p className={s.muted}>{p.audience}</p>
                  <p className={s.price}>
                    {p.price}
                    {p.period && <span>{p.period}</span>}
                  </p>
                  <hr className={s.divider} />
                  <ul className={s.features}>
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {p.key === "starter" ? (
                    <a href="/signup" className={`${s.btn} ${s.btnGhost} ${s.planCta}`}>
                      Começar grátis
                    </a>
                  ) : billingOn ? (
                    <a href={`/billing/start?plan=${p.key}&interval=month`} className={`${s.btn} ${p.featured ? s.btnPrimary : s.btnGhost} ${s.planCta}`}>
                      Assinar {p.name} (teste)
                    </a>
                  ) : (
                    <p className={s.planStatus}>Assinaturas ainda não abertas</p>
                  )}
                </li>
              ))}
            </ul>

            <details className={s.compare}>
              <summary>Comparar todos os benefícios</summary>
              <div className={s.tableWrap} role="region" aria-label="Tabela de comparação dos planos" tabIndex={0}>
                <table>
                  <caption>Limites e benefícios propostos</caption>
                  <thead>
                    <tr>
                      <th scope="col">Benefício</th>
                      {PLANS.map((p) => (
                        <th key={p.key} scope="col">
                          {p.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON.map(([label, ...cells]) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        {cells.map((c, i) => (
                          <td key={i}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className={s.glossary}>
                {GLOSSARY.map((g) => (
                  <div key={g.term}>
                    <dt>{g.term}:</dt> <dd>{g.text}</dd>
                  </div>
                ))}
              </dl>
              <p className={s.muted}>
                As quatro conexões propostas no Business comportam quatro perfis ou canais de uma mesma marca, conforme as integrações disponíveis. Os
                recursos planejados dependem de implementação e homologação. Preços anuais seguem a definir.
              </p>
            </details>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className={s.section} aria-labelledby="faq-title">
          <div className={`${s.container} ${s.narrow}`}>
            <div className={s.sectionHead}>
              <h2 id="faq-title">Perguntas frequentes</h2>
            </div>
            <div className={s.faq}>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA final */}
        <section className={s.finalCta} aria-labelledby="cta-title">
          <div className={s.container}>
            <h2 id="cta-title">Sua próxima semana começa aqui.</h2>
            <p>Explore como uma semana de publicações pode ficar organizada no painel.</p>
            <a href="#demonstracao" className={`${s.btn} ${s.btnPrimary}`}>
              Explorar demonstração ↗
            </a>
          </div>
        </section>
      </main>

      <footer className={s.footer}>
        <div className={`${s.container} ${s.footerInner}`}>
          <Brand size="footer" />
          <span className={s.muted}>Prévia comercial do produto</span>
          <nav aria-label="Rodapé" className={s.footerNav}>
            <a href="#faq">Perguntas frequentes</a>
            <a href="/privacy">Privacidade</a>
            <a href="/terms">Termos</a>
            <a href="/login">Entrar</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
