import { create } from 'zustand'

// ---- Generated board artifacts (dunkai-designer output) ----
export interface BoardArtifact {
  design_name: string | null
  out_dir: string
  urls: {
    circuitJson?: string
    schematicSvg?: string
    pcbSvg?: string
    bomCsv?: string
    pickAndPlaceCsv?: string
    gerbersDir?: string
    gerbersZip?: string
    boardGlb?: string
    boardGltfJson?: string
    designBrief?: string
    resolution?: string
  }
  sizes: Record<string, number>
  stats: {
    elements?: number
    errors?: number
    warnings?: number
    components?: number
    traces?: number
    bomRows?: number
    errorTypes?: string[]
    resolvedComponents?: number
    unresolvedComponents?: number
    placeholderPinComponents?: number
    substitutedComponents?: number
    gltf?: { glbBytes?: number; rawBytes?: number; cadComponents?: number; meshes?: number } | null
    /** Decoupling caps and pull-ups the designer added (dunkai-designer D-015). */
    supportParts?: number
    /** Connections left open because the part lacks the interface asked for. */
    mismatches?: BoardMismatch[]
  }
  generated_at: string
}

export interface BoardMismatch {
  ref_id: string
  part_number: string
  part_class: string | null
  net: string
  interface: string
  role: string
  /** What the part's real pins show it can do instead. */
  supports: string[]
  reason: string
}

/** Supervisor actions a pending prompt can run instead of the default workflow. */
export type PendingAction = 'run_workflow' | 'revise_interfaces'

/** Live progress for a board-generation job, mirrored from ai:progress. */
export interface BoardJob {
  status: 'idle' | 'running' | 'done' | 'error'
  jobId: string | null
  stage: string | null
  label: string | null
  detail: string | null
  error: string | null
  /** Per-stage log, so the UI can show what happened rather than just a spinner. */
  log: Array<{ stage: string | null; label: string; detail: string | null; at: number }>
}

export interface PipelineProgress {
  activeNode: string
  completedNodes: string[]
}

/**
 * Where the chat's pipeline run stands, for views outside the chat that need
 * to know (the arcade). `running` covers the whole turn, INCLUDING the hand-off
 * to an automatic board run: chat-interface only settles it after that board
 * job has started, so "pipeline running" and "board running" overlap instead of
 * leaving a gap in which nothing looks busy. The settled values record how the
 * turn ended; `idle` means nothing has run, or the run stopped being tracked
 * (project switch, new chat).
 */
export type PipelineRunStatus = 'idle' | 'running' | 'question' | 'done' | 'error'

const idleBoardJob: BoardJob = {
  status: 'idle',
  jobId: null,
  stage: null,
  label: null,
  detail: null,
  error: null,
  log: [],
}

// ---- Shape of the AI pipeline output (mirrors CircuitState from Python) ----
export interface AiOutput {
  requirements: Record<string, unknown> | null
  architecture: Record<string, unknown> | null
  bom: Record<string, unknown> | null
  eda_data: Record<string, unknown> | null
  pcb_ir: Record<string, unknown> | null
  // Schema 1.0 only — carries `passed`. Left null by every current run.
  validation: Record<string, unknown> | null
  // Schema 2.0 — carries `well_formed`. This is the key validation_node
  // actually writes for a current design; `validation` above stayed null and
  // the Validation tab rendered its empty state on every run until this was
  // carried through. The two are deliberately separate keys in CircuitState
  // (see ai_engine/agents/supervisor/state.py) and stay separate here.
  handoff_validation: Record<string, unknown> | null
  documentation: Record<string, unknown> | null
  code_generation: Record<string, unknown> | null
  // Present only after "Generate PCB" has run. Lives inside AiOutput on purpose:
  // a fresh pipeline run replaces the whole object, which clears a board that
  // belongs to a previous BOM rather than showing it against new components.
  board: BoardArtifact | null
}

/**
 * The artifact keys a pipeline run can fill in, excluding `board`.
 *
 * `board` is handled separately in `setAiOutput`: it is not produced by the
 * pipeline at all (only by "Generate PCB"), and it is invalidated by a new
 * BOM rather than replaced by one.
 */
const DESIGN_KEYS = [
  'requirements',
  'architecture',
  'bom',
  'eda_data',
  'pcb_ir',
  'validation',
  'handoff_validation',
  'documentation',
  'code_generation',
] as const

const emptyAiOutput: AiOutput = {
  requirements: null,
  architecture: null,
  bom: null,
  eda_data: null,
  pcb_ir: null,
  validation: null,
  handoff_validation: null,
  documentation: null,
  code_generation: null,
  board: null,
}

interface WorkspaceState {
  activeProjectId: string | null
  // Which chat *session* within the active project is open. A project can
  // have many chats (see the Chat model); this is the one chat-interface
  // loads messages for and posts new ones into. Null means "not chosen yet
  // / let chat-interface pick the most recent one," same as on first load.
  activeChatId: string | null
  activeTab: string
  sidebarCollapsed: boolean
  pendingPrompt: string | null
  /** Which supervisor action the pending prompt runs (default: the workflow). */
  pendingAction: PendingAction | null

  // Live AI pipeline output — populated when the supervisor stream completes
  aiOutput: AiOutput | null
  boardJob: BoardJob

  // Pipeline node progress — updated by chat-interface as nodes complete
  pipelineProgress: PipelineProgress
  pipelineRun: PipelineRunStatus

  // Selected AI Model for chat / supervisor pipeline
  selectedModel: string
  setSelectedModel: (model: string) => void

  setActiveProjectId: (id: string | null) => void
  setActiveChatId: (id: string | null) => void
  setActiveTab: (tab: string) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPendingPrompt: (prompt: string | null) => void
  setPendingAction: (action: PendingAction | null) => void
  /**
   * Merge a pipeline result into the stored design.
   *
   * Null and absent incoming fields are DROPPED rather than written, so a
   * failed or partial run can never blank out artifacts an earlier run
   * produced. Only real content replaces real content.
   */
  setAiOutput: (output: Partial<AiOutput>) => void
  /**
   * Fill the store from what the server has saved for this project.
   *
   * Same non-null merge as `setAiOutput`, minus the board-invalidation rule.
   * A restore replays the BOM that is already on record rather than delivering
   * a new one, so treating it as "components replaced" would throw away the
   * board that was generated from exactly that BOM — which is what made the
   * PCB, DRC and Docs figures vanish on every project switch. The saved board
   * is already kept consistent with the saved BOM server-side (see
   * persistBoardState in backend/src/services/supervisor.service.js), so it can
   * be taken at face value here.
   */
  hydrateAiOutput: (output: Partial<AiOutput>) => void
  /** Replace the whole design wholesale — for a genuinely new design only. */
  replaceAiOutput: (output: AiOutput) => void
  clearAiOutput: () => void

  setPipelineProgress: (progress: PipelineProgress) => void
  clearPipelineProgress: () => void
  setPipelineRun: (status: PipelineRunStatus) => void
  startBoardJob: (jobId: string) => void
  pushBoardProgress: (update: { stage?: string | null; label?: string | null; detail?: string | null }) => void
  completeBoardJob: (board: BoardArtifact) => void
  failBoardJob: (error: string) => void
  resetBoardJob: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeProjectId: null,
  activeChatId: null,
  activeTab: 'chat',
  sidebarCollapsed: true,
  pendingPrompt: null,
  pendingAction: null,
  aiOutput: null,
  boardJob: idleBoardJob,
  pipelineProgress: { activeNode: '', completedNodes: [] },
  pipelineRun: 'idle',
  selectedModel: 'openai/gpt-oss-120b',

  setSelectedModel: (model) => set({ selectedModel: model }),
  // A different project means a different set of chat sessions -- carrying
  // the old project's activeChatId forward would have chat-interface try to
  // load a chat that doesn't belong to (and may not even exist under) the
  // newly active project.
  setActiveProjectId: (id) => set({ activeProjectId: id, activeChatId: null }),
  setActiveChatId: (id) => set({ activeChatId: id }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  setPendingAction: (action) => set({ pendingAction: action }),
  setAiOutput: (output) =>
    set((state) => {
      const merged: AiOutput = { ...(state.aiOutput ?? emptyAiOutput) }

      // A new BOM or pcb_ir means the components changed, which retires any
      // board built from the previous ones. Tracked while merging so that only
      // a run that actually delivered new components clears the board — a run
      // that delivered nothing leaves it alone.
      let componentsReplaced = false

      for (const key of DESIGN_KEYS) {
        const incoming = output[key]
        if (incoming === null || incoming === undefined) continue
        merged[key] = incoming
        if (key === 'bom' || key === 'pcb_ir') componentsReplaced = true
      }

      if (output.board) {
        merged.board = output.board
      } else if (componentsReplaced) {
        // Showing the old board beside new components would be a different
        // design than the one on screen (see the `board` field comment above).
        merged.board = null
      }

      return {
        aiOutput: merged,
        // The job log describes the board that is on screen. Reset it only when
        // that board changed; otherwise a merge would erase the completed run's
        // stage log while its board is still being displayed.
        boardJob: merged.board === state.aiOutput?.board ? state.boardJob : idleBoardJob,
      }
    }),

  hydrateAiOutput: (output) =>
    set((state) => {
      const merged: AiOutput = { ...(state.aiOutput ?? emptyAiOutput) }

      for (const key of DESIGN_KEYS) {
        const incoming = output[key]
        if (incoming === null || incoming === undefined) continue
        merged[key] = incoming
      }
      if (output.board) merged.board = output.board

      return {
        aiOutput: merged,
        // A restore must not interrupt a generation that is in flight: PcbView
        // renders the progress log off this status, and hydrating a previously
        // saved board mid-run would swap that log for a stale board.
        boardJob:
          state.boardJob.status === 'running' || merged.board === state.aiOutput?.board
            ? state.boardJob
            : idleBoardJob,
      }
    }),

  replaceAiOutput: (output) => set({ aiOutput: output, boardJob: idleBoardJob }),
  clearAiOutput: () => set({ aiOutput: null, boardJob: idleBoardJob }),

  setPipelineProgress: (progress) => set({ pipelineProgress: progress }),
  clearPipelineProgress: () => set({ pipelineProgress: { activeNode: '', completedNodes: [] } }),
  setPipelineRun: (status) => set({ pipelineRun: status }),

  startBoardJob: (jobId) =>
    set({ boardJob: { ...idleBoardJob, status: 'running', jobId, label: 'Starting board generation' } }),

  pushBoardProgress: (update) =>
    set((state) => {
      const label = update.label ?? state.boardJob.label ?? ''
      return {
        boardJob: {
          ...state.boardJob,
          status: 'running',
          stage: update.stage ?? state.boardJob.stage,
          label,
          detail: update.detail ?? null,
          log: label
            ? [...state.boardJob.log, { stage: update.stage ?? null, label, detail: update.detail ?? null, at: Date.now() }]
            : state.boardJob.log,
        },
      }
    }),

  // `aiOutput` is seeded from emptyAiOutput when it is still null rather than
  // left alone. Generating a board is reachable with an empty store — a reload
  // mid-session, a project whose pcb_ir came back before anything else — and
  // the old guard silently threw the finished board away in exactly that case.
  completeBoardJob: (board) =>
    set((state) => ({
      boardJob: { ...state.boardJob, status: 'done', detail: null, error: null },
      aiOutput: { ...(state.aiOutput ?? emptyAiOutput), board },
    })),

  failBoardJob: (error) =>
    set((state) => ({ boardJob: { ...state.boardJob, status: 'error', error } })),

  resetBoardJob: () => set({ boardJob: idleBoardJob }),
}))
