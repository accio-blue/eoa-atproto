// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/notifications/delivery-lifecycle.qnt
// Spec hash (sha256): 385626ddd3b17f9a3cd64f223a3652c45761c215ff2ece451f45fd9b48f1d1cf
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const NotificationsDeliveryLifecycleFields = {
    stage: Schema.String,
    attempts: Schema.BigInt,
    unread: Schema.BigInt,
    pushed: Schema.Boolean
};
export const NotificationsDeliveryLifecycleStates = Machine.state({
    fields: NotificationsDeliveryLifecycleFields
});
export const NotificationsDeliveryLifecycleEvents = Machine.events({
    init: {},
    deliver: {
        ok: Schema.Boolean
    },
    read: {},
    withdraw: {}
});
export const NotificationsDeliveryLifecycleDefinition = Machine.make({
    id: "NotificationsDeliveryLifecycle",
    root: NotificationsDeliveryLifecycleStates,
    events: NotificationsDeliveryLifecycleEvents
});
export type NotificationsDeliveryLifecycleEvent = Machine.EventOf<typeof NotificationsDeliveryLifecycleEvents>;
