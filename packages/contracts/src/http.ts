/**
 * What every context's HTTP API shares. Each context's http.ts describes its own API for
 * the dashboard and other clients. Like them, this file holds only types, with no imports,
 * so a browser app can use it.
 *
 * A response may gain fields, which clients ignore until they use them. Removing or
 * renaming a field, or changing what it means, is a breaking change to the API, which needs
 * a new route or version alongside the old one.
 */

/**
 * A request's body as the API receives it, before it checks it: any field may be missing
 * or of any type. The API checks each field itself, and answers 400 when one is wrong.
 * Typing the body this way keeps the field names the client sends and the API reads the same.
 */
export type Unchecked<TRequest> = { readonly [K in keyof TRequest]?: unknown };
