'use client'

import { useEffect } from 'react'
import { TopBar } from '@/components/workspace/top-bar'
import { Sidebar } from '@/components/workspace/sidebar'
import { MainEditor } from '@/components/workspace/main-editor'
import { ProtectedRoute } from '@/components/layouts/protected-route'
import { useWorkspaceStore } from '@/lib/store'
import { useProjects } from '@/hooks/use-projects'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

function WorkspaceContent() {
  const { data, isLoading, isError } = useProjects()
  const { activeProjectId, setActiveProjectId, setSidebarCollapsed, sidebarCollapsed } = useWorkspaceStore()

  const projects = data?.items || []

  // Keep the active project valid; when there are no projects,
  // MainEditor renders the Gemini-style NewProjectChat hero.
  useEffect(() => {
    if (projects.length > 0 && !activeProjectId) {
      setActiveProjectId(projects[0]._id)
    }
    if (activeProjectId && !projects.find((p) => p._id === activeProjectId)) {
      setActiveProjectId(projects.length > 0 ? projects[0]._id : null)
    }
  }, [projects, activeProjectId, setActiveProjectId])

  useEffect(() => {
    if (activeProjectId) {
      setSidebarCollapsed(false)
    }
  }, [activeProjectId, setSidebarCollapsed])

  if (isLoading) {
    return (
      <div className="h-screen w-full flex flex-col bg-background text-foreground">
        <div className="h-16 border-b border-foreground/10 flex items-center px-8 gap-4">
          <Skeleton className="h-4 w-20" />
          <div className="ml-auto flex gap-2">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="w-[248px] border-r border-foreground/10 p-4 space-y-3">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </aside>
          <main className="flex-1 p-8">
            <Skeleton className="h-8 w-64 mb-6" />
            <Skeleton className="h-[400px] w-full" />
          </main>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-background text-foreground gap-4">
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-sm text-muted-foreground">Failed to load projects. Please check your connection.</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="h-screen w-full flex flex-col bg-background text-foreground relative overflow-hidden noise-overlay">
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-background/80" />
        <div className="absolute top-0 right-1/3 w-[800px] h-[800px] bg-foreground/2 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] bg-foreground/2 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '12s' }} />
        <div className="absolute top-1/2 -right-1/4 w-[500px] h-[500px] bg-foreground/1 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '10s' }} />
      </div>

      <TopBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className={`h-full min-h-0 shrink-0 border-r border-foreground/10 transition-[width] duration-300 ${sidebarCollapsed ? 'w-[64px]' : 'w-[248px]'}`}>
          <Sidebar />
        </aside>
        <main className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden">
          <MainEditor />
        </main>
      </div>
    </div>
  )
}

export default function WorkspacePage() {
  return (
    <ProtectedRoute>
      <WorkspaceContent />
    </ProtectedRoute>
  )
}
