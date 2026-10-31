// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/backlink-index/link-extraction.qnt
// Spec hash (sha256): 2ccdf5229d2aadb09437dbce590fd071f24b237cf1f063018348ba354446f574
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const BacklinkLinkExtractionFields = {
    mode: Schema.String,
    cursor: Schema.BigInt,
    observed: Schema.BigInt,
    extracted: Schema.BigInt,
    indexed: Schema.BigInt,
    lastTarget: Schema.String,
    lastSource: Schema.String
};
export const BacklinkLinkExtractionStates = Machine.state({
    fields: BacklinkLinkExtractionFields
});
export const BacklinkLinkExtractionEvents = Machine.events({
    init: {},
    start: {},
    observe: {
        scenario: Schema.BigInt
    },
    pause: {}
});
export const BacklinkLinkExtractionDefinition = Machine.make({
    id: "BacklinkLinkExtraction",
    root: BacklinkLinkExtractionStates,
    events: BacklinkLinkExtractionEvents
});
export type BacklinkLinkExtractionEvent = Machine.EventOf<typeof BacklinkLinkExtractionEvents>;
