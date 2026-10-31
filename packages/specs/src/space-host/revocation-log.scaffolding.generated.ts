// GENERATED FILE — DO NOT EDIT.
// Generated from: ../../specs/space-host/revocation-log.qnt
// Spec hash (sha256): 916302a263af6bf95c31dd9ed1aadc61634cd006a3649f68e6adf2ab64c454f8
// Regenerate with: npm run generate:model
import { Machine } from "@typeonce/effect-machine";
import { Schema } from "effect";
export const RevocationLogFields = {
    epoch: Schema.BigInt,
    revokedUpTo: Schema.BigInt,
    status: Schema.String
};
export const RevocationLogStates = Machine.state({
    fields: RevocationLogFields
});
export const RevocationLogEvents = Machine.events({
    init: {},
    grant: {},
    revoke: {},
    record: {
        at: Schema.BigInt
    }
});
export const RevocationLogDefinition = Machine.make({
    id: "RevocationLog",
    root: RevocationLogStates,
    events: RevocationLogEvents
});
export type RevocationLogEvent = Machine.EventOf<typeof RevocationLogEvents>;
