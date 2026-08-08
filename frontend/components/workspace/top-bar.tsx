'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  Share2,
  GitBranch,
  Bell,
  Settings,
  MoreVertical,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useWorkspaceStore } from '@/lib/store'
import { useProjects } from '@/hooks/use-projects'
import { useUnreadCount } from '@/hooks/use-notifications'
import { UserMenu } from './user-menu'
import { NotificationsModal } from './notifications-modal'
import { toast } from 'sonner'

export function TopBar() {
  const { activeProjectId } = useWorkspaceStore()
  const { data } = useProjects()
  const { data: unread } = useUnreadCount()
  const router = useRouter()
  const [showNotifications, setShowNotifications] = useState(false)

  const projects = data?.items || []
  const activeProject = projects.find((p) => p._id === activeProjectId)
  const unreadCount = unread?.count || 0

  const handleAction = (action: string) => {
    toast.info(`${action} — coming soon`)
  }

  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center justify-between gap-6 border-b border-foreground/10 bg-background/95 px-8 backdrop-blur-xl transition-all duration-500">
      {/* Left: Logo + Project Name */}
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <span className="font-display text-lg tracking-tight">DunkAI</span>
          <span className="font-mono text-[9px] tracking-wide text-muted-foreground mt-0.5">COPILOT</span>
        </Link>
        {activeProject && (
          <>
            <span className="text-muted-foreground/30">/</span>
            <span className="text-sm text-muted-foreground truncate">{activeProject.title}</span>
          </>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2 ml-auto">
        <ThemeToggle />

        {/* Share */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleAction('Share')}
          aria-label="Share project"
          title="Share project"
          className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-all duration-300 active:scale-90"
        >
          <Share2 className="w-4 h-4" />
        </Button>

        {/* Git */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleAction('Git')}
          aria-label="Open Git actions"
          title="Open Git actions"
          className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-all duration-300 active:scale-90"
        >
          <GitBranch className="w-4 h-4" />
        </Button>

        {/* Notifications */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setShowNotifications(true)}
          aria-label="Open notifications"
          title="Open notifications"
          className="relative h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-all duration-300 active:scale-90"
        >
          <Bell className="w-4 h-4" />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold text-background">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>

        {/* Settings */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push('/settings')}
          aria-label="Open settings"
          title="Open settings"
          className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-all duration-300 active:scale-90"
        >
          <Settings className="w-4 h-4" />
        </Button>

        {/* Project Actions Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Project actions"
              title="Project actions"
              className="h-10 w-10 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-all duration-300 active:scale-90"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-background/95 backdrop-blur-xl border border-foreground/10">
            <DropdownMenuItem
              onClick={() => handleAction('Export Design')}
              className="text-sm cursor-pointer hover:bg-background/50 transition-colors"
            >
              Export Design
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleAction('View History')}
              className="text-sm cursor-pointer hover:bg-background/50 transition-colors"
            >
              View History
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-foreground/10" />
            <DropdownMenuItem
              onClick={() => handleAction('Archive Project')}
              className="text-sm cursor-pointer text-destructive hover:bg-destructive/10 transition-colors"
            >
              Archive Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User Menu */}
        <UserMenu />
      </div>

      <NotificationsModal open={showNotifications} onOpenChange={setShowNotifications} />
    </header>
  )
}
