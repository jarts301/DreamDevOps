import { Test } from '@nestjs/testing';
import { NotesController } from './notes.controller.js';
import { NotesRepository } from './notes.repository.js';

const NOTE = {
  id: 1,
  text: 'Remember the milk',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('NotesController', () => {
  let controller: NotesController;
  const repository = { list: vi.fn(), create: vi.fn() };

  beforeEach(async () => {
    repository.list.mockResolvedValue([NOTE]);
    repository.create.mockResolvedValue(NOTE);
    const module = await Test.createTestingModule({
      controllers: [NotesController],
      providers: [{ provide: NotesRepository, useValue: repository }],
    }).compile();
    controller = module.get(NotesController);
  });

  it('lists notes', async () => {
    await expect(controller.list()).resolves.toEqual([NOTE]);
  });

  it('creates a note', async () => {
    await expect(
      controller.create({ text: 'Remember the milk' }),
    ).resolves.toEqual(NOTE);
    expect(repository.create).toHaveBeenCalledWith('Remember the milk');
  });
});
