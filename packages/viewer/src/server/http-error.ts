// SPDX-License-Identifier: AGPL-3.0-or-later

/** An error that becomes this HTTP status and `{ error }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
