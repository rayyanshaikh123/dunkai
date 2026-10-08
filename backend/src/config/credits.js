// Versioned INR tariffs. These are fixed launch prices until end-to-end Groq
// token metering is available; never derive a debit from browser-supplied data.
export const CREDIT_TARIFF_VERSION = 1;
export const FREE_CHATS_PER_MONTH = 5;
export const TRIAL_CREDITS = 150;

export const CREDIT_PACKS = Object.freeze({
  starter: { id: 'starter', credits: 200, amountPaise: 20000 },
  builder: { id: 'builder', credits: 500, amountPaise: 50000 },
  studio: { id: 'studio', credits: 1500, amountPaise: 150000 },
});

export const creditQuote = ({ action, byok = false }) => {
  if (action === 'local_inference') return { credits: byok ? 0 : 2, kind: 'chat' };
  if (action === 'generate_board') return { credits: byok ? 20 : 101, kind: 'board' };
  if (action === 'chat' || action === 'code-chat') return { credits: byok ? 0 : 2, kind: 'chat' };
  if (action === 'run_workflow') return { credits: byok ? 10 : 30, kind: 'pipeline' };
  if (action?.startsWith('generate_') || action === 'revise_interfaces') {
    return { credits: byok ? 10 : 30, kind: 'pipeline' };
  }
  throw new Error(`Unsupported billable AI action: ${action}`);
};
