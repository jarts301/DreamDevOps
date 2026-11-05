import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type pg from 'pg';
import { DATABASE, type Database } from '../database/database.module.js';
import type { Note } from './note.js';

interface NoteRow {
  id: number;
  text: string;
  created_at: Date;
}

/** Notes live in the table that migrations/0001_create-notes.sql creates. */
@Injectable()
export class NotesRepository {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(): Promise<Note[]> {
    const { rows } = await this.#pool().query<NoteRow>(
      'SELECT id, text, created_at FROM notes ORDER BY created_at DESC, id DESC LIMIT 100',
    );
    return rows.map(toNote);
  }

  async create(text: string): Promise<Note> {
    const { rows } = await this.#pool().query<NoteRow>(
      'INSERT INTO notes (text) VALUES ($1) RETURNING id, text, created_at',
      [text],
    );
    return toNote(rows[0]!);
  }

  #pool(): pg.Pool {
    if (this.database === null) {
      throw new ServiceUnavailableException(
        'Notes need a database. Set DATABASE_URL and run npm run migrate.',
      );
    }
    return this.database;
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at.toISOString(),
  };
}
