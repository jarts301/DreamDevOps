import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { Authenticated, RequirePermissions } from '../../http/access.decorators.ts';
import type { ApiRequest } from '../../http/request.ts';
import { EnvironmentVariables } from '../application/environment-variables.ts';

/** Company Admins, Tech Leads and Operators manage environments, and so their variables. */
const MANAGE_ENVIRONMENTS = 'environments:manage';

type Body = Record<string, unknown> | undefined;

/**
 * Every member can see an environment's variables, and which secrets it has, but never a
 * secret's value. Changing production's also needs the permission to manage production,
 * which the service checks, with its name typed and a reason.
 */
@Controller('company')
export class VariablesController {
  readonly #variables: EnvironmentVariables;

  constructor(@Inject(EnvironmentVariables) variables: EnvironmentVariables) {
    this.#variables = variables;
  }

  @Authenticated()
  @Get('environments/:id/variables')
  list(@Param('id') id: string): Promise<object[]> {
    return this.#variables.list(id);
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Post('environments/:id/variables')
  add(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: Body): Promise<object> {
    return this.#variables.add(request.principal!, id, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Patch('variables/:variableId')
  change(@Req() request: ApiRequest, @Param('variableId') variableId: string, @Body() body: Body): Promise<object> {
    return this.#variables.change(request.principal!, variableId, body ?? {});
  }

  @RequirePermissions(MANAGE_ENVIRONMENTS)
  @Delete('variables/:variableId')
  @HttpCode(204)
  async remove(@Req() request: ApiRequest, @Param('variableId') variableId: string, @Body() body: Body): Promise<void> {
    await this.#variables.remove(request.principal!, variableId, body ?? {});
  }
}
