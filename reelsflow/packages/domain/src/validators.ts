import { z } from "zod";

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Valida identificador IANA usando o ICU do runtime. O banco revalida contra pg_timezone_names. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, { message: "Fuso horário inválido." });

export const emailSchema = z.string().trim().toLowerCase().email({ message: "E-mail inválido." }).max(254);

/** bcrypt (Supabase Auth) ignora bytes após 72; recusamos em vez de truncar silenciosamente. */
export const passwordSchema = z
  .string()
  .min(8, { message: "A senha deve ter pelo menos 8 caracteres." })
  .max(72, { message: "A senha deve ter no máximo 72 caracteres." })
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: "Use letras e números.",
  });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Informe um nome." })
  .max(80, { message: "Máximo de 80 caracteres." });

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(2, { message: "Use pelo menos 2 caracteres." })
  .max(80, { message: "Máximo de 80 caracteres." });

export const signUpSchema = z.object({
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { message: "Informe a senha." }),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "As senhas não coincidem.", path: ["confirm"] });

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  timezone: timezoneSchema,
});

export const updateWorkspaceSchema = createWorkspaceSchema;

export const updateProfileSchema = z.object({
  displayName: displayNameSchema,
  timezone: timezoneSchema,
});

/** Confirmação de exclusão: o usuário digita o próprio e-mail. */
export function deleteAccountSchema(currentEmail: string) {
  return z.object({
    confirmEmail: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === currentEmail.toLowerCase(), { message: "O e-mail digitado não confere." }),
  });
}

/**
 * Caminho de redirecionamento seguro pós-login: aceita apenas caminhos relativos
 * internos (evita open redirect via `?next=https://evil`).
 */
export function safeRedirectPath(next: string | null | undefined, fallback = "/w"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}

/** Converte erros do Zod em mapa campo → primeira mensagem, para formulários. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export const updateMediaSchema = z.object({
  name: z.string().trim().min(1, { message: "Informe um nome." }).max(200, { message: "Máximo de 200 caracteres." }),
  caption: z.string().max(2200, { message: "Máximo de 2.200 caracteres." }),
  hashtags: z.string().max(4000),
});

export const collectionNameSchema = z.string().trim().min(1, { message: "Informe um nome." }).max(80, { message: "Máximo de 80 caracteres." });

/** Termo de busca seguro para ILIKE (escapa curingas). */
export function ilikePattern(term: string): string {
  return `%${term.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
