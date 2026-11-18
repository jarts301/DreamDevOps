/** The roles a company member can have, by key, with the names people know them by. */
export const ROLE_NAMES: Readonly<Record<string, string>> = {
  'company-admin': 'Company Admin',
  'tech-lead': 'Tech Lead',
  developer: 'Developer',
  operator: 'Operator',
  viewer: 'Viewer',
};

/** A role's name, such as "Tech Lead", or its key when it's one this version doesn't know. */
export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}
