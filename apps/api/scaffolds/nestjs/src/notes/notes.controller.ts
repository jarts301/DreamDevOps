import { Body, Controller, Get, Post } from '@nestjs/common';
import { CreateNote, type Note } from './note.js';
import { NotesRepository } from './notes.repository.js';

/** An example resource that uses the database. Replace it with your own. */
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesRepository) {}

  @Get()
  list(): Promise<Note[]> {
    return this.notes.list();
  }

  @Post()
  create(@Body() note: CreateNote): Promise<Note> {
    return this.notes.create(note.text);
  }
}
