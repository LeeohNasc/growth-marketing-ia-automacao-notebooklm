/** Seção recolhida com informações técnicas (para diagnóstico); fechada por padrão. */
export function TechDetails({ children, label = "Detalhes técnicos" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{label}</summary>
      <div className="mt-2 grid gap-1">{children}</div>
    </details>
  );
}
