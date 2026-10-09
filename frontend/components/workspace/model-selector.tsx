'use client'

import React from 'react'
import { Sparkles, ChevronDown, Check, Cpu, Zap } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ModelOption {
  id: string
  name: string
  provider: string
  badge?: string
  description: string
  icon?: typeof Cpu
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI', badge: 'Your key',
    description: 'Design pipeline using your OpenAI API key.', icon: Sparkles,
  },
  {
    id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', provider: 'OpenAI', badge: 'Your key',
    description: 'Smaller GPT model using your OpenAI API key.', icon: Zap,
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'GPT-OSS 120B',
    provider: 'Groq',
    badge: 'Flagship',
    description: 'Deep architectural reasoning and highest synthesis quality.',
    icon: Sparkles,
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'GPT-OSS 20B',
    provider: 'Groq',
    badge: 'Fast & Efficient',
    description: 'Ultra fast, lighter token footprint — recommended if hitting 429 limits.',
    icon: Zap,
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Qwen 3.8 27B',
    provider: 'Groq',
    badge: 'Balanced',
    description: 'High precision structured breakdown and circuit logic.',
    icon: Cpu,
  },
]

export const DEFAULT_MODEL_ID = 'openai/gpt-oss-120b'

interface ModelSelectorProps {
  value?: string
  onChange: (modelId: string) => void
  disabled?: boolean
  className?: string
}

export function ModelSelector({
  value = DEFAULT_MODEL_ID,
  onChange,
  disabled = false,
  className = '',
}: ModelSelectorProps) {
  const current = AVAILABLE_MODELS.find((m) => m.id === value) || AVAILABLE_MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={disabled}
        aria-label="Select AI Model"
        className={`group flex items-center gap-1.5 rounded-full border border-foreground/15 bg-background/85 px-3 py-1.5 text-xs font-medium text-foreground/90 backdrop-blur-md transition-all duration-200 hover:border-foreground/35 hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      >
        <Sparkles className="h-3.5 w-3.5 text-sky-400 shrink-0 transition-transform group-hover:scale-110" />
        <span className="font-medium tracking-tight truncate max-w-[110px] sm:max-w-[140px]">
          {current.name}
        </span>
        <ChevronDown className="h-3 w-3 opacity-50 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="w-[300px] rounded-2xl border border-border/80 bg-background/95 p-1.5 shadow-2xl backdrop-blur-2xl animate-in fade-in-50 zoom-in-95"
      >
        <div className="flex items-center justify-between px-2.5 py-1.5">
          <DropdownMenuLabel className="p-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            AI Engine Model
          </DropdownMenuLabel>
          <span className="text-[10px] text-muted-foreground/60 font-mono">{current.provider}</span>
        </div>

        <DropdownMenuSeparator className="my-1 bg-border/60" />

        <div className="space-y-1">
          {AVAILABLE_MODELS.map((model) => {
            const isSelected = model.id === current.id
            const Icon = model.icon || Cpu
            return (
              <DropdownMenuItem
                key={model.id}
                onClick={() => onChange(model.id)}
                className={`flex items-start gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-secondary/90 text-foreground font-medium'
                    : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground'
                }`}
              >
                <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {isSelected ? (
                    <Check className="h-4 w-4 text-sky-400" />
                  ) : (
                    <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">{model.name}</span>
                    {model.badge && (
                      <span className="rounded-full bg-primary/10 border border-primary/20 px-1.5 py-0.2 text-[9px] font-medium text-sky-400">
                        {model.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground line-clamp-2">
                    {model.description}
                  </p>
                </div>
              </DropdownMenuItem>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
