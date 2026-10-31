// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/labeler/claim-projection.qnt
// Spec hash (sha256): a5774be8579f9d5f59ec6da4d68c8cba33cf95fc72578651d0560b1740fa8558
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const LabelerClaimProjectionFields = {
    claim: Schema.String,
    label: Schema.String,
    revision: Schema.BigInt
};
export const LabelerClaimProjectionStates = Machine.state({
    fields: LabelerClaimProjectionFields
});
export const LabelerClaimProjectionEvents = Machine.events({
    init: {},
    file: {},
    uphold: {},
    dismiss: {},
    withdraw: {},
    reproject: {}
});
export const LabelerClaimProjectionDefinition = Machine.make({
    id: "LabelerClaimProjection",
    root: LabelerClaimProjectionStates,
    events: LabelerClaimProjectionEvents
});
export type LabelerClaimProjectionEvent = Machine.EventOf<typeof LabelerClaimProjectionEvents>;
