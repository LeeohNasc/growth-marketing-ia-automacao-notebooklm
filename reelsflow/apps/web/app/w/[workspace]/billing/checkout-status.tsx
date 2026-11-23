"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Status = { plan: string; status: string; provider_status: string | null };

/**
 * Retorno do Stripe Checkout. NÃO altera nada: só consulta (autenticado) o estado que o webhook
 * gravou no servidor, até o plano mudar ou o tempo esgotar. O usuário pode atualizar à mão.
 */
export function CheckoutStatus({ workspaceId, initialPlan, labels }: { workspaceId: string; initialPlan: string; labels: Record<string, string> }) {
  const [state, setState] = useState<"waiting" | "done" | "pending" | "timeout" | "error">("waiting");
  const [plan, setPlan] = useState(initialPlan);
  const tries = useRef(0);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/api/billing/status?workspace=${workspaceId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const s = (await res.json()) as Status;
      setPlan(s.plan);
      if (s.plan !== "starter" && s.plan !== initialPlan) return setState("done"), true;
      if (s.provider_status === "active" && s.plan !== "starter") return setState("done"), true;
      if (s.provider_status === "incomplete") setState("pending");
      return false;
    } catch {
      setState("error");
      return false;
    }
  }, [workspaceId, initialPlan]);

  useEffect(() => {
    if (state === "done") return;
    const t = setInterval(async () => {
      tries.current += 1;
      if ((await check()) || tries.current >= 40) {
        clearInterval(t);
        if (tries.current >= 40) setState((s) => (s === "done" ? s : "timeout"));
      }
    }, 3000);
    const first = setTimeout(() => void check(), 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "done") {
    return (
      <Alert variant="success">
        Pagamento confirmado pelo servidor. Plano {labels[plan] ?? plan} ativo neste workspace.{" "}
        <button type="button" className="underline" onClick={() => window.location.assign(window.location.pathname)}>
          Atualizar a página
        </button>
      </Alert>
    );
  }
  return (
    <Alert aria-live="polite">
      <div className="flex flex-wrap items-center gap-3">
        {state === "waiting" && <Loader2 className="size-4 animate-spin" aria-hidden />}
        <span className="flex-1">
          {state === "waiting" && "Confirmando pagamento… aguardando a confirmação da Stripe ao nosso servidor."}
          {state === "pending" && "Pagamento pendente. O plano será liberado quando a Stripe confirmar o pagamento."}
          {state === "timeout" && "A confirmação ainda não chegou. Isso pode levar alguns minutos; atualize mais tarde."}
          {state === "error" && "Não foi possível consultar o estado agora."}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void check()}>
          <RefreshCw /> Atualizar
        </Button>
      </div>
    </Alert>
  );
}
