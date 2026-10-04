/** Display copy; prices and balances are enforced by the backend. */
export const CREDIT_PACK_COPY = [
  { id: 'starter', name: 'Starter', credits: 200, rupees: 200, tagline: 'For another project or two.', highlighted: false },
  { id: 'builder', name: 'Builder', credits: 500, rupees: 500, tagline: 'For several boards and revisions.', highlighted: true },
  { id: 'studio', name: 'Studio', credits: 1500, rupees: 1500, tagline: 'For a busy hardware workspace.', highlighted: false },
] as const
