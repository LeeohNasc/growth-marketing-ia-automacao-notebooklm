/**
 * Graph API falsa para testes: rotas "MÉTODO caminho" → respostas em sequência.
 * Registra cada chamada (sem expor tokens) para asserções.
 */
export type FakeResponse = { status?: number; body: unknown; headers?: Record<string, string> } | Error;
type Route = { method: string; match: (path: string) => boolean; responses: FakeResponse[]; repeatLast: boolean };

export class FakeGraph {
  readonly calls: { method: string; host: string; path: string; params: Record<string, string>; headers: Record<string, string> }[] = [];
  private routes: Route[] = [];

  on(method: string, path: string | RegExp, ...responses: FakeResponse[]) {
    const match = typeof path === "string" ? (p: string) => p === path : (p: string) => path.test(p);
    this.routes.push({ method, match, responses, repeatLast: true });
    return this;
  }

  count(method: string, path: string | RegExp) {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))).length;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "").replace(/^\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (init?.body) Object.assign(params, Object.fromEntries(new URLSearchParams(String(init.body))));
    const headers = { ...(init?.headers as Record<string, string>) };
    this.calls.push({ method, host: url.host, path: `${url.host === "rupload.facebook.com" ? "rupload:" : ""}${path}`, params, headers });
    const key = `${url.host === "rupload.facebook.com" ? "rupload:" : ""}${path}`;
    const route = this.routes.find((r) => r.method === method && r.match(key));
    if (!route) return new Response(JSON.stringify({ error: { message: `rota não simulada: ${method} ${key}`, code: 100 } }), { status: 400 });
    const r = route.responses.length > 1 || !route.repeatLast ? route.responses.shift()! : route.responses[0]!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
}
