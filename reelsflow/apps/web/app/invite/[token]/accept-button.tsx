"use client";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { acceptInvitationAction } from "./actions";

export function AcceptButton({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      {msg && <Alert variant="destructive">{msg}</Alert>}
      <Button disabled={pending} onClick={() => start(async () => setMsg((await acceptInvitationAction(token)).message))}>
        Aceitar convite
      </Button>
    </div>
  );
}
