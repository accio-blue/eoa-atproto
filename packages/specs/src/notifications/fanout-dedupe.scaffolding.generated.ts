// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/notifications/fanout-dedupe.qnt
// Spec hash (sha256): 06179aee398c048ed2d320bfa739c6c11f8810e236e35dd54f6cfcab0eafa8b5
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const NotificationsFanoutDedupeFields = {
    eventCount: Schema.BigInt,
    inboxA: Schema.BigInt,
    inboxB: Schema.BigInt,
    cursorA: Schema.BigInt,
    cursorB: Schema.BigInt,
    dropped: Schema.BigInt
};
export const NotificationsFanoutDedupeStates = Machine.state({
    fields: NotificationsFanoutDedupeFields
});
export const NotificationsFanoutDedupeEvents = Machine.events({
    init: {},
    fanout: {
        audience: Schema.String
    },
    redeliver: {
        audience: Schema.String
    },
    readA: {
        n: Schema.BigInt
    },
    readB: {
        n: Schema.BigInt
    }
});
export const NotificationsFanoutDedupeDefinition = Machine.make({
    id: "NotificationsFanoutDedupe",
    root: NotificationsFanoutDedupeStates,
    events: NotificationsFanoutDedupeEvents
});
export type NotificationsFanoutDedupeEvent = Machine.EventOf<typeof NotificationsFanoutDedupeEvents>;
