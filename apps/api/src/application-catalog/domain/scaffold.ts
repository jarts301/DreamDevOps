/** A starting point for an application: a project that already installs, lints, tests, builds and runs. */
export interface Scaffold {
  /** Stored with each application, so it never changes once published. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** What the project comes with, such as its test runner. */
  readonly includes: readonly string[];
}

export function defineScaffold(scaffold: Scaffold): Scaffold {
  return scaffold;
}

/** What a scaffold is filled in with, for one application. */
export interface ScaffoldVariables {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
}

export interface ScaffoldFile {
  /** Relative to the repository's root, with "/" between folders. */
  readonly path: string;
  readonly content: string;
}

/** A template breaks a rule of scaffolds. Tests find these before any application does. */
export class ScaffoldTemplateError extends Error {
  constructor(path: string, problem: string) {
    super(`Scaffold file "${path}" ${problem}`);
    this.name = 'ScaffoldTemplateError';
  }
}

const PLACEHOLDER = /__APP_[A-Z]+__/g;

/**
 * Names and descriptions can hold any character, so they go only where they can be
 * escaped exactly. Code reads them from a JSON file, so no name can break it.
 */
const ESCAPE_TEXT: Readonly<Record<string, (value: string) => string>> = {
  '.json': (value) => JSON.stringify(value).slice(1, -1),
  '.html': escapeHtml,
  '.md': escapeMarkdown,
};

/** Fills in one template file. The slug is always safe, because it's only letters, digits and hyphens. */
export function renderScaffoldFile(path: string, template: string, variables: ScaffoldVariables): string {
  const extension = /\.[^./]+$/.exec(path)?.[0] ?? '';
  const escapeText = ESCAPE_TEXT[extension];
  return template.replace(PLACEHOLDER, (placeholder) => {
    switch (placeholder) {
      case '__APP_SLUG__':
        return variables.slug;
      case '__APP_NAME__':
      case '__APP_DESCRIPTION__': {
        if (escapeText === undefined) {
          throw new ScaffoldTemplateError(
            path,
            `uses ${placeholder}, which only .json, .html and .md files may use. Read it from about.json instead.`,
          );
        }
        return escapeText(placeholder === '__APP_NAME__' ? variables.name : variables.description);
      }
      default:
        throw new ScaffoldTemplateError(path, `uses ${placeholder}, which isn't a placeholder.`);
    }
  });
}

/**
 * A name is plain text, so anything Markdown would read as formatting is escaped. That
 * also keeps formatters such as Prettier from rewriting it.
 */
function escapeMarkdown(value: string): string {
  return value
    .replaceAll('\t', ' ')
    .replaceAll('&', '&amp;')
    .replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
