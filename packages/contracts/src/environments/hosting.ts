/** Where an environment runs: a Kubernetes cluster, whose agent connects, or This machine, which the platform runs itself. */
export const HOSTING_PROVIDERS = ['kubernetes', 'local'] as const;
export type HostingProviderKey = (typeof HOSTING_PROVIDERS)[number];

/** This machine: the platform runs applications on its own Docker, for trying things out. */
export const LOCAL_PROVIDER = 'local' satisfies HostingProviderKey;
/** A Kubernetes cluster, whose agent connects and applies the environment's repository. */
export const KUBERNETES_PROVIDER = 'kubernetes' satisfies HostingProviderKey;
