// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/labeler/agent-attribution.qnt
// Spec hash (sha256): 963b61180e4eb81a7c4332646699cc9ac90c1a1b66472a8327017510c47a5f6e
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const LabelerAgentAttributionFields = {
    author: Schema.String,
    provenance: Schema.String,
    label: Schema.String
};
export const LabelerAgentAttributionStates = Machine.state({
    fields: LabelerAgentAttributionFields
});
export const LabelerAgentAttributionEvents = Machine.events({
    init: {},
    resolve: {
        kind: Schema.String
    },
    declare: {},
    withdraw: {},
    reproject: {}
});
export const LabelerAgentAttributionDefinition = Machine.make({
    id: "LabelerAgentAttribution",
    root: LabelerAgentAttributionStates,
    events: LabelerAgentAttributionEvents
});
export type LabelerAgentAttributionEvent = Machine.EventOf<typeof LabelerAgentAttributionEvents>;
