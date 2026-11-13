import { type Check, failed, passed } from '../../shared/progress.ts';

export interface Instruction {
  /** The line the instruction starts on, counting from 1. */
  readonly line: number;
  /** In upper case, such as FROM. */
  readonly keyword: string;
  readonly args: string;
}

const DIRECTIVE = /^#\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(.*?)\s*$/;
const HEREDOC = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const REMOTE_SOURCE = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/)/i;
const SECRET_NAME = /(^|_)(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)($|_)/i;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+]([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Splits a Dockerfile into instructions the way Docker reads it: parser directives,
 * comments, line continuations, a custom escape character and here-documents.
 */
export function parseDockerfile(text: string): Instruction[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let escape = '\\';
  let index = 0;

  // Parser directives come first, before any comment, blank line or instruction.
  for (; index < lines.length; index += 1) {
    const match = DIRECTIVE.exec(lines[index]!);
    if (match === null) {
      break;
    }
    if (match[1]!.toLowerCase() === 'escape' && (match[2] === '`' || match[2] === '\\')) {
      escape = match[2];
    }
  }

  const instructions: Instruction[] = [];
  while (index < lines.length) {
    let start = index;
    let logical = '';
    for (; index < lines.length; index += 1) {
      const raw = lines[index]!;
      const trimmed = raw.trim();
      // Comments and blank lines may sit between continued lines. They don't end the instruction.
      if (trimmed.startsWith('#') || (trimmed === '' && logical !== '')) {
        continue;
      }
      if (logical === '') {
        start = index;
      }
      const continued = trimmed.endsWith(escape);
      logical += `${continued ? trimmed.slice(0, -1) : trimmed} `;
      if (!continued) {
        index += 1;
        break;
      }
    }
    const content = logical.trim();
    if (content === '') {
      continue;
    }
    const [keyword = '', ...rest] = content.split(/\s+/);
    const args = rest.join(' ');
    instructions.push({ line: start + 1, keyword: keyword.toUpperCase(), args });

    // Skip the bodies of here-documents, which aren't instructions.
    for (const [, dash, , terminator] of args.matchAll(HEREDOC)) {
      for (; index < lines.length; index += 1) {
        const body = dash === '-' ? lines[index]!.replace(/^\t+/, '') : lines[index]!;
        if (body === terminator) {
          index += 1;
          break;
        }
      }
    }
  }
  return instructions;
}

/** Splits arguments into flags, such as --platform=linux/amd64, and the rest. */
function splitFlags(args: string): { flags: string[]; words: string[] } {
  const flags: string[] = [];
  const words: string[] = [];
  for (const token of args.split(/\s+/).filter((part) => part !== '')) {
    if (words.length === 0 && token.startsWith('--')) {
      flags.push(token);
    } else {
      words.push(token);
    }
  }
  return { flags, words };
}

/** Fills in ARG defaults declared before the first FROM, which is all FROM can use. */
function substitute(value: string, globals: ReadonlyMap<string, string | null>): string | null {
  let unresolved = false;
  const result = value.replace(VARIABLE, (_match, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare)!;
    const found = globals.get(name);
    if (found !== undefined && found !== null && found !== '') {
      return found;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    unresolved = true;
    return '';
  });
  return unresolved ? null : result;
}

function argumentNames(keyword: 'ARG' | 'ENV', args: string): string[] {
  if (keyword === 'ARG') {
    return args
      .split(/\s+/)
      .filter((part) => part !== '')
      .map((part) => part.split('=')[0]!);
  }
  // ENV takes KEY=value pairs, or the older "ENV KEY value" form.
  const first = args.split(/\s+/)[0] ?? '';
  if (!first.includes('=')) {
    return first === '' ? [] : [first];
  }
  return [...args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]*)=/g)].map((match) => match[1]!);
}

/**
 * Checks a Dockerfile against the platform's rules before anything is built:
 *
 * - Every base image is pinned by digest, so a build always uses the same base.
 * - Files downloaded with ADD are checked against a checksum.
 * - No build argument or environment variable looks like a secret, since both stay in
 *   the image for anyone who pulls it.
 */
export function checkDockerfile(text: string): Check[] {
  const instructions = parseDockerfile(text);
  const checks: Check[] = [];

  const globals = new Map<string, string | null>();
  for (const instruction of instructions) {
    if (instruction.keyword === 'FROM') {
      break;
    }
    if (instruction.keyword === 'ARG') {
      for (const part of instruction.args.split(/\s+/).filter((word) => word !== '')) {
        const [name, ...value] = part.split('=');
        globals.set(name!, value.length === 0 ? null : value.join('=').replace(/^(["'])(.*)\1$/, '$2'));
      }
    }
  }

  const stages = new Set<string>();
  const unpinned: string[] = [];
  let baseImages = 0;
  for (const instruction of instructions.filter((candidate) => candidate.keyword === 'FROM')) {
    const { words } = splitFlags(instruction.args);
    const reference = words[0] ?? '';
    const alias = words[1]?.toUpperCase() === 'AS' ? words[2]?.toLowerCase() : undefined;
    const image = substitute(reference, globals);
    if (image === null) {
      unpinned.push(`${reference} on line ${instruction.line} uses a build argument without a default`);
    } else if (image.toLowerCase() !== 'scratch' && !stages.has(image.toLowerCase())) {
      baseImages += 1;
      if (!DIGEST.test(image)) {
        unpinned.push(`${image} on line ${instruction.line}`);
      }
    }
    if (alias !== undefined) {
      stages.add(alias);
    }
  }
  if (instructions.every((instruction) => instruction.keyword !== 'FROM')) {
    checks.push(failed('The Dockerfile has a base image', 'Add a FROM instruction.'));
  } else if (unpinned.length > 0) {
    checks.push(
      failed(
        'Base images are pinned by digest',
        `Not pinned: ${unpinned.join('; ')}. Add @sha256:<digest> to each, so every build uses the same base.`,
      ),
    );
  } else {
    checks.push(
      passed(
        'Base images are pinned by digest',
        baseImages === 0 ? 'The image starts from scratch.' : `${baseImages} base image${baseImages === 1 ? '' : 's'}, all pinned.`,
      ),
    );
  }

  const unchecked: string[] = [];
  for (const instruction of instructions.filter((candidate) => candidate.keyword === 'ADD')) {
    const { flags, words } = splitFlags(instruction.args);
    const sources = words.slice(0, -1);
    if (sources.some((source) => REMOTE_SOURCE.test(source)) && !flags.some((flag) => flag.startsWith('--checksum='))) {
      unchecked.push(`line ${instruction.line}`);
    }
  }
  checks.push(
    unchecked.length === 0
      ? passed('Downloaded files are checked', null)
      : failed(
          'Downloaded files are checked',
          `ADD downloads a file without --checksum on ${unchecked.join(', ')}, so its content could change between builds.`,
        ),
  );

  const secrets: string[] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === 'ARG' || instruction.keyword === 'ENV') {
      for (const name of argumentNames(instruction.keyword, instruction.args)) {
        if (SECRET_NAME.test(name)) {
          secrets.push(`${instruction.keyword} ${name} on line ${instruction.line}`);
        }
      }
    }
  }
  checks.push(
    secrets.length === 0
      ? passed('No secrets in build arguments or environment variables', null)
      : failed(
          'No secrets in build arguments or environment variables',
          `${secrets.join('; ')}. Both stay in the image, so pass secrets with RUN --mount=type=secret instead.`,
        ),
  );

  return checks;
}
