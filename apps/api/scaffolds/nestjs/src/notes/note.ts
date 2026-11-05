import { IsString, Length } from 'class-validator';

export interface Note {
  readonly id: number;
  readonly text: string;
  readonly createdAt: string;
}

export class CreateNote {
  @IsString()
  @Length(1, 500)
  readonly text!: string;
}
