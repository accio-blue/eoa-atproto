import { Schema } from 'effect';

// The directory's handle bindings. At most ONE account holds a handle at a
// time; a handle may be transferred, but only as an EXPLICIT new binding
// recorded in the account's chain — there is no silent takeover, and an old
// binding is superseded rather than deleted (history stays replayable).
//
// This is the pure policy. The registry that stores bindings lands with the
// custodial binding milestone (M5); the shape and the rules are fixed here so
// that milestone has nothing to decide.

export const HandleBinding = Schema.Struct({
  handle: Schema.String,
  account: Schema.String,
  seq: Schema.Int,
});

export type HandleBinding = Schema.Schema.Type<typeof HandleBinding>;

/** The current holder of a handle: the highest-`seq` binding, if any. */
export const latestHandleBinding = (
  bindings: readonly HandleBinding[],
  handle: string,
) =>
  bindings.reduce<HandleBinding | undefined>((latest, binding) => {
    if (binding.handle !== handle) {
      return latest;
    }
    return latest === undefined || binding.seq > latest.seq ? binding : latest;
  }, undefined);

export type HandleBindingAction = 'bind' | 'noop' | 'transfer';

/**
 * What a proposed binding means: a first bind, a no-op re-statement, or an
 * explicit TRANSFER to a different account (which the caller records as a new
 * binding op, never by rewriting the previous one).
 */
export const planHandleBinding = (
  current: HandleBinding | undefined,
  next: HandleBinding,
) => {
  if (current === undefined) {
    return 'bind';
  }
  return current.account === next.account ? 'noop' : 'transfer';
};
