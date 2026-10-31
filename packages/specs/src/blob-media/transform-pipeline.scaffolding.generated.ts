// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/blob-media/transform-pipeline.qnt
// Spec hash (sha256): 69fa0bf66eec36fb951d4dff187b9c2365870661141505fa0cd2ab90af2a4ac2
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BlobMediaTransformPipelineFields = {
    phase: Schema.String,
    wanted: Schema.String,
    cached: Schema.String,
    cache: Schema.String,
    derived: Schema.BigInt,
    hits: Schema.BigInt,
    served: Schema.BigInt
};
export const BlobMediaTransformPipelineStates = Machine.state({
    fields: BlobMediaTransformPipelineFields
});
export const BlobMediaTransformPipelineEvents = Machine.events({
    init: {},
    request: {
        pick: Schema.String
    },
    derive: {},
    settle: {},
    evict: {}
});
export const BlobMediaTransformPipelineDefinition = Machine.make({
    id: "BlobMediaTransformPipeline",
    root: BlobMediaTransformPipelineStates,
    events: BlobMediaTransformPipelineEvents
});
export type BlobMediaTransformPipelineEvent = Machine.EventOf<typeof BlobMediaTransformPipelineEvents>;
