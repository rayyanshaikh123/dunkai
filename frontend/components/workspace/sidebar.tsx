'use client'

import React, { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Plus,
  MessageSquare,
  MessageSquarePlus,
  Zap,
  Package,
  CheckCircle,
  FileText,
  Settings,
  ChevronRight,
  Search,
  Star,
  MoreVertical,
  Copy,
  Archive,
  Trash2,
  AlertCircle,
  Loader2,
  Cpu,
  Pencil,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useWorkspaceStore } from '@/lib/store'
import { useProjects, useToggleFavourite, useArchiveProject, useDuplicateProject, useDeleteProject } from '@/hooks/use-projects'
import { useChats, useCreateChat, useRenameChat, useDeleteChat } from '@/hooks/use-chats'
import type { Project, Chat } from '@/lib/types'
import { toast } from 'sonner'

const PROJECT_ICONS = [Zap, Package, CheckCircle, FileText]
const VIEW_ITEMS = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'requirements', label: 'Requirements', icon: FileText },
  { id: 'architecture', label: 'Architecture', icon: Zap },
  { id: 'bom', label: 'BOM', icon: Package },
  { id: 'validation', label: 'Validation', icon: CheckCircle },
  { id: 'eda', label: 'EDA', icon: Cpu },
  { id: 'docs', label: 'Documentation', icon: FileText },
  { id: 'pcb', label: 'PCB Board', icon: Package },
] as const

type ProjectMenuAction = 'favorite' | 'duplicate' | 'archive' | 'delete'

// Plain scrollable div, not Radix ScrollArea: ScrollArea's Viewport wraps its
// children in a `display: table` div (see @radix-ui/react-scroll-area),
// which breaks flex `min-w-0`/`truncate` on everything inside it — project
// titles and other text were overflowing past the sidebar's fixed width.
const SCROLL_CLASS =
  'min-h-0 flex-1 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent'

function getProjectIcon(_id: string, index: number) {
  return PROJECT_ICONS[index % PROJECT_ICONS.length]
}

function formatRelativeTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(date).toLocaleDateString()
}

function formatProjectStage(project: Project): string {
  if (project.status === 'archived') return 'Archived'
  if (project.currentStage) {
    return project.currentStage
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }
  return 'Active'
}

function projectStatusTone(project: Project): string {
  if (project.status === 'archived') return 'border-amber-500/20 bg-amber-500/5 text-amber-600 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300'
  return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300'
}

export function Sidebar() {
  const { activeProjectId, setActiveProjectId, activeTab, setActiveTab, sidebarCollapsed, toggleSidebar } = useWorkspaceStore()
  const activeChatId = useWorkspaceStore((s) => s.activeChatId)
  const setActiveChatId = useWorkspaceStore((s) => s.setActiveChatId)
  const { data, isLoading, isError } = useProjects()
  const toggleFavourite = useToggleFavourite()
  const archiveProject = useArchiveProject()
  const duplicateProject = useDuplicateProject()
  const deleteProject = useDeleteProject()
  const router = useRouter()

  const { data: chatsData, isLoading: chatsLoading } = useChats(activeProjectId)
  const createChat = useCreateChat()
  const renameChatMutation = useRenameChat(activeProjectId)
  const deleteChatMutation = useDeleteChat(activeProjectId)
  const chats = chatsData?.items || []

  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleteChatTarget, setDeleteChatTarget] = useState<Chat | null>(null)
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const allProjects = data?.items || []
  const filteredProjects = search
    ? allProjects.filter((p) =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase())
      )
    : allProjects

  // Projects are created through the AI chat, not a form — the "+" simply
  // clears the active project so the New Project chat is shown
  const handleNewProject = () => {
    setActiveProjectId(null)
    setActiveTab('chat')
  }

  // Select project: set active ID and switch tab to chat so conversation history is immediately visible
  const handleSelectProject = useCallback((id: string) => {
    setActiveProjectId(id)
    setActiveTab('chat')
  }, [setActiveProjectId, setActiveTab])

  // Switch to a different chat session within the active project.
  const handleSelectChat = useCallback((id: string) => {
    setActiveChatId(id)
    setActiveTab('chat')
  }, [setActiveChatId, setActiveTab])

  // Start a brand-new conversation thread. Deliberately does NOT touch the
  // project's requirements/architecture/bom/etc — those belong to the design,
  // not to any one conversation, and other sessions may still depend on them.
  const handleNewSession = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const chat = await createChat.mutateAsync({ projectId: activeProjectId, title: 'New chat' })
      setActiveChatId(chat._id)
      setActiveTab('chat')
    } catch {
      toast.error('Failed to create a new chat session')
    }
  }, [activeProjectId, createChat, setActiveChatId, setActiveTab])

  const startRenameChat = (chat: Chat) => {
    setRenamingChatId(chat._id)
    setRenameDraft(chat.title)
  }

  const commitRenameChat = async () => {
    const id = renamingChatId
    const title = renameDraft.trim()
    setRenamingChatId(null)
    if (!id || !title) return
    try {
      await renameChatMutation.mutateAsync({ id, title })
    } catch {
      toast.error('Failed to rename session')
    }
  }

  const handleDeleteChat = async () => {
    if (!deleteChatTarget) return
    const target = deleteChatTarget
    setDeleteChatTarget(null)
    try {
      await deleteChatMutation.mutateAsync(target._id)
      toast.success('Session deleted')
      // The active session just disappeared — hand off to another one (or a
      // fresh one, if that was the last) rather than leaving the chat view
      // pointed at a chat that no longer exists.
      if (activeChatId === target._id) {
        const remaining = chats.filter((c) => c._id !== target._id)
        if (remaining.length > 0) {
          setActiveChatId(remaining[0]._id)
        } else if (activeProjectId) {
          const chat = await createChat.mutateAsync({ projectId: activeProjectId, title: 'New chat' })
          setActiveChatId(chat._id)
        }
      }
    } catch {
      toast.error('Failed to delete session')
    }
  }

  const handleProjectAction = (action: ProjectMenuAction, project: Project) => {
    if (action === 'favorite') {
      toggleFavourite.mutate(project._id)
      return
    }
    if (action === 'duplicate') {
      void handleDuplicate(project._id)
      return
    }
    if (action === 'archive') {
      handleArchive(project._id)
      return
    }
    setDeleteTarget(project)
  }

  const handleArchive = (id: string) => {
    archiveProject.mutate(id)
    toast.success('Project archived')
  }

  const handleDuplicate = async (id: string) => {
    try {
      await duplicateProject.mutateAsync(id)
      toast.success('Project duplicated')
    } catch {
      toast.error('Failed to duplicate project')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const project = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteProject.mutateAsync(project._id)
      toast.success('Project deleted')
      if (activeProjectId === project._id) {
        setActiveProjectId(null)
      }
    } catch {
      toast.error('Failed to delete project')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent w-full min-w-0">
      <div className="shrink-0 border-b border-sidebar-border/80 px-4 py-4">
        <div className={`flex items-center gap-2 ${sidebarCollapsed ? 'justify-center' : 'justify-between'}`}>
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-sidebar-foreground/50">Workspace</p>
              <p className="mt-1 text-sm font-semibold text-sidebar-foreground">Engineering control panel</p>
            </div>
          )}
          <Button
            onClick={toggleSidebar}
            size="icon"
            variant="outline"
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            className="h-8 w-8 rounded-xl border-sidebar-border bg-background/80 text-sidebar-foreground transition-transform duration-200 hover:bg-sidebar-accent"
          >
            <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${sidebarCollapsed ? 'rotate-180' : ''}`} />
          </Button>
        </div>

        {!sidebarCollapsed && (
          <div className="relative mt-3 group">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/40 transition-colors group-focus-within:text-sidebar-foreground/70" />
            <Input
              aria-label="Search projects"
              placeholder="Search projects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 rounded-xl border-sidebar-border bg-background/70 pl-9 pr-3 text-xs text-sidebar-foreground placeholder:text-sidebar-foreground/40 shadow-sm transition-all duration-200 hover:border-sidebar-foreground/20 focus:border-sidebar-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
        )}
      </div>

      {sidebarCollapsed ? (
        <TooltipProvider delayDuration={0}>
          <div className={SCROLL_CLASS}>
            <div className="flex h-full min-h-0 flex-col items-center gap-3 px-2 py-3">
              <div className="flex shrink-0 flex-col items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={handleNewProject}
                      variant="outline"
                      type="button"
                      aria-label="Create new project"
                      className="h-10 w-10 rounded-xl border-sidebar-border bg-background/70 p-0 text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New project</TooltipContent>
                </Tooltip>
                <div className="h-px w-8 bg-sidebar-border/80" />
              </div>

              <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 py-1">
                {filteredProjects.map((project, index) => {
                  const Icon = getProjectIcon(project._id, index)
                  const isActive = activeProjectId === project._id
                  return (
                    <Tooltip key={project._id}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => handleSelectProject(project._id)}
                          aria-label={project.title}
                          className={`h-10 w-10 rounded-xl border p-0 transition-all duration-200 ${
                            isActive
                              ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground shadow-sm'
                              : 'border-transparent bg-transparent text-sidebar-foreground/70 hover:border-sidebar-border/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{project.title}</TooltipContent>
                    </Tooltip>
                  )
                })}

                <div className="my-1 h-px w-8 bg-sidebar-border/80" />

                {VIEW_ITEMS.map((tab) => {
                  const Icon = tab.icon
                  const isActiveTab = activeTab === tab.id
                  return (
                    <Tooltip key={tab.id}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setActiveTab(tab.id)}
                          aria-label={tab.label}
                          className={`h-10 w-10 rounded-xl border p-0 transition-all duration-200 ${
                            isActiveTab
                              ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground shadow-sm'
                              : 'border-transparent bg-transparent text-sidebar-foreground/70 hover:border-sidebar-border/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{tab.label}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>

              <div className="shrink-0 border-t border-sidebar-border/80 pt-3">
                <div className="flex flex-col items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => router.push('/settings')}
                        aria-label="Settings"
                        className="h-10 w-10 rounded-xl border-sidebar-border bg-background/70 p-0 text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Settings</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label="Add credits"
                        onClick={() => router.push('/settings')}
                        className="h-10 w-10 rounded-xl border-sidebar-border bg-background/70 p-0 text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                      >
                        <Zap className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Add credits</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          </div>
        </TooltipProvider>
      ) : (
        <div className={SCROLL_CLASS}>
          <div className="space-y-4 p-4 w-full min-w-0">
            <section className="rounded-2xl border border-sidebar-border/80 bg-sidebar-accent/20 px-3 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-sidebar-foreground/50">Projects</p>
                  <p className="mt-1 text-sm font-semibold text-sidebar-foreground">Workspace projects</p>
                </div>
                <span className="rounded-full border border-sidebar-border bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/60">
                  {allProjects.length}
                </span>
              </div>
            </section>

            {isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="rounded-2xl border border-transparent px-3 py-3">
                    <div className="flex items-center gap-2">
                      <Skeleton className="w-4 h-4 rounded" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-2 w-16 mt-2" />
                  </div>
                ))}
              </div>
            )}

            {isError && (
              <div className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
                <AlertCircle className="w-3 h-3 text-destructive" />
                Failed to load
              </div>
            )}

            {!isLoading && !isError && filteredProjects.length === 0 && (
              <div className="rounded-xl border border-dashed border-sidebar-border px-3 py-4 text-center text-xs text-sidebar-foreground/50">
                {search ? 'No projects found' : 'No projects yet'}
              </div>
            )}

            <section className="space-y-1 w-full min-w-0">
              {filteredProjects.map((project, index) => {
                const Icon = getProjectIcon(project._id, index)
                const isActive = activeProjectId === project._id
                const rawTopic = project.description?.trim() || formatProjectStage(project)
                const topic = rawTopic.length > 25 ? rawTopic.slice(0, 25) + '…' : rawTopic

                return (
                  <div key={project._id} className="group flex items-center gap-0.5 rounded-xl transition-colors w-full min-w-0 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => handleSelectProject(project._id)}
                      className={`flex-1 min-w-0 overflow-hidden flex items-center justify-between gap-1.5 rounded-xl px-2.5 py-2 text-left transition-all duration-200 cursor-pointer select-none active:scale-[0.99] ${
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground shadow-sm'
                          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1 overflow-hidden">
                        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${isActive ? 'border-sidebar-border bg-background/80' : 'border-sidebar-border/60 bg-background/50'}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate text-xs font-semibold leading-5 text-sidebar-foreground block min-w-0">{project.title}</span>
                            {project.isFavourite && <Star className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" />}
                          </div>
                          <p className="truncate text-[11px] leading-4 text-sidebar-foreground/50 block min-w-0 w-full" title={rawTopic}>{topic}</p>
                        </div>
                      </div>
                      {isActive && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />}
                    </button>

                    <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            type="button"
                            aria-label={`Project actions for ${project.title}`}
                            title={`Project actions for ${project.title}`}
                            className="h-6 w-6 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                          >
                            <MoreVertical className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="border border-sidebar-border bg-background/95 backdrop-blur-xl">
                          <DropdownMenuItem
                            onClick={() => handleProjectAction('favorite', project)}
                            className="text-xs cursor-pointer hover:bg-background/50"
                          >
                            <Star className={`w-3 h-3 mr-2 ${project.isFavourite ? 'fill-amber-500 text-amber-500' : ''}`} />
                            {project.isFavourite ? 'Unfavorite' : 'Favorite'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleProjectAction('duplicate', project)}
                            className="text-xs cursor-pointer hover:bg-background/50"
                          >
                            <Copy className="w-3 h-3 mr-2" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleProjectAction('archive', project)}
                            className="text-xs cursor-pointer hover:bg-background/50"
                          >
                            <Archive className="w-3 h-3 mr-2" />
                            Archive
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-foreground/10" />
                          <DropdownMenuItem
                            onClick={() => handleProjectAction('delete', project)}
                            className="text-xs cursor-pointer text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="w-3 h-3 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                )
              })}
            </section>

            {activeProjectId && (
              <section className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-sidebar-foreground/50">Chat sessions</p>
                  <span className="rounded-full border border-sidebar-border bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-sidebar-foreground/60">
                    {chats.length}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleNewSession}
                  disabled={createChat.isPending}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-sidebar-border/80 px-3 py-2 text-xs font-medium text-sidebar-foreground/70 transition-all duration-200 hover:border-sidebar-foreground/30 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground active:scale-[0.98] disabled:opacity-50 cursor-pointer"
                >
                  {createChat.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="h-4 w-4" />
                  )}
                  New session
                </button>

                {chatsLoading && (
                  <div className="space-y-1.5">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <Skeleton key={i} className="h-11 w-full rounded-xl" />
                    ))}
                  </div>
                )}

                {!chatsLoading && chats.length === 0 && (
                  <p className="rounded-xl border border-dashed border-sidebar-border px-3 py-3 text-center text-xs text-sidebar-foreground/45">
                    No sessions yet
                  </p>
                )}

                <div className="space-y-1">
                  {chats.map((chat) => {
                    const isActiveChat = activeChatId === chat._id
                    const isRenaming = renamingChatId === chat._id
                    return (
                      <div key={chat._id} className="group flex items-center gap-0.5 rounded-xl w-full min-w-0 overflow-hidden">
                        {isRenaming ? (
                          <Input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRenameChat()
                              if (e.key === 'Escape') setRenamingChatId(null)
                            }}
                            onBlur={commitRenameChat}
                            className="h-9 flex-1 rounded-xl border-sidebar-border bg-background/70 px-2.5 text-xs text-sidebar-foreground"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSelectChat(chat._id)}
                            className={`flex-1 min-w-0 overflow-hidden flex items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-all duration-200 cursor-pointer select-none active:scale-[0.99] ${
                              isActiveChat
                                ? 'bg-sidebar-accent text-sidebar-foreground shadow-sm'
                                : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                            }`}
                          >
                            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 overflow-hidden">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate text-xs font-semibold leading-5 block min-w-0">{chat.title}</span>
                                {chat.pinned && <Star className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" />}
                              </span>
                              <span className="truncate block text-[10px] leading-4 text-sidebar-foreground/50">
                                {chat.messageCount} messages · {formatRelativeTime(chat.lastMessageAt)}
                              </span>
                            </span>
                          </button>
                        )}

                        {!isRenaming && (
                          <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  type="button"
                                  aria-label={`Session actions for ${chat.title}`}
                                  title={`Session actions for ${chat.title}`}
                                  className="h-6 w-6 rounded-md text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                                >
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="border border-sidebar-border bg-background/95 backdrop-blur-xl">
                                <DropdownMenuItem
                                  onClick={() => startRenameChat(chat)}
                                  className="text-xs cursor-pointer hover:bg-background/50"
                                >
                                  <Pencil className="w-3 h-3 mr-2" />
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuSeparator className="bg-foreground/10" />
                                <DropdownMenuItem
                                  onClick={() => setDeleteChatTarget(chat)}
                                  className="text-xs cursor-pointer text-destructive hover:bg-destructive/10"
                                >
                                  <Trash2 className="w-3 h-3 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-sidebar-foreground/50">Views</p>
              </div>

              <div className="space-y-1">
                {VIEW_ITEMS.map((tab) => {
                  const Icon = tab.icon
                  const isActiveTab = activeTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                        isActiveTab
                          ? 'bg-sidebar-accent text-sidebar-foreground shadow-sm'
                          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/55 hover:text-sidebar-foreground'
                      }`}
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${isActiveTab ? 'border-sidebar-border bg-background/80' : 'border-sidebar-border/80 bg-background/70'}`}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 font-medium">{tab.label}</span>
                      {isActiveTab && <ChevronRight className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />}
                    </button>
                  )
                })}
              </div>
            </section>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-sidebar-border/80 p-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className={`flex h-9 w-full items-center gap-2 rounded-xl px-3 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent ${sidebarCollapsed ? 'justify-center px-0' : ''}`}
          title="Settings"
          aria-label="Open settings"
        >
          <Settings className="h-4 w-4" />
          {!sidebarCollapsed && 'Settings'}
        </Button>
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="bg-background/95 backdrop-blur-xl border-foreground/10">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${deleteTarget?.title ?? ''}" and all of its data will be permanently removed. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteProject.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteProject.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Chat Session Confirmation */}
      <AlertDialog open={!!deleteChatTarget} onOpenChange={(open) => !open && setDeleteChatTarget(null)}>
        <AlertDialogContent className="bg-background/95 backdrop-blur-xl border-foreground/10">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat session?</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${deleteChatTarget?.title ?? ''}" and its messages will be permanently removed. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteChat}
              disabled={deleteChatMutation.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteChatMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
