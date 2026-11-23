#!/usr/bin/env python3
"""
Gera a migration de otimização do RLS (e o rollback) a partir das políticas REAIS do banco.

Troca cada `app.has_role(<expr>, '<papel>'::workspace_role)` — avaliado uma vez POR LINHA — por
`COALESCE((<expr>) IN (SELECT app.member_workspace_ids('<papel>'::public.workspace_role)), false)`,
em que a lista de workspaces do usuário é calculada UMA vez por consulta (hashed SubPlan).
O COALESCE mantém o resultado idêntico a has_role quando <expr> é nulo (has_role devolve false).

Uso: python3 scripts/gen-rls-migration.py "<url do banco com o esquema atual>" <saida_up.sql> <saida_down.sql>
"""
import json
import subprocess
import sys

url, out_up, out_down = sys.argv[1], sys.argv[2], sys.argv[3]

rows = json.loads(subprocess.check_output([
    "psql", url, "-qAt", "-c",
    """select coalesce(json_agg(json_build_object('schema', schemaname, 'table', tablename, 'name', policyname, 'cmd', cmd,
                                               'qual', qual, 'check', with_check) order by schemaname, tablename, policyname), '[]')
         from pg_policies
        where qual ilike '%has_role(%' or with_check ilike '%has_role(%'""",
]))

NEEDLE = "app.has_role("


def rewrite(expr: str | None) -> str | None:
    if expr is None:
        return None
    out, i = [], 0
    while True:
        j = expr.find(NEEDLE, i)
        if j < 0:
            out.append(expr[i:])
            return "".join(out)
        out.append(expr[i:j])
        k, depth, comma, quote = j + len(NEEDLE), 1, -1, False
        while depth:
            ch = expr[k]
            if ch == "'" :
                quote = not quote
            elif not quote:
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                elif ch == "," and depth == 1:
                    comma = k
            k += 1
        inner_end = k - 1  # posição do ')' que fecha has_role
        arg = expr[j + len(NEEDLE):comma].strip()
        role = expr[comma + 1:inner_end].strip()
        if not role.startswith("'") or "::" not in role:
            raise SystemExit(f"papel inesperado em: {expr[j:k]}")
        role_lit = role.split("::")[0]
        out.append(f"COALESCE(({rewrite(arg)}) IN ( SELECT app.member_workspace_ids({role_lit}::public.workspace_role)), false)")
        i = k


def ident(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def alter(r: dict, qual: str | None, check: str | None) -> str:
    parts = [f"alter policy {ident(r['name'])} on {r['schema']}.{ident(r['table'])}"]
    if qual is not None:
        parts.append(f"  using ({qual})")
    if check is not None:
        parts.append(f"  with check ({check})")
    return "\n".join(parts) + ";"


tables = sorted({(r["schema"], r["table"]) for r in rows})
header = f"""-- ReelsFlow · Otimização do RLS ({len(rows)} políticas em {len(tables)} tabelas). GERADO por scripts/gen-rls-migration.py.
--
-- Antes: app.has_role(workspace_id, papel) era avaliada UMA VEZ POR LINHA (função SECURITY DEFINER não é
-- "inlinável"), com uma busca em workspace_members a cada linha — custo linear no tamanho do workspace.
-- Agora: app.member_workspace_ids(papel) devolve os workspaces do usuário e é calculada UMA vez por consulta.
-- Semântica preservada: mesma regra de papel (role_rank >= mínimo), mesmo usuário (auth.uid()), e
-- COALESCE(..., false) reproduz o "false" de has_role quando o workspace é nulo. Demais condições de cada
-- política (deleted_at, created_by, status, caminhos de Storage...) ficam exatamente como estavam.
-- app.has_role continua existindo (usada por funções RPC); nenhuma tabela, dado ou permissão de coluna muda.
-- As definições ANTERIORES ficam guardadas em app.rls_policy_backup_16 (usadas pelo rollback e pelos testes).
"""

up = [header, """
create table if not exists app.rls_policy_backup_16 (
  schemaname text not null, tablename text not null, policyname text not null, cmd text not null,
  qual text, with_check text, saved_at timestamptz not null default now(),
  primary key (schemaname, tablename, policyname)
);
revoke all on app.rls_policy_backup_16 from public;
insert into app.rls_policy_backup_16 (schemaname, tablename, policyname, cmd, qual, with_check)
select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies
 where qual ilike '%has_role(%' or with_check ilike '%has_role(%'
on conflict do nothing;

-- Workspaces em que o usuário atual tem pelo menos `min_role` (mesma regra de app.has_role).
create or replace function app.member_workspace_ids(min_role public.workspace_role)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.workspace_id from public.workspace_members m
   where m.user_id = (select auth.uid()) and app.role_rank(m.role) >= app.role_rank(min_role)
$$;
revoke all on function app.member_workspace_ids(public.workspace_role) from public, anon;
grant execute on function app.member_workspace_ids(public.workspace_role) to authenticated;
"""]
down = [f"-- ROLLBACK da otimização do RLS: restaura as {len(rows)} políticas EXATAMENTE como eram (texto gerado do banco).\n-- Não toca em dados. Pode ser executado com segurança a qualquer momento.\n"]
for r in rows:
    up.append(f"-- {r['schema']}.{r['table']} [{r['cmd']}]\n" + alter(r, rewrite(r["qual"]), rewrite(r["check"])))
    down.append(alter(r, r["qual"], r["check"]))
down.append("drop function if exists app.member_workspace_ids(public.workspace_role);\ndrop table if exists app.rls_policy_backup_16;")
open(out_up, "w").write("\n\n".join(up) + "\n")
open(out_down, "w").write("\n\n".join(down) + "\n")
print(f"{len(rows)} políticas em {len(tables)} tabelas → {out_up} / {out_down}")
