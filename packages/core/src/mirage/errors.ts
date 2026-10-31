export class MirageError extends Error {
  override name = 'MirageError';
  constructor(
    public code: 'BAD_ITEM' | 'NO_CATALOG' | 'NO_EPISODE' | 'NO_MUSIC_TRACK' | 'NOTHING_MATCHED' | 'DURATION_MISMATCH',
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}
