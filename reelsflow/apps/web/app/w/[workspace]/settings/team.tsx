"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { ROLE_LABELS, WORKSPACE_ROLES, canAssignRole, type WorkspaceRole } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeRoleAction, inviteAction, removeMemberAction, revokeInvitationAction } from "./team-actions";

type Member = { userId: string; name: string; role: WorkspaceRole; isMe: boolean };
type Invite = { id: string; email: string; role: WorkspaceRole; expiresAt: string };

export function Team({ slug, myRole, members, invites, seats }: { slug: string; myRole: WorkspaceRole; members: Member[]; invites: Invite[]; seats: { used: number; limit: number } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const manage = canAssignRole(myRole, "viewer");
  const run = (fn: () => Promise<{ ok: boolean; message?: string; link?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.message || !r.ok ? { ok: r.ok, text: r.message ?? "Não foi possível concluir.", link: r.link } : null);
      router.refresh();
    });

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">
        Assentos em uso: {seats.used} de {seats.limit} (membros + convites pendentes).
      </p>
      <ul className="divide-y rounded-lg border">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {m.name || "Sem nome"}
              {m.isMe && <span className="text-muted-foreground"> (você)</span>}
            </span>
            {manage && !m.isMe && canAssignRole(myRole, m.role) ? (
              <>
                <Label htmlFor={`role-${m.userId}`} className="sr-only">
                  Papel de {m.name}
                </Label>
                <NativeSelect id={`role-${m.userId}`} className="h-8 w-auto" value={m.role} disabled={pending} onChange={(e) => run(() => changeRoleAction(slug, m.userId, e.target.value))}>
                  {WORKSPACE_ROLES.filter((r) => canAssignRole(myRole, r)).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => window.confirm(`Remover ${m.name || "este membro"} do workspace?`) && run(() => removeMemberAction(slug, m.userId))}>
                  Remover
                </Button>
              </>
            ) : (
              <Badge variant={m.role === "owner" ? "default" : "secondary"}>{ROLE_LABELS[m.role]}</Badge>
            )}
          </li>
        ))}
      </ul>

      {manage && (
        <>
          {invites.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">Convites pendentes</h3>
              <ul className="divide-y rounded-lg border text-sm">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <Badge variant="outline">{ROLE_LABELS[i.role]}</Badge>
                    <span className="text-xs text-muted-foreground">expira {new Date(i.expiresAt).toLocaleDateString("pt-BR")}</span>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeInvitationAction(slug, i.id))}>
                      Revogar
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const r = await inviteAction(slug, email, role);
                if (r.ok) setEmail("");
                return r;
              });
            }}
          >
            <div className="grid min-w-56 flex-1 gap-1">
              <Label htmlFor="invite-email">Convidar por e-mail</Label>
              <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@empresa.com" required />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="invite-role">Papel</Label>
              <NativeSelect id="invite-role" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className="w-auto">
                {WORKSPACE_ROLES.filter((r) => canAssignRole(myRole, r)).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={pending || !email}>
              Criar convite
            </Button>
          </form>
        </>
      )}

      {msg && (
        <div role="status" className={msg.ok ? "grid gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm" : "text-sm text-destructive"}>
          <p>{msg.text}</p>
          {msg.link && (
            <div className="flex items-center gap-2">
              <Input readOnly value={msg.link} aria-label="Link do convite" className="h-8 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button type="button" size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(msg.link!)}>
                <Copy /> Copiar
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
