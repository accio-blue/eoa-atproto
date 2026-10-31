// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/pds/blob-upload.qnt
// Spec hash (sha256): 03f911895fcc8d178a18b01ec9b638636261eff1e0c4dc47ccc2ce00cb5b8ad0
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const PdsBlobUploadFields = {
    phase: Schema.String,
    bytes: Schema.BigInt,
    limit: Schema.BigInt
};
export const PdsBlobUploadStates = Machine.state({
    fields: PdsBlobUploadFields
});
export const PdsBlobUploadEvents = Machine.events({
    init: {},
    begin: {},
    appendChunk: {
        chunk: Schema.BigInt
    },
    finish: {},
    discard: {}
});
export const PdsBlobUploadDefinition = Machine.make({
    id: "PdsBlobUpload",
    root: PdsBlobUploadStates,
    events: PdsBlobUploadEvents
});
export type PdsBlobUploadEvent = Machine.EventOf<typeof PdsBlobUploadEvents>;
