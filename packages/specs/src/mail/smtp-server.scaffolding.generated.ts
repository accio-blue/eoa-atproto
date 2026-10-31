// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/smtp-server.qnt
// Spec hash (sha256): 70ac1e6dfc6a47aca16153645d536789a5a3083ccf56cb38eb92283122efd4e9
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailSmtpServerFields = {
    stage: Schema.String,
    helo: Schema.Boolean,
    sender: Schema.String,
    recipient: Schema.String,
    durable: Schema.Boolean,
    accepted: Schema.Boolean,
    lastCode: Schema.BigInt
};
export const MailSmtpServerStates = Machine.state({
    fields: MailSmtpServerFields
});
export const MailSmtpServerEvents = Machine.events({
    init: {},
    ehlo: {},
    mailFrom: {
        ok: Schema.Boolean
    },
    rcptTo: {
        asked: Schema.String
    },
    data: {},
    spool: {
        ok: Schema.Boolean
    },
    accept: {},
    quit: {}
});
export const MailSmtpServerDefinition = Machine.make({
    id: "MailSmtpServer",
    root: MailSmtpServerStates,
    events: MailSmtpServerEvents
});
export type MailSmtpServerEvent = Machine.EventOf<typeof MailSmtpServerEvents>;
