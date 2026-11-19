/**
 * Papéis de workspace. A MESMA ordem é aplicada no banco por `app.role_rank`
 * (supabase/migrations). Este módulo serve à UI; a autorização real é a RLS.
 */
export const WORKSPACE_ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: WorkspaceRole): number {
  return WORKSPACE_ROLES.indexOf(role);
}

export function hasAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  if (!role) return false;
  return roleRank(role) >= roleRank(min);
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  viewer: "Leitura",
  editor: "Editor",
  admin: "Administrador",
  owner: "Proprietário",
};

/** Ações sensíveis e o papel mínimo exigido (espelha as policies de RLS). */
export const PERMISSIONS = {
  viewWorkspace: "viewer",
  editContent: "editor",
  editWorkspaceSettings: "admin",
  manageMembers: "admin",
  deleteWorkspace: "owner",
} as const satisfies Record<string, WorkspaceRole>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: WorkspaceRole | null | undefined, permission: Permission): boolean {
  return hasAtLeast(role, PERMISSIONS[permission]);
}

/**
 * Regras de gestão de membros (espelham policies + trigger `guard_last_owner`):
 * - admin gerencia viewer/editor/admin;
 * - somente owner concede, altera ou remove o papel owner.
 */
export function canAssignRole(actor: WorkspaceRole | null | undefined, target: WorkspaceRole): boolean {
  if (!hasAtLeast(actor, "admin")) return false;
  if (target === "owner") return actor === "owner";
  return true;
}
