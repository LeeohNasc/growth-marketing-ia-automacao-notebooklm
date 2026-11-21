"use client";
import { useActionState, useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { MOCK_BEHAVIORS, MOCK_BEHAVIOR_LABELS, type MockBehavior } from "@reelsflow/connectors";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import { createSimulatedAccountAction, deleteAccountAction, disconnectAccountAction, updateAccountAction } from "./actions";

export function CreateSimulatedForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(createSimulatedAccountAction, initialActionState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="slug" value={slug} />
      <div className="sm:col-span-3">
        <FormMessage state={state} />
      </div>
      <Field label="Nome" name="name" placeholder="Ex.: Perfil de teste" error={state.fieldErrors?.name} />
      <div className="grid gap-2">
        <Label htmlFor="behavior">Comportamento simulado</Label>
        <NativeSelect id="behavior" name="behavior" defaultValue="success">
          {MOCK_BEHAVIORS.map((b) => (
            <option key={b} value={b}>
              {MOCK_BEHAVIOR_LABELS[b]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <SubmitButton pendingText="Criando…">Adicionar</SubmitButton>
    </form>
  );
}

type Acc = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  token_expires_at: string | null;
  provider: "native" | "zernio";
  platform: string;
  status: string;
  paused: boolean;
  min_spacing_minutes: number;
  behavior: string | null;
  capabilities: { capability: string; granted: boolean }[];
};

const PLATFORM_NAME: Record<string, string> = { instagram: "Instagram", facebook: "Página do Facebook", mock: "Simulada", tiktok: "TikTok", youtube: "YouTube" };

const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });

export function AccountRow({ slug, acc, canManage, metaEnabled, igEnabled }: { slug: string; acc: Acc; canManage: boolean; metaEnabled: boolean; igEnabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.message ?? "Erro."));
      router.refresh();
    });
  return (
    <li className="grid gap-3 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {acc.avatar_url ? (
          // Foto do perfil vinda do CDN da Meta (URL temporária; atualizada na renovação do token).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={acc.avatar_url} alt="" width={36} height={36} referrerPolicy="no-referrer" className="size-9 rounded-full border object-cover" />
        ) : (
          <span aria-hidden className="grid size-9 place-items-center rounded-full border bg-secondary text-xs font-semibold uppercase">
            {acc.display_name.replace(/^@/, "").slice(0, 1)}
          </span>
        )}
        <span className="grid">
          <span className="font-medium">{acc.display_name}</span>
          {acc.username && <span className="text-xs text-muted-foreground">@{acc.username}</span>}
        </span>
        {acc.status === "active" && acc.platform !== "mock" && <Badge variant="success">Conectada</Badge>}
        {acc.provider === "zernio" && <Badge variant="outline">via Zernio</Badge>}
        <Badge variant={acc.platform === "mock" ? "warning" : "secondary"}>{PLATFORM_NAME[acc.platform] ?? acc.platform}</Badge>
        {acc.status === "needs_reauth" && <Badge variant="outline" className="border-destructive text-destructive">Requer reconexão</Badge>}
        {acc.status === "disconnected" && <Badge variant="outline">Desconectada</Badge>}
        {acc.paused && <Badge variant="secondary">Pausada</Badge>}
      </div>
      {acc.provider === "zernio" && acc.status === "needs_reauth" && (
        <p className="text-xs text-destructive">
          A Zernio informou que esta conta precisa ser reconectada. Reconecte-a no painel da Zernio; o ReelsFlow volta a publicar sozinho em até
          10 minutos.
        </p>
      )}
      {acc.provider === "native" && acc.platform === "instagram" && acc.token_expires_at && acc.status === "active" && (
        <p className="text-xs text-muted-foreground">
          Autorização válida até {dateFmt.format(new Date(acc.token_expires_at))} · renovada automaticamente antes de vencer.
        </p>
      )}
      {acc.capabilities.length > 0 && (
        <ul className="flex flex-wrap gap-1 text-xs" aria-label="Permissões">
          {acc.capabilities.map((c) => (
            <li key={c.capability} className={c.granted ? "rounded bg-success/10 px-1.5 py-0.5 text-success" : "rounded bg-destructive/10 px-1.5 py-0.5 text-destructive"}>
              {c.granted ? "✓" : "✗"} {c.capability}
            </li>
          ))}
        </ul>
      )}
      {canManage && acc.platform !== "mock" && (
        <div className="flex flex-wrap gap-2">
          {acc.provider === "native" &&
            (acc.status !== "active" || acc.capabilities.some((c) => !c.granted)) &&
            (acc.platform === "instagram" ? igEnabled : metaEnabled) && (
              <Button asChild size="sm">
                <a href={acc.platform === "instagram" ? `/api/oauth/instagram/start?w=${slug}` : `/api/oauth/meta/start?w=${slug}&rerequest=1`}>Reconectar</a>
              </Button>
            )}
          {acc.status !== "disconnected" && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => window.confirm(`Desconectar ${acc.display_name}? As credenciais serão apagadas; publicações futuras aguardarão a reconexão.`) && run(() => disconnectAccountAction(slug, acc.id))}
            >
              Desconectar
            </Button>
          )}
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap items-end gap-3">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateAccountAction(slug, acc.id, { paused: !acc.paused }))}>
            {acc.paused ? "Retomar publicações" : "Pausar publicações"}
          </Button>
          <div className="grid gap-1">
            <Label htmlFor={`sp-${acc.id}`} className="text-xs text-muted-foreground">
              Espaçamento mínimo (min)
            </Label>
            <Input
              id={`sp-${acc.id}`}
              type="number"
              min={0}
              max={1440}
              defaultValue={acc.min_spacing_minutes}
              className="h-9 w-28"
              onBlur={(e) => Number(e.target.value) !== acc.min_spacing_minutes && run(() => updateAccountAction(slug, acc.id, { minSpacing: Number(e.target.value) }))}
            />
          </div>
          {acc.platform === "mock" && (
            <div className="grid gap-1">
              <Label htmlFor={`bh-${acc.id}`} className="text-xs text-muted-foreground">
                Comportamento
              </Label>
              <NativeSelect
                id={`bh-${acc.id}`}
                className="h-9 w-auto"
                defaultValue={acc.behavior ?? "success"}
                disabled={pending}
                onChange={(e) => run(() => updateAccountAction(slug, acc.id, { behavior: e.target.value as MockBehavior }))}
              >
                {MOCK_BEHAVIORS.map((b) => (
                  <option key={b} value={b}>
                    {MOCK_BEHAVIOR_LABELS[b]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            disabled={pending}
            onClick={() => window.confirm(`Remover ${acc.display_name}? Publicações futuras desta conta serão canceladas; o histórico é mantido.`) && run(() => deleteAccountAction(slug, acc.id))}
          >
            Remover
          </Button>
        </div>
      )}
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </li>
  );
}
