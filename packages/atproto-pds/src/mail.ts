import { Context, Effect, Layer, Schema } from 'effect';

/**
 * The messages this PDS owes (the Effect-PDS map, `84r6`).
 *
 * A **seam**, not a client. What the flows need is *that* a message was sent —
 * a verification, a deletion token — and the transport that does it (SMTP, a
 * relay, a provider's API) is a deployment decision: an intranet with a mail
 * server and one without both have to work.
 *
 * Two references worth knowing before choosing a transport:
 *
 * - **comail.at** — cooperative SMTP for atproto identities, which is what this
 *   repo is. Your sending domain and your **DID** are the identity, the relay
 *   pools reputation so a small sender is not warming an IP alone, and its docs
 *   are written for exactly this case: a self-hosted PDS points its SMTP config
 *   at `smtp.atmos.email:587` — STARTTLS, SASL PLAIN, the DID (or an enrolled
 *   domain, because a `:` breaks URL-style auth config) as the username, an
 *   `atmos_…` key as the password. It is the transport an intranet on atproto
 *   would pick, and it needs a *correct* SMTP client, which is the piece below.

/** A message this PDS composed. The body carries a token, so it is never logged. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** A transport that could not take the message. */
export class MailError extends Schema.TaggedError<MailError>()('MailError', {
  reason: Schema.String,
}) {}

export interface MailShape {
  readonly send: (message: MailMessage) => Effect.Effect<void, MailError>;
}

export class Mail extends Context.Service<Mail, MailShape>()(
  '@eoa/atproto-pds/Mail',
) {}

/**
 * A deployment with no mail server. Composing a message is not failing to send
 * one, so this says that a message was not sent and carries on: an operator
 * reading the log learns a token was issued, and the token itself stays out of
 * it.
 */
export const noMailLayer = Layer.succeed(Mail, {
  send: (message) =>
    Effect.log(
      `no mail server: the message for ${message.to} (${message.subject}) was not sent`,
    ),
});
