/** The hermetic runner installs the shared network-deny preload before tests load. */
export const denyFetch = globalThis.fetch;
