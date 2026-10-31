// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/smtp-client.qnt
// Spec hash (sha256): 9c8be84e16d834dfe5b65d84975e7918e803d27c3ba93ecb4c73929f553d9bb3
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailSmtpClientFields = {
    stage: Schema.String,
    tls: Schema.Boolean,
    advertised: Schema.Boolean,
    authed: Schema.Boolean,
    accepted: Schema.BigInt,
    refused: Schema.BigInt,
    tries: Schema.BigInt,
    regreeted: Schema.Boolean,
    sent: Schema.Boolean,
    lastCode: Schema.BigInt
};
export const MailSmtpClientStates = Machine.state({
    fields: MailSmtpClientFields
});
export const MailSmtpClientEvents = Machine.events({
    init: {},
    greeting: {},
    ehlo: {
        advertises: Schema.Boolean
    },
    starttls: {
        ok: Schema.Boolean
    },
    auth: {
        ok: Schema.Boolean
    },
    abandon: {},
    mailFrom: {
        ok: Schema.Boolean
    },
    rcpt: {
        ok: Schema.Boolean
    },
    data: {
        ok: Schema.Boolean
    },
    quit: {}
});
export const MailSmtpClientDefinition = Machine.make({
    id: "MailSmtpClient",
    root: MailSmtpClientStates,
    events: MailSmtpClientEvents
});
export type MailSmtpClientEvent = Machine.EventOf<typeof MailSmtpClientEvents>;
