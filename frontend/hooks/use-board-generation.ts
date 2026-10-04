'use client'

import { useCallback, useEffect, useRef } from 'react'
import { aiApi } from '@/lib/api'
import { useWorkspaceStore, type BoardArtifact } from '@/lib/store'
import { boardProviderRequest, hasStoredBoardProvider, readStoredBoardProvider } from '@/lib/providers'

/**
 * Board generation ("Generate PCB").
 *
 * Deliberately the same shape as the chat pipeline in chat-interface.tsx:
 * POST /ai/run-stream returns a jobId, the client joins Socket.io room
 * job:<jobId>, and progress arrives as ai:progress / ai:complete / ai:error.
 * Only the action and the payload differ, so there is one streaming mechanism
 * in the workspace rather than two.
 *
 * Job state lives in the workspace store, not in component state, because the
 * trigger (the end of the chat pipeline, or the BOM tab) and the result (PCB
 * tab) are different views and the run has to survive switching between them.
 *
 * Neither the provider nor the handoff is held in component state. Both are
 * read at the moment `generate` is called:
 *
 * - the provider, because it is configured in Settings, on another route, so a
 *   copy captured when the workspace mounted could be stale;
 * - the pcb_ir, because the main caller is the ai:complete handler in
 *   chat-interface.tsx, which runs inside a closure created before the run it
 *   is reacting to existed. Its captured pcb_ir is null on the very run that
 *   should be generating a board. zustand's set is synchronous, so by the time
 *   generate is called the store already holds the fresh handoff.
 */
export function useBoardGeneration(projectId: string | null, chatId: string | null = null) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput)
  const boardJob = useWorkspaceStore((s) => s.boardJob)
  const startBoardJob = useWorkspaceStore((s) => s.startBoardJob)
  const pushBoardProgress = useWorkspaceStore((s) => s.pushBoardProgress)
  const completeBoardJob = useWorkspaceStore((s) => s.completeBoardJob)
  const failBoardJob = useWorkspaceStore((s) => s.failBoardJob)

  // Holds the teardown for the listeners of the job currently in flight.
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const pcbIr = (aiOutput?.pcb_ir ?? null) as Record<string, unknown> | null
  const componentCount = Array.isArray((pcbIr as { components?: unknown[] })?.components)
    ? ((pcbIr as { components: unknown[] }).components as unknown[]).length
    : 0

  const canGenerate = Boolean(projectId) && componentCount > 0 && boardJob.status !== 'running'

  const generate = useCallback(async () => {
    if (!projectId) return

    // Read through to the store rather than the captured `pcbIr` — see the
    // note on closures in this hook's doc comment.
    const liveIr = (useWorkspaceStore.getState().aiOutput?.pcb_ir ?? null) as Record<string, unknown> | null
    if (!liveIr) return

    cleanupRef.current?.()

    try {
      // The stored id is an OPTION id, which is not always the provider name:
      // two entries can differ only by model. boardProviderRequest is what
      // splits one back into the {provider, model} pair the backend expects.
      // No stored choice: send none, so the server's own default applies.
      const choice = hasStoredBoardProvider() ? boardProviderRequest(readStoredBoardProvider()) : {}
      const res = await aiApi.generateBoard(projectId, chatId, choice)
      const jobId = res?.jobId
      if (!jobId) {
        failBoardJob('The server did not return a job id.')
        return
      }

      startBoardJob(jobId)

      const socket = (await import('@/lib/socket')).getSocket()
      socket.emit('ai:subscribe', jobId)

      const handleProgress = (data: Record<string, unknown>) => {
        if (data.jobId && data.jobId !== jobId) return
        pushBoardProgress({
          stage: (data.stage as string) ?? null,
          label: (data.label as string) ?? null,
          detail: (data.detail as string) ?? null,
        })
      }

      const handleComplete = (socketData: Record<string, any>) => {
        if (socketData.jobId && socketData.jobId !== jobId) return
        // Unwrap the Socket.io wrapper, then the Python SSE wrapper — the same
        // two layers chat-interface unwraps.
        let payload = socketData.data ?? socketData.result ?? socketData
        if (payload && payload.data && typeof payload.data === 'object') payload = payload.data

        const board = payload?.board as BoardArtifact | undefined
        if (board) completeBoardJob(board)
        else failBoardJob('The pipeline finished without returning a board.')
        cleanup()
      }

      const handleError = (socketData: Record<string, any>) => {
        if (socketData.jobId && socketData.jobId !== jobId) return
        const raw = socketData.error
        const message = typeof raw === 'object' ? raw?.error ?? raw?.message : raw
        failBoardJob(String(message ?? 'Board generation failed.'))
        cleanup()
      }

      const cleanup = () => {
        socket.off('ai:progress', handleProgress)
        socket.off('ai:complete', handleComplete)
        socket.off('ai:error', handleError)
        socket.emit('ai:unsubscribe', jobId)
        cleanupRef.current = null
      }
      cleanupRef.current = cleanup

      socket.on('ai:progress', handleProgress)
      socket.on('ai:complete', handleComplete)
      socket.on('ai:error', handleError)
    } catch (err: unknown) {
      failBoardJob(err instanceof Error ? err.message : 'Could not reach Dunk AI.')
    }
  }, [projectId, chatId, startBoardJob, pushBoardProgress, completeBoardJob, failBoardJob])

  return {
    generate,
    canGenerate,
    componentCount,
    job: boardJob,
    board: aiOutput?.board ?? null,
  }
}
