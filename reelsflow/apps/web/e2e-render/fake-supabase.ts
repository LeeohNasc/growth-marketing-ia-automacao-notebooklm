/**
 * Supabase FALSO para o teste de interface do editor (somente testes). Registra cada chamada e
 * guarda os arquivos enviados, para o teste inspecionar o arquivo final realmente enviado.
 * RLS, storage e worker reais são cobertos pelas suítes de banco/worker com Postgres.
 */
type Row = Record<string, unknown>;
const state = {
  card: null as Row | null,
  storage: new Map<string, Blob>(),
  calls: [] as { op: string; args: unknown }[],
  failNextUpload: false,
  polls: 0,
  mediaSeq: 0,
};
(window as unknown as { __fake: typeof state }).__fake = state;

function tableQuery(table: string) {
  let patch: Row | null = null;
  const q = {
    update(p: Row) {
      patch = p;
      return q;
    },
    select() {
      return q;
    },
    eq() {
      if (patch && table === "editorial_cards" && state.card) {
        state.calls.push({ op: "update:editorial_cards", args: patch });
        const contentChanged = ["page_name", "username", "headline", "format", "media_kind", "fit", "style", "focal", "avatar_path", "media_paths"].some(
          (k) => JSON.stringify(state.card![k]) !== JSON.stringify(patch![k]),
        );
        if (contentChanged && ["ready", "processing"].includes(String(state.card.render_status))) state.card.render_status = "draft";
        Object.assign(state.card, patch);
        patch = null;
        return Promise.resolve({ data: null, error: null });
      }
      return q;
    },
    maybeSingle() {
      if (table === "editorial_cards" && state.card) {
        // simula o worker: ~2 consultas depois do attach, o arquivo final fica pronto
        if (state.card.render_status === "processing" && ++state.polls >= 2) state.card.render_status = "ready";
        return Promise.resolve({ data: { ...state.card }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return q;
}

const client = {
  from: (t: string) => tableQuery(t),
  async rpc(name: string, args: Row) {
    state.calls.push({ op: `rpc:${name}`, args });
    const c = state.card!;
    switch (name) {
      case "set_card_render_state":
        c.render_status = args.p_state;
        c.render_error = args.p_error ?? null;
        return { data: args.p_state, error: null };
      case "begin_media_upload": {
        const f = (args.p_files as Row[])[0]!;
        const id = `00000000-0000-4000-8000-${String(++state.mediaSeq).padStart(12, "0")}`;
        const ext = f.mime === "video/mp4" ? "mp4" : "jpg";
        return { data: [{ media_id: id, storage_path: `${c.workspace_id}/${id}/original.${ext}`, original_filename: f.name }], error: null };
      }
      case "complete_media_upload":
        return { data: "uploaded", error: null };
      case "cancel_media_upload":
        return { data: null, error: null };
      case "attach_card_render":
        c.render_status = "processing";
        c.rendered_media_id = args.p_media;
        state.polls = 0;
        return { data: "processing", error: null };
      default:
        return { data: null, error: { message: `rpc não simulada: ${name}` } };
    }
  },
  storage: {
    from: () => ({
      async upload(path: string, blob: Blob, opts: Row) {
        state.calls.push({ op: "storage:upload", args: { path, size: blob.size, contentType: opts?.contentType } });
        if (state.failNextUpload && path.includes("/original.")) {
          state.failNextUpload = false;
          return { data: null, error: { message: "network" } };
        }
        state.storage.set(path, blob);
        return { data: { path }, error: null };
      },
      // Biblioteca simulada: "lib/<arquivo>" aponta para /fixtures/<arquivo>.
      async createSignedUrl(path: string) {
        state.calls.push({ op: "storage:signed", args: { path } });
        return { data: { signedUrl: `/fixtures/${path.split("/").pop()}` }, error: null };
      },
      async copy(from: string, to: string) {
        state.calls.push({ op: "storage:copy", args: { from, to } });
        const blob = await (await fetch(`/fixtures/${from.split("/").pop()}`)).blob();
        state.storage.set(to, blob);
        return { data: { path: to }, error: null };
      },
    }),
  },
};
export function createClient() {
  return client;
}
