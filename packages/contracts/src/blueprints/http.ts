/** Blueprints' HTTP API, as the dashboard sees it. Types only, so a browser app can use them. */

/** What a blueprint version defines, read from its blueprint.json. */
export interface BlueprintManifest {
  readonly key: string;
  readonly version: string;
  readonly applicationType: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly framework: string;
  readonly runtime: {
    readonly port: number;
    readonly livenessPath: string;
    readonly readinessPath: string;
    readonly resources: { readonly cpu: string; readonly memory: string };
    readonly configuration: string;
  };
  readonly telemetry: string;
  readonly pipeline: string;
  readonly strategies: readonly string[];
}
