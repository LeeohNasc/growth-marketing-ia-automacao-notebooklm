// Configuração comum da suíte de homologação (navegação + autenticação).
// Tudo por variáveis de ambiente; nenhum segredo fica no repositório.
//
//   HOMOLOG_SITE   app sob teste            (padrão http://127.0.0.1:3100)
//   HOMOLOG_SB     Supabase LOCAL           (padrão http://127.0.0.1:54321)
//   HOMOLOG_PG     Postgres LOCAL           (padrão postgresql://postgres:postgres@127.0.0.1:54322/postgres)
//   HOMOLOG_KEY    chave publicável LOCAL   (padrão: lida de apps/web/.env.local)
//   HOMOLOG_SEED   arquivo gerado pelo seed (padrão test-homolog/.homolog/seed.json — ignorado pelo git)
//
// Trava de segurança: os scripts que criam usuários, revogam sessões ou mexem no banco só rodam
// contra endereços locais (127.0.0.1 / localhost). Ver assertLocal().
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SITE = process.env.HOMOLOG_SITE ?? "http://127.0.0.1:3100";
const SB = process.env.HOMOLOG_SB ?? "http://127.0.0.1:54321";
const PG = process.env.HOMOLOG_PG ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const STATE_DIR = path.join(__dirname, ".homolog");
const SEED_FILE = process.env.HOMOLOG_SEED ?? path.join(STATE_DIR, "seed.json");

function readKey() {
  if (process.env.HOMOLOG_KEY) return process.env.HOMOLOG_KEY;
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").match(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.*)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("Defina HOMOLOG_KEY (chave publicável do Supabase LOCAL) ou crie apps/web/.env.local.");
}

function isLocal(u) {
  try { return ["127.0.0.1", "localhost"].includes(new URL(u).hostname); } catch { return false; }
}

/** Interrompe se qualquer alvo não for local: estes testes escrevem no banco e revogam sessões. */
function assertLocal() {
  for (const [nome, u] of [["HOMOLOG_SITE", SITE], ["HOMOLOG_SB", SB], ["HOMOLOG_PG", PG.replace(/^postgres(ql)?:/, "http:")]]) {
    if (!isLocal(u)) throw new Error(`${nome}=${u} não é local. Esta suíte só roda contra o ambiente local (dados sintéticos).`);
  }
}

const sql = (q) => execFileSync("psql", [PG, "-qAt", "-v", "ON_ERROR_STOP=1", "-c", q]).toString().trim();
const seed = () => JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));

/** Senha aleatória dos usuários sintéticos desta execução (nunca versionada). */
function testPassword() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const f = path.join(STATE_DIR, "pw.txt");
  if (!fs.existsSync(f)) fs.writeFileSync(f, require("node:crypto").randomBytes(12).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
}

module.exports = { ROOT, SITE, SB, PG, STATE_DIR, SEED_FILE, readKey, isLocal, assertLocal, sql, seed, testPassword };
