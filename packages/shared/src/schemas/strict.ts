import { z } from 'zod';

/**
 * An object schema that rejects keys it does not know, naming them and the valid keys: a misspelled key in a file people
 * edit (e.g. "speeed") would otherwise be ignored and then deleted by the next save.
 */
export const strictObject = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape, {
    error: (iss) =>
      iss.code === 'unrecognized_keys'
        ? `unknown key${iss.keys.length > 1 ? 's' : ''} ${iss.keys.map((k) => `"${k}"`).join(', ')} (valid keys: ${Object.keys(shape).join(', ')})`
        : undefined,
  });
