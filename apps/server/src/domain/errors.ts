/**
 * Domain errors that a route turns into a status code.
 *
 * They exist so the domain layer never imports Express: a service says what went wrong, and the
 * HTTP layer alone decides what that is in HTTP.
 */

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFound';
  }
}

export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Conflict';
  }
}

export class Invalid extends Error {
  constructor(
    message: string,
    readonly fields: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'Invalid';
  }
}

/**
 * A 409 that names what is in the way, as fields beside the message: deleting a group that still
 * holds projects answers with the projects (FRM-REQ-227), so the caller can move them without a
 * second request to find out which they were.
 */
export class ConflictWith extends Conflict {
  constructor(
    message: string,
    readonly detail: Readonly<Record<string, readonly string[]>>,
  ) {
    super(message);
    this.name = 'ConflictWith';
  }
}
