export const denyNetwork: () => never;
export const denyFetch: () => Promise<never>;
export const deniedDns: Record<string, typeof denyNetwork>;
