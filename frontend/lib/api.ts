import { api, ApiError } from './axios-client'
import type { FirmwareBoardsResponse, FirmwareBuild } from './firmware/types'

const API_BASE = '/api/v1'

/**
 * Every call here goes through the shared axios instance in axios-client.ts.
 *
 * This module used to call fetch() directly, which skipped that instance's
 * 401 → /auth/refresh → retry handling. The access token lives 15 minutes, so
 * a chat message, board generation or code-chat turn sent after that failed
 * with "Invalid or expired access token" while the rest of the app (which
 * uses axios) quietly refreshed. The signature is unchanged so no caller moves.
 */
async function request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const { body } = options
  // The response interceptor unwraps `response.data.data`, so this resolves to T.
  return api.request({
    url: path,
    method: options.method || 'GET',
    data: body instanceof FormData ? body : typeof body === 'string' ? JSON.parse(body) : body ?? undefined,
  }) as Promise<T>
}

// ---- Auth API ----
export const authApi = {
  register: (name: string, email: string, password: string) =>
    request<{ user: unknown; accessToken: string; refreshToken: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ user: unknown; accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  refresh: () =>
    request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  me: () =>
    request<{ _id: string; name: string; email: string; avatar: string; role: string }>('/auth/me'),

  verifyEmail: (token: string) => request<{ verified: boolean }>('/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ token }),
  }),

  resendVerification: (email: string) => request('/auth/resend-verification', {
    method: 'POST', body: JSON.stringify({ email }),
  }),

  forgotPassword: (email: string) =>
    request('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  googleAuthUrl: () =>
    `${API_BASE}/auth/google`,
}

// ---- Firmware API ----
export const firmwareApi = {
  boards: (processingUnit?: string) =>
    request<FirmwareBoardsResponse>(
      `/firmware/boards${processingUnit ? `?${new URLSearchParams({ processingUnit })}` : ''}`
    ),

  compile: (projectId: string, boardId: string, files: { filename: string; code: string }[]) =>
    request<FirmwareBuild>('/firmware/compile', {
      method: 'POST',
      body: JSON.stringify({ projectId, boardId, files }),
    }),

  downloadUrl: (buildId: string) => `${API_BASE}/firmware/builds/${buildId}/download`,
}

// ---- Projects API ----
export const projectApi = {
  list: (params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString()
    return request<{ items: unknown[]; pagination: unknown }>(`/projects${query ? `?${query}` : ''}`)
  },

  get: (id: string) => request(`/projects/${id}`),

  create: (data: { title: string; description?: string; tags?: string[] }) =>
    request('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Record<string, unknown>) =>
    request(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request(`/projects/${id}`, { method: 'DELETE' }),

  archive: (id: string) =>
    request(`/projects/${id}/archive`, { method: 'POST' }),

  duplicate: (id: string) =>
    request(`/projects/${id}/duplicate`, { method: 'POST' }),

  toggleFavourite: (id: string) =>
    request(`/projects/${id}/favourite`, { method: 'POST' }),

  search: (q: string) =>
    request(`/projects/search?q=${encodeURIComponent(q)}`),

  recent: (limit = 5) =>
    request(`/projects/recent?limit=${limit}`),

  favourites: () => request('/projects/favourites'),
}

// ---- Chat API ----
export const chatApi = {
  create: (projectId: string, title?: string) =>
    request('/chats', {
      method: 'POST',
      body: JSON.stringify({ project: projectId, title }),
    }),

  list: (projectId: string) =>
    request(`/chats/project/${projectId}`),

  get: (chatId: string) =>
    request(`/chats/${chatId}`),

  messages: (chatId: string, page = 1, limit = 50) =>
    request(`/chats/${chatId}/messages?page=${page}&limit=${limit}`),

  sendMessage: (chatId: string, content: string, attachments: unknown[] = []) =>
    request(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, attachments }),
    }),

  rename: (chatId: string, title: string) =>
    request(`/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  // Persists this ONE chat session's pipeline artifacts (requirements,
  // architecture, bom, etc) — each session holds its own, not shared with
  // other sessions in the same project. See backend Chat.js/chat.service.js.
  updateArtifacts: (chatId: string, data: Record<string, unknown>) =>
    request(`/chats/${chatId}/artifacts`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  saveMessage: (chatId: string, type: 'user' | 'assistant', content: string, options?: string[]) =>
    request(`/chats/${chatId}/messages/save`, {
      method: 'POST',
      body: JSON.stringify({ type, content, options }),
    }),

  delete: (chatId: string) =>
    request(`/chats/${chatId}`, { method: 'DELETE' }),

  clearMessages: (chatId: string) =>
    request(`/chats/${chatId}/messages`, { method: 'DELETE' }),
}

// ---- AI API ----
export const aiApi = {
  chat: (projectId: string, message: string, agentType?: string) =>
    request('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ projectId, message, agentType }),
    }),

  codeChat: (projectId: string, files: any[], messages: any[], model?: string) =>
    request<{ reply: string; updated_files?: any[] }>('/ai/code-chat', {
      method: 'POST',
      body: JSON.stringify({ projectId, files, messages, model }),
    }),

  run: (data: { projectId?: string; agentType?: string; action?: string }) =>
    request('/ai/run', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  runStream: (data: {
    projectId?: string
    chatId?: string
    action?: string
    messages?: Array<{ role: string; content: string }>
    pcbIr?: Record<string, unknown>
    provider?: string
    model?: string
  }) =>
    request<{ jobId: string }>('/ai/run-stream', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Run dunkai-designer over an existing pcb_ir handoff.
   *
   * Same endpoint, same Socket.io relay and same jobId contract as the chat
   * pipeline — only the action differs. The server reads its persisted IR.
   *
   * `provider` and `model` are omitted when unset so the server-side
   * DESIGNER_PROVIDER default still applies; sending an explicit null would
   * override it with nothing.
   */
  generateBoard: (
    projectId: string,
    chatId: string | null,
    opts: { provider?: string; model?: string } = {}
  ) =>
    request<{ jobId: string }>('/ai/run-stream', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        ...(chatId ? { chatId } : {}),
        action: 'generate_board',
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      }),
    }),

  status: (jobId: string) => request(`/ai/status/${jobId}`),

  cancel: (jobId: string) =>
    request('/ai/cancel', {
      method: 'POST',
      body: JSON.stringify({ jobId }),
    }),

  projectArtifacts: (projectId: string) => request(`/ai/project/${projectId}`),

  /** Board generators as this user can use them: their own key, hosted, or not at all. */
  providers: () =>
    request<{
      boardProviders: Array<{
        id: string
        label: string
        available: boolean
        source: 'byok' | 'hosted' | null
        reason: string | null
      }>
      defaultBoardProvider: string | null
      chat: { byok: boolean; hosted: boolean | null }
      engineReachable: boolean
      localRuntimeEnabled?: boolean
      runtime?: RuntimeDevice | null
    }>('/ai/providers'),
}

// ---- Account (BYOK keys) ----
export type ByokProvider = 'groq' | 'gemini' | 'anthropic'

export interface ApiKeyStatus {
  provider: ByokProvider
  label: string
  powers: string
  configured: boolean
  masked: string | null
  verifiedAt: string | null
}

export const accountApi = {
  listKeys: () => request<ApiKeyStatus[]>('/account/keys'),
  /** Verified against the provider before it is stored; rejects with its reason. */
  saveKey: (provider: ByokProvider, key: string) =>
    request<ApiKeyStatus>(`/account/keys/${provider}`, { method: 'PUT', body: JSON.stringify({ key }) }),
  removeKey: (provider: ByokProvider) =>
    request<ApiKeyStatus>(`/account/keys/${provider}`, { method: 'DELETE' }),
}

// ---- Billing ----
export interface UsageSummary {
  billingEnabled: boolean
  meteringEnabled: boolean
  period: string
  wallet: WalletSummary
  usage: {
    hostedMessages: number
    hostedBoards: number
    byokMessages: number
    byokBoards: number
    projects: number
  }
}

export interface WalletSummary {
  currency: 'INR'
  trialAvailable: number
  paidAvailable: number
  reserved: number
  available: number
  freeChatsUsed: number
  freeChatsLimit: number
  freeAllowanceUnit: 'model_call' | 'design_chat'
  period: string
}

export interface PublicPlans {
  billingEnabled: boolean
  billingMode: 'disabled' | 'test' | 'live'
  meteringEnabled: boolean
  localRuntimeEnabled: boolean
  currency: 'INR'
  tariffVersion: number
  freeChatsPerMonth: number
  freeAllowanceUnit: 'model_call' | 'design_chat'
  freePipelineRunsPerChat: number
  freeBoardRunsPerChat: number
  trialCredits: number
  packs: Array<{ id: string; credits: number; amountPaise: number }>
  rates: { chat: number; inference: number | null; pipeline: number; board: number; byokPipeline: number; byokBoard: number }
}

export interface RuntimeDevice {
  id: string
  name: string
  mode: 'hosted' | 'byok'
  preferred: boolean
  connected: boolean
  ready: boolean
  expiresAt: string
  capabilities: { boardSandbox?: boolean; version?: string }
}
export const runtimeApi = {
  devices: () => request<{ localRuntimeEnabled: boolean; devices: RuntimeDevice[] }>('/runtime/devices'),
  approve: (code: string) => request<RuntimeDevice>('/runtime/pairing/approve', { method: 'POST', body: JSON.stringify({ code }) }),
  prefer: (id: string) => request<RuntimeDevice>(`/runtime/devices/${id}/prefer`, { method: 'POST' }),
  revoke: (id: string) => request(`/runtime/devices/${id}`, { method: 'DELETE' }),
  download: () => api.get<unknown, Blob>('/runtime/download', { responseType: 'blob' }),
}

export const billingApi = {
  plans: () => request<PublicPlans>('/billing/plans'),
  usage: () => request<UsageSummary>('/billing/usage'),
  wallet: () => request<WalletSummary>('/billing/wallet'),
  entries: () => request<Array<{ _id: string; kind: string; availableTrialDelta: number; availablePaidDelta: number; createdAt: string }>>('/billing/entries'),
  quote: (action: string, byok = false, chatId?: string) => request<{ credits: number; kind: string; included?: boolean }>(`/billing/quote?${new URLSearchParams({ action, byok: String(byok), ...(chatId ? { chatId } : {}) })}`),
  checkout: (packId: string) => request<{ url: string; orderId: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify({ packId }) }),
}

// ---- File API ----
export const fileApi = {
  upload: (file: File, projectId?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    if (projectId) formData.append('project', projectId)
    return request('/files', {
      method: 'POST',
      headers: {}, // Let browser set multipart content-type
      body: formData,
    })
  },

  list: (projectId: string) => request(`/files/project/${projectId}`),

  delete: (fileId: string) => request(`/files/${fileId}`, { method: 'DELETE' }),
}

// ---- Notification API ----
export const notificationApi = {
  list: (page = 1) => request(`/notifications?page=${page}`),
  unreadCount: () => request('/notifications/unread/count'),
  markAsRead: (id: string) => request(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllAsRead: () => request('/notifications/read-all', { method: 'PATCH' }),
}

export { ApiError }
