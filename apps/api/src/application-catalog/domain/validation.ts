import type { ApplicationType } from './application-type.ts';

const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The length applications store it with. See migration 0007.
const MAX_KEY_LENGTH = 60;

/** A type breaks a rule of the catalog. The API refuses to start until it's fixed. */
export class InvalidApplicationTypeError extends Error {
  constructor(key: string, problem: string) {
    super(`Application type "${key}" ${problem}`);
    this.name = 'InvalidApplicationTypeError';
  }
}

/** The rules every type follows, so tools that build, test and run applications can rely on them. */
export function validateApplicationType(type: ApplicationType): void {
  const fail = (problem: string): never => {
    throw new InvalidApplicationTypeError(type.key, problem);
  };

  if (type.key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(type.key)) {
    fail(`needs a key of up to ${MAX_KEY_LENGTH} lowercase letters and digits, with single hyphens between them.`);
  }
  for (const [field, value] of [
    ['name', type.name],
    ['description', type.description],
    ['language name', type.language.name],
    ['layer name', type.layer.name],
  ] as const) {
    if (value.trim() === '') {
      fail(`needs a ${field}.`);
    }
  }
  if (!KEY_PATTERN.test(type.language.key) || !KEY_PATTERN.test(type.layer.key)) {
    fail('needs a language and a layer whose keys are lowercase letters, digits and hyphens.');
  }
  if (type.frameworks.some((framework) => framework.trim() === '')) {
    fail('lists a framework with no name.');
  }

  for (const [name, command] of Object.entries(type.commands)) {
    if (typeof command !== 'string' || command.trim() === '') {
      fail(`has an empty ${name} command.`);
    }
  }

  if (type.serving.kind === 'process') {
    const { port, healthCheckPath } = type.serving;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      fail('needs a port from 1 to 65535.');
    }
    if (!healthCheckPath.startsWith('/')) {
      fail('needs a health check path that starts with "/".');
    }
    if (type.commands.start === undefined) {
      fail('is served by a process, so it needs a start command.');
    }
  } else {
    const { directory } = type.serving;
    if (directory === '' || directory.startsWith('/') || directory.split('/').includes('..')) {
      fail('needs a build directory inside the repository.');
    }
    if (type.commands.build === undefined) {
      fail('is served as built files, so it needs a build command.');
    }
    if (type.commands.start !== undefined) {
      fail('is served as built files, so it has nothing to start.');
    }
  }

  for (const scaffold of type.scaffolds) {
    if (scaffold.key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(scaffold.key)) {
      fail(`has a scaffold whose key "${scaffold.key}" isn't lowercase letters and digits with single hyphens.`);
    }
    if (scaffold.name.trim() === '' || scaffold.description.trim() === '') {
      fail(`has the scaffold "${scaffold.key}" with no name or description.`);
    }
    if (scaffold.includes.length === 0 || scaffold.includes.some((item) => item.trim() === '')) {
      fail(`has the scaffold "${scaffold.key}" with nothing, or an empty item, in what it includes.`);
    }
  }

  if (type.commands.migrate !== undefined && !type.layer.migrations) {
    fail(`is a ${type.layer.name.toLowerCase()}, which can't own a database, so it can't have migrations.`);
  }
}
