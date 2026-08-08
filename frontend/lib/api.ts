import type { ApiResponse } from './types'

const API_BASE = '/api/v1'

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errors: unknown[] = []
  ) {
    super(message)
  }
}

async function request<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  // Merge caller-provided headers if they're a plain object
  if (options.headers && typeof options.headers === 'object' && !(options.headers instanceof Headers)) {
    Object.assign(headers, options.headers)
  } else if (options.headers instanceof Headers) {
    options.headers.forEach((value, key) => {
      headers[key] = value
    })
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include', // Send cookies for auth
  })

  const data: ApiResponse<T> = await response.json().catch(() => ({
    success: false,
    message: 'Network error',
    data: null as T,
    errors: [],
    timestamp: new Date().toISOString(),
  }))

  if (!response.ok || !data.success) {
    const message = data.message || `Request failed with status ${response.status}`
    throw new ApiError(response.status, message, data.errors)
  }

  return data.data
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

  messages: (chatId: string, page = 1, limit = 50) =>
    request(`/chats/${chatId}/messages?page=${page}&limit=${limit}`),

  sendMessage: (chatId: string, content: string, attachments: unknown[] = []) =>
    request(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, attachments }),
    }),

  saveMessage: (chatId: string, type: 'user' | 'assistant', content: string, options?: string[]) =>
    request(`/chats/${chatId}/messages/save`, {
      method: 'POST',
      body: JSON.stringify({ type, content, options }),
    }),

  rename: (chatId: string, title: string) =>
    request(`/chats/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  delete: (chatId: string) =>
    request(`/chats/${chatId}`, { method: 'DELETE' }),
}

// ---- AI API ----
export const aiApi = {
  chat: (projectId: string, message: string, agentType?: string) =>
    request('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ projectId, message, agentType }),
    }),

  run: (data: { projectId?: string; agentType?: string; action?: string }) =>
    request('/ai/run', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  runStream: (data: { projectId?: string; action?: string; messages?: Array<{ role: string; content: string }> }) =>
    request<{ jobId: string }>('/ai/run-stream', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  status: (jobId: string) => request(`/ai/status/${jobId}`),

  cancel: (jobId: string) =>
    request('/ai/cancel', {
      method: 'POST',
      body: JSON.stringify({ jobId }),
    }),

  projectArtifacts: (projectId: string) => request(`/ai/project/${projectId}`),
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
