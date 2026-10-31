// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/notifications/cursor-reconcile.qnt
// Spec hash (sha256): d51cd82a5121d6886c19bf75d29e55db1ef127fadfaee2fe521ff99903da1642
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const NotificationsCursorReconcileFields = {
    headSeq: Schema.BigInt,
    cursor: Schema.BigInt,
    missingAt: Schema.BigInt,
    mode: Schema.String
};
export const NotificationsCursorReconcileStates = Machine.state({
    fields: NotificationsCursorReconcileFields
});
export const NotificationsCursorReconcileEvents = Machine.events({
    init: {},
    publish: {
        delta: Schema.BigInt
    },
    consume: {
        offset: Schema.BigInt
    },
    reconcile: {}
});
export const NotificationsCursorReconcileDefinition = Machine.make({
    id: "NotificationsCursorReconcile",
    root: NotificationsCursorReconcileStates,
    events: NotificationsCursorReconcileEvents
});
export type NotificationsCursorReconcileEvent = Machine.EventOf<typeof NotificationsCursorReconcileEvents>;
