import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller.js';
import { NotesRepository } from './notes.repository.js';

@Module({
  controllers: [NotesController],
  providers: [NotesRepository],
})
export class NotesModule {}
