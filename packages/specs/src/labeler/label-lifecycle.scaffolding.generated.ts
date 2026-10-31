// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/labeler/label-lifecycle.qnt
// Spec hash (sha256): b5c608753faccc668f9cc92554fb066c1b131406fc1bc708094e309088ebd16f
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const LabelerLabelLifecycleFields = {
    status: Schema.String,
    neg: Schema.Boolean,
    active: Schema.Boolean,
    published: Schema.BigInt,
    cursor: Schema.BigInt
};
export const LabelerLabelLifecycleStates = Machine.state({
    fields: LabelerLabelLifecycleFields
});
export const LabelerLabelLifecycleEvents = Machine.events({
    init: {},
    emit: {},
    negate: {},
    retract: {},
    expire: {},
    ack: {
        n: Schema.BigInt
    }
});
export const LabelerLabelLifecycleDefinition = Machine.make({
    id: "LabelerLabelLifecycle",
    root: LabelerLabelLifecycleStates,
    events: LabelerLabelLifecycleEvents
});
export type LabelerLabelLifecycleEvent = Machine.EventOf<typeof LabelerLabelLifecycleEvents>;
