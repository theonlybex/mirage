export class SidecarError extends Error {
  override name = 'SidecarError';
  constructor(
    public tool: string,
    public code: 'NOT_FOUND' | 'EXIT' | 'TIMEOUT' | 'PARSE',
    message: string,
    public hint: string,
    public stderr = '',
  ) {
    super(message);
  }
}
