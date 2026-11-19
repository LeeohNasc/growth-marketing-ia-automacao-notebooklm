import { describe, expect, it } from "vitest";
import {
  createWorkspaceSchema,
  deleteAccountSchema,
  fieldErrors,
  isValidTimezone,
  passwordSchema,
  resetPasswordSchema,
  safeRedirectPath,
  signUpSchema,
} from "./validators";

describe("timezone", () => {
  it("aceita IANA válidos", () => {
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("Europe/Lisbon")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  it("rejeita inválidos", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("password", () => {
  it("exige tamanho mínimo, letras e números", () => {
    expect(passwordSchema.safeParse("abc123").success).toBe(false);
    expect(passwordSchema.safeParse("abcdefgh").success).toBe(false);
    expect(passwordSchema.safeParse("12345678").success).toBe(false);
    expect(passwordSchema.safeParse("abcd1234").success).toBe(true);
  });
  it("recusa senhas acima de 72 caracteres em vez de truncar", () => {
    expect(passwordSchema.safeParse("a1".repeat(37)).success).toBe(false);
  });
  it("confirmação precisa coincidir", () => {
    const r = resetPasswordSchema.safeParse({ password: "abcd1234", confirm: "abcd12345" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).confirm).toBeDefined();
  });
});

describe("signUp", () => {
  it("normaliza e-mail", () => {
    const r = signUpSchema.parse({ displayName: " Ana ", email: " ANA@Example.com ", password: "abcd1234" });
    expect(r.email).toBe("ana@example.com");
    expect(r.displayName).toBe("Ana");
  });
});

describe("workspace", () => {
  it("valida nome e fuso", () => {
    expect(createWorkspaceSchema.safeParse({ name: "A", timezone: "America/Sao_Paulo" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "Agência X", timezone: "Nowhere/City" }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: "Agência X", timezone: "America/Sao_Paulo" }).success).toBe(true);
  });
});

describe("deleteAccount", () => {
  it("exige e-mail igual ao da conta", () => {
    const s = deleteAccountSchema("ana@example.com");
    expect(s.safeParse({ confirmEmail: "ANA@example.com " }).success).toBe(true);
    expect(s.safeParse({ confirmEmail: "outra@example.com" }).success).toBe(false);
  });
});

describe("safeRedirectPath", () => {
  it("aceita caminhos internos", () => {
    expect(safeRedirectPath("/w/abc/overview")).toBe("/w/abc/overview");
  });
  it("bloqueia open redirect", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/w");
    expect(safeRedirectPath("//evil.com")).toBe("/w");
    expect(safeRedirectPath("/\\evil.com")).toBe("/w");
    expect(safeRedirectPath("/ok\r\nSet-Cookie: x")).toBe("/w");
    expect(safeRedirectPath(null, "/login")).toBe("/login");
  });
});
