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
  platform: string;
  status: string;
  paused: boolean;
  min_spacing_minutes: number;
  behavior: string | null;
  capabilities: { capability: string; granted: boolean }[];
};

const PLATFORM_NAME: Record<string, string> = { instagram: "Instagram", facebook: "Página do Facebook", mock: "Simulada", tiktok: "TikTok", youtube: "YouTube" };

export function AccountRow({ slug, acc, canManage, metaEnabled }: { slug: string; acc: Acc; canManage: boolean; metaEnabled: boolean }) {
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
        <span className="font-medium">{acc.display_name}</span>
        <Badge variant={acc.platform === "mock" ? "warning" : "secondary"}>{PLATFORM_NAME[acc.platform] ?? acc.platform}</Badge>
        {acc.status === "needs_reauth" && <Badge variant="outline" className="border-destructive text-destructive">Requer reconexão</Badge>}
        {acc.status === "disconnected" && <Badge variant="outline">Desconectada</Badge>}
        {acc.paused && <Badge variant="secondary">Pausada</Badge>}
      </div>
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
          {metaEnabled && (acc.status !== "active" || acc.capabilities.some((c) => !c.granted)) && (
            <Button asChild size="sm">
              <a href={`/api/oauth/meta/start?w=${slug}&rerequest=1`}>Reconectar</a>
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
