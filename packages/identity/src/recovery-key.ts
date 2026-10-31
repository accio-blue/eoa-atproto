/**
 * A real P-256 `did:key` whose private half is held by nobody - it is a public
 * key, and its secret cannot be recovered from it.
 *
 * A directory will not mint without an operator recovery key (`dhs6`): listing
 * one is what makes a move undoable, and a single-key account is an account
 * nobody can ever recover. A test that builds a directory has no operator of its
 * own, so it names this one: listing it means "recoverable by nobody", which is
 * the honest answer and not a secret to leak.
 *
 * Shared rather than copied for the reason `@eoa/smtp`'s test certificate is:
 * six test files across four packages configure a directory, and a duplicated
 * literal is how they drift apart.
 *
 * ponytail: it lives in `src`, so it ships in `dist` - same as that certificate.
 * Move it out when the build learns to exclude a file.
 */
export const TEST_RECOVERY_ROTATION_KEY =
  'did:key:zDnaeh9v2RmcMo13Du2d6pjUf5bZwtauYxj3n9dYjw4EZUAR7';
