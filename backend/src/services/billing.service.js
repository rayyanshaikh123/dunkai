import { env } from '../config/env.js';
import { BOARD_PROVIDERS, BOARD_PROVIDER_IDS } from '../config/providers.js';
import { Usage } from '../models/Usage.js';
import { Project } from '../models/Project.js';
import { ApiError } from '../utils/ApiError.js';
import { getCapabilities } from './supervisor.service.js';
import { currentCreditPeriod, walletSummary } from './credits.service.js';

/** Operator-funded boards use Groq only; other hosted providers need BYOK. */
export const authorizeBoardProvider = async (_user, providerId, credentialIds) => {
  const spec = BOARD_PROVIDERS[providerId];
  if (!spec) throw ApiError.badRequest(`Unknown board provider "${providerId}"`);
  const byok = Boolean(spec.credential && credentialIds.has(spec.credential));
  if (env.billingEnabled && !byok && providerId !== 'groq') {
    throw new ApiError(402, `${spec.label} board generation requires your own provider key. Hosted boards use Groq.`);
  }
  const caps = await getCapabilities();
  if (caps && caps.board_providers?.[providerId] === false) {
    throw ApiError.badRequest(`${spec.label} is unavailable on this deployment`);
  }
  return { byok };
};

export const boardProviderStatus = async (_user, credentialIds) => {
  const caps = await getCapabilities();
  return BOARD_PROVIDER_IDS.map((id) => {
    const spec = BOARD_PROVIDERS[id];
    const byok = Boolean(spec.credential && credentialIds.has(spec.credential));
    const onServer = caps ? Boolean(caps.board_providers?.[id]) : null;
    const permitted = !env.billingEnabled || byok || id === 'groq';
    const available = onServer !== false && permitted;
    return {
      id, label: spec.label, available,
      source: available ? byok ? 'byok' : 'hosted' : null,
      reason: available ? null : onServer === false ? 'Unavailable on this server' : 'Add your own provider key',
    };
  });
};

export const assertCanCreateProject = async () => {};

export const getUsageSummary = async (user) => {
  const period = currentCreditPeriod();
  const [wallet, usage, projects] = await Promise.all([
    walletSummary(user),
    Usage.findOne({ user: user._id, period }).lean(),
    Project.countDocuments({ owner: user._id, status: { $ne: 'archived' } }),
  ]);
  return {
    billingEnabled: env.billingEnabled,
    meteringEnabled: env.creditMeteringEnabled,
    period,
    wallet,
    usage: {
      hostedMessages: usage?.hostedMessages ?? 0,
      hostedBoards: usage?.hostedBoards ?? 0,
      byokMessages: usage?.byokMessages ?? 0,
      byokBoards: usage?.byokBoards ?? 0,
      projects,
    },
  };
};
