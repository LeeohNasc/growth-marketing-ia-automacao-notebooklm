import { describe, expect, it } from "vitest";
import { can, canAssignRole, hasAtLeast, isWorkspaceRole, roleRank } from "./roles";

describe("roles", () => {
  it("ordena papéis do menor para o maior", () => {
    expect(roleRank("viewer")).toBeLessThan(roleRank("editor"));
    expect(roleRank("editor")).toBeLessThan(roleRank("admin"));
    expect(roleRank("admin")).toBeLessThan(roleRank("owner"));
  });

  it("hasAtLeast nega quando não há papel", () => {
    expect(hasAtLeast(null, "viewer")).toBe(false);
    expect(hasAtLeast(undefined, "viewer")).toBe(false);
  });

  it("aplica permissões mínimas", () => {
    expect(can("viewer", "viewWorkspace")).toBe(true);
    expect(can("viewer", "editContent")).toBe(false);
    expect(can("editor", "editWorkspaceSettings")).toBe(false);
    expect(can("admin", "manageMembers")).toBe(true);
    expect(can("admin", "deleteWorkspace")).toBe(false);
    expect(can("owner", "deleteWorkspace")).toBe(true);
  });

  it("somente owner concede owner", () => {
    expect(canAssignRole("admin", "editor")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("editor", "viewer")).toBe(false);
  });

  it("valida strings de papel", () => {
    expect(isWorkspaceRole("admin")).toBe(true);
    expect(isWorkspaceRole("superuser")).toBe(false);
    expect(isWorkspaceRole(1)).toBe(false);
  });
});
