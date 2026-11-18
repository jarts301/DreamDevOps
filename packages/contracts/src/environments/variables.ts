/** What the platform tells every application about where it runs. */
export function platformVariables(
  environment: { readonly slug: string; readonly production: boolean },
  version: string,
): Record<string, string> {
  return {
    DREAMDEVOPS_ENVIRONMENT: environment.slug,
    DREAMDEVOPS_PRODUCTION: String(environment.production),
    DREAMDEVOPS_VERSION: version,
  };
}
