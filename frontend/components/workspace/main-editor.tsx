'use client'

import React from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { ChatInterface } from './chat-interface'
import { RequirementsView } from './views/requirements-view'
import { ArchitectureView } from './views/architecture-view'
import { BOMView } from './views/bom-view'
import { ValidationView } from './views/validation-view'
import { DocsView } from './views/docs-view'
import { PcbView } from './views/pcb-view'
import { NewProjectChat } from './new-project-chat'
import { EdaViewer } from './views/eda-viewer'
import { useWorkspaceStore } from '@/lib/store'

const tabs = [
  { id: 'chat', label: 'Chat', node: '' },
  { id: 'requirements', label: 'Requirements', node: 'requirements' },
  { id: 'architecture', label: 'Architecture', node: 'architecture' },
  { id: 'bom', label: 'BOM', node: 'component' },
  { id: 'eda', label: 'EDA', node: 'eda_enrichment' },
  { id: 'pcb', label: 'PCB', node: 'pcb' },
  { id: 'validation', label: 'Validation', node: 'validation' },
  { id: 'docs', label: 'Docs', node: 'documentation' },
]

export function MainEditor() {
  const { activeProjectId, activeTab, setActiveTab, pipelineProgress, aiOutput } = useWorkspaceStore()

  if (!activeProjectId) {
    return <NewProjectChat />
  }

  return (
    <div className="h-full flex flex-col bg-gradient-to-br from-background/50 via-background/40 to-background/50">
      {/* View Nav Tabs with Live Progress Indicators */}
      <div className="z-20 border-b border-foreground/10 bg-background/85 px-8 pt-6 shrink-0 backdrop-blur-xl">
        <div className="flex items-center gap-2 pb-6 overflow-x-auto">
          {tabs.map((tab) => {
            const isRunning = tab.node && pipelineProgress.activeNode === tab.node
            const isComplete =
              tab.node &&
              (pipelineProgress.completedNodes.includes(tab.node) ||
                (aiOutput && aiOutput[tab.id as keyof typeof aiOutput]))

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-all duration-300 whitespace-nowrap relative group active:scale-95 flex items-center gap-2 ${
                  activeTab === tab.id
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground active:text-foreground'
                }`}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 text-sky-400 animate-spin shrink-0" />
                ) : isComplete ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : null}

                <span>{tab.label}</span>

                {activeTab === tab.id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground rounded-full" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content — ALL views stay mounted; active one visible */}
      <div className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
          <ChatInterface projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'pcb' ? 'block' : 'hidden'}`}>
          <PcbView projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'requirements' ? 'block' : 'hidden'}`}>
          <RequirementsView projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'architecture' ? 'block' : 'hidden'}`}>
          <ArchitectureView projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'bom' ? 'block' : 'hidden'}`}>
          <BOMView projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'validation' ? 'block' : 'hidden'}`}>
          <ValidationView projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'eda' ? 'block' : 'hidden'}`}>
          <EdaViewer projectId={activeProjectId} />
        </div>
        <div className={`absolute inset-0 overflow-hidden ${activeTab === 'docs' ? 'block' : 'hidden'}`}>
          <DocsView projectId={activeProjectId} />
        </div>
      </div>
    </div>
  )
}
