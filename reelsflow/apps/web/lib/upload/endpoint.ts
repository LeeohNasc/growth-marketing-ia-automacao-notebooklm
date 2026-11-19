/**
 * Endpoint TUS do Supabase Storage. Para projetos hospedados, a documentação
 * recomenda o host direto de storage (`<ref>.storage.supabase.co`); para
 * outras URLs (ex.: local), usa o caminho padrão.
 */
export function tusEndpoint(supabaseUrl: string): string {
  const u = new URL(supabaseUrl);
  const m = u.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (m) return `https://${m[1]}.storage.supabase.co/storage/v1/upload/resumable`;
  return `${u.origin}/storage/v1/upload/resumable`;
}
