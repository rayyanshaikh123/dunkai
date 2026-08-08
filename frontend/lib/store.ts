import { create } from 'zustand'

// ---- Shape of the AI pipeline output (mirrors CircuitState from Python) ----
export interface AiOutput {
  requirements: Record<string, unknown> | null
  architecture: Record<string, unknown> | null
  bom: Record<string, unknown> | null
  eda_data: Record<string, unknown> | null
  pcb_ir: Record<string, unknown> | null
  validation: Record<string, unknown> | null
  documentation: Record<string, unknown> | null
}

export interface PipelineProgress {
  activeNode: string
  completedNodes: string[]
}

interface WorkspaceState {
  activeProjectId: string | null
  activeTab: string
  sidebarCollapsed: boolean
  pendingPrompt: string | null

  // Live AI pipeline output & step progress
  aiOutput: AiOutput | null
  pipelineProgress: PipelineProgress

  setActiveProjectId: (id: string | null) => void
  setActiveTab: (tab: string) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPendingPrompt: (prompt: string | null) => void
  setAiOutput: (output: AiOutput) => void
  clearAiOutput: () => void
  setPipelineProgress: (progress: PipelineProgress) => void
  clearPipelineProgress: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeProjectId: null,
  activeTab: 'chat',
  sidebarCollapsed: false,
  pendingPrompt: null,
  aiOutput: null,
  pipelineProgress: { activeNode: '', completedNodes: [] },

  setActiveProjectId: (id) => set({ activeProjectId: id }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  setAiOutput: (output) => set({ aiOutput: output }),
  clearAiOutput: () => set({ aiOutput: null }),
  setPipelineProgress: (progress) => set({ pipelineProgress: progress }),
  clearPipelineProgress: () => set({ pipelineProgress: { activeNode: '', completedNodes: [] } }),
}))
