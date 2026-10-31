// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/imap-session.qnt
// Spec hash (sha256): 48a455d62c3ffd7b1694cec836abf3dca145308853e92836d7821d1e044f24a7
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailImapSessionFields = {
    state: Schema.String,
    selected: Schema.String,
    everSelected: Schema.Boolean,
    uidNext: Schema.BigInt,
    assignedMax: Schema.BigInt,
    lastUid: Schema.BigInt,
    lastOutcome: Schema.String
};
export const MailImapSessionStates = Machine.state({
    fields: MailImapSessionFields
});
export const MailImapSessionEvents = Machine.events({
    init: {},
    login: {
        ok: Schema.Boolean
    },
    openMailbox: {
        ok: Schema.Boolean
    },
    examine: {
        ok: Schema.Boolean
    },
    fetch: {
        ok: Schema.Boolean
    },
    deliver: {},
    noop: {},
    logout: {}
});
export const MailImapSessionDefinition = Machine.make({
    id: "MailImapSession",
    root: MailImapSessionStates,
    events: MailImapSessionEvents
});
export type MailImapSessionEvent = Machine.EventOf<typeof MailImapSessionEvents>;
