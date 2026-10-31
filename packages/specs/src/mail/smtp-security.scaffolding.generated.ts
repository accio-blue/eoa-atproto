// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/smtp-security.qnt
// Spec hash (sha256): 9f5a079fd14f9a66c55e49235080f192f67d6702f99037c989f0ea8f58049904
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailSmtpSecurityFields = {
    stage: Schema.String,
    tls: Schema.Boolean,
    offers: Schema.Boolean,
    strict: Schema.Boolean,
    upgrades: Schema.BigInt,
    authed: Schema.Boolean,
    sender: Schema.String,
    recipient: Schema.String,
    epoch: Schema.BigInt,
    senderEpoch: Schema.BigInt,
    awaitingAuth: Schema.Boolean,
    lastCode: Schema.BigInt
};
export const MailSmtpSecurityStates = Machine.state({
    fields: MailSmtpSecurityFields
});
export const MailSmtpSecurityEvents = Machine.events({
    init: {},
    configure: {
        setup: Schema.BigInt
    },
    ehlo: {},
    starttls: {
        ok: Schema.Boolean
    },
    auth: {
        ok: Schema.Boolean
    },
    authStart: {},
    authPayload: {
        ok: Schema.Boolean
    },
    mailFrom: {
        ok: Schema.Boolean
    },
    recipientLocal: {
        took: Schema.Boolean
    },
    recipientRemote: {
        took: Schema.Boolean
    },
    rset: {},
    quit: {}
});
export const MailSmtpSecurityDefinition = Machine.make({
    id: "MailSmtpSecurity",
    root: MailSmtpSecurityStates,
    events: MailSmtpSecurityEvents
});
export type MailSmtpSecurityEvent = Machine.EventOf<typeof MailSmtpSecurityEvents>;
