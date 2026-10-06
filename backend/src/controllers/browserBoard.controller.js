import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import { getBrowserBoardFile, saveBrowserBoard } from '../services/browserBoard.service.js';

export const save = asyncHandler(async (req, res) => {
  send(res, { data: await saveBrowserBoard(req.params.id, req.user, req.body) });
});

export const file = asyncHandler(async (req, res) => {
  const result = await getBrowserBoardFile(req.params.id, req.user, req.params.kind);
  res.set({
    'Content-Type': result.type,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': result.kind === 'circuit'
      ? 'attachment; filename="circuit.json"'
      : `inline; filename="${result.kind}.svg"`,
  });
  res.send(result.data);
});
