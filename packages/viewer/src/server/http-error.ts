// SPDX-License-Identifier: MIT

/** An error that becomes this HTTP status and `{ error }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
