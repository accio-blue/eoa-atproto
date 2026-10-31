// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/inbound-authentication.qnt
// Spec hash (sha256): 0e4a02f0b9de6159d76b8a16f340282ab175f102d74b5caca8bfbb018761a4b1
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailInboundAuthenticationFields = {
    spf: Schema.String,
    spfAligned: Schema.Boolean,
    dkim: Schema.String,
    dkimAligned: Schema.Boolean,
    policy: Schema.String,
    dmarc: Schema.String,
    disposition: Schema.String
};
export const MailInboundAuthenticationStates = Machine.state({
    fields: MailInboundAuthenticationFields
});
export const MailInboundAuthenticationEvents = Machine.events({
    init: {},
    setPolicy: {
        chosen: Schema.String
    },
    check: {
        scenario: Schema.BigInt
    }
});
export const MailInboundAuthenticationDefinition = Machine.make({
    id: "MailInboundAuthentication",
    root: MailInboundAuthenticationStates,
    events: MailInboundAuthenticationEvents
});
export type MailInboundAuthenticationEvent = Machine.EventOf<typeof MailInboundAuthenticationEvents>;
