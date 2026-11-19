"use client";
import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/form";
import { Badge } from "@/components/ui/badge";
import { initialActionState } from "@/lib/action-state";
import { finalizeConnectionAction } from "../actions";

export type Candidate = { key: string; platform: "facebook" | "instagram"; name: string; avatar_url: string | null; can_publish: boolean; missing_scopes: string[] };

export function ConnectForm({ slug, state, candidates }: { slug: string; state: string; candidates: Candidate[] }) {
  const [res, action] = useActionState(finalizeConnectionAction, initialActionState);
  return (
    <form action={action} className="grid gap-4">
      <FormMessage state={res} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="state" value={state} />
      <ul className="divide-y rounded-lg border">
        {candidates.map((c) => (
          <li key={c.key} className="flex items-start gap-3 px-4 py-3 text-sm">
            <input type="checkbox" name="keys" value={c.key} defaultChecked={c.can_publish} disabled={!c.can_publish} id={c.key} className="mt-1 size-4 accent-[var(--primary)]" />
            <label htmlFor={c.key} className="grid flex-1 gap-1">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {c.name}
                <Badge variant="secondary">{c.platform === "instagram" ? "Instagram" : "Página do Facebook"}</Badge>
              </span>
              {!c.can_publish && (
                <span className="text-xs text-warning">
                  {c.missing_scopes.length
                    ? `Permissões não concedidas: ${c.missing_scopes.join(", ")}. Reconecte e aceite todas as permissões.`
                    : "Seu papel nesta Página não permite publicar (requer a tarefa CREATE_CONTENT)."}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <SubmitButton className="justify-self-start" pendingText="Conectando…">
        Conectar selecionadas
      </SubmitButton>
    </form>
  );
}
