/**
 * Stable import surface for the SMI contract.
 *
 * Module code imports from "./vendor/authz" so swapping to the published
 * @freshifyv2/authz package later touches exactly one line.
 */
export * from "./smi";
