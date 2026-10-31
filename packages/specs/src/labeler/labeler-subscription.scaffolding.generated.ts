// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/labeler/labeler-subscription.qnt
// Spec hash (sha256): bf53c62a7936a344d9269689bc400b44e3c4b12b669d53a8c97897876e9df998
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const LabelerSubscriptionFields = {
    subscription: Schema.String,
    labelerMatch: Schema.Boolean,
    declared: Schema.Boolean,
    expired: Schema.Boolean,
    visible: Schema.Boolean
};
export const LabelerSubscriptionStates = Machine.state({
    fields: LabelerSubscriptionFields
});
export const LabelerSubscriptionEvents = Machine.events({
    init: {},
    subscribe: {},
    unsubscribe: {},
    resolve: {
        origin: Schema.String
    },
    expire: {}
});
export const LabelerSubscriptionDefinition = Machine.make({
    id: "LabelerSubscription",
    root: LabelerSubscriptionStates,
    events: LabelerSubscriptionEvents
});
export type LabelerSubscriptionEvent = Machine.EventOf<typeof LabelerSubscriptionEvents>;
