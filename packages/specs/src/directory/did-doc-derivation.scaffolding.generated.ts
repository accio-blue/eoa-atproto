// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/directory/did-doc-derivation.qnt
// Spec hash (sha256): bae08f1fe092889c6aae551b0d394289dcc63c722807f0052a379e886a7cd9f7
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const DidDocDerivationFields = {
    headKind: Schema.String,
    headSigningKey: Schema.String,
    headHandle: Schema.String,
    headPds: Schema.String,
    headEpoch: Schema.BigInt,
    docEpoch: Schema.BigInt,
    docRendered: Schema.Boolean,
    docId: Schema.String,
    docAlias: Schema.String,
    docKey: Schema.String,
    docService: Schema.String,
    docRotationExposed: Schema.Boolean
};
export const DidDocDerivationStates = Machine.state({
    fields: DidDocDerivationFields
});
export const DidDocDerivationEvents = Machine.events({
    init: {},
    install: {
        bundle: Schema.String
    },
    render: {}
});
export const DidDocDerivationDefinition = Machine.make({
    id: "DidDocDerivation",
    root: DidDocDerivationStates,
    events: DidDocDerivationEvents
});
export type DidDocDerivationEvent = Machine.EventOf<typeof DidDocDerivationEvents>;
