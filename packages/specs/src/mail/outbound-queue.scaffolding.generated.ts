// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/mail/outbound-queue.qnt
// Spec hash (sha256): 85db9076c5aefc5dd0a2b79cd1fee216dc93b0a67f9e4a9cc3ff442abdc18c0a
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const MailOutboundQueueFields = {
    state: Schema.String,
    attempts: Schema.BigInt,
    now: Schema.BigInt,
    dueAt: Schema.BigInt,
    lastDueAt: Schema.BigInt,
    lastAttemptAt: Schema.BigInt,
    everDelivered: Schema.Boolean,
    dsn: Schema.Boolean,
    lastCode: Schema.BigInt
};
export const MailOutboundQueueStates = Machine.state({
    fields: MailOutboundQueueFields
});
export const MailOutboundQueueEvents = Machine.events({
    init: {},
    tick: {},
    attempt: {
        answer: Schema.BigInt
    },
    giveUp: {}
});
export const MailOutboundQueueDefinition = Machine.make({
    id: "MailOutboundQueue",
    root: MailOutboundQueueStates,
    events: MailOutboundQueueEvents
});
export type MailOutboundQueueEvent = Machine.EventOf<typeof MailOutboundQueueEvents>;
