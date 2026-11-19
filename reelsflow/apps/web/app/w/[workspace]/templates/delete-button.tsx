"use client";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { deleteTemplateAction } from "./actions";

export function DeleteTemplateButton({ slug, id, name }: { slug: string; id: string; name: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => window.confirm(`Excluir o modelo "${name}"? Campanhas criadas a partir dele não são afetadas.`) && start(() => deleteTemplateAction(slug, id))}
    >
      Excluir
    </Button>
  );
}
