'use client'

import axios from 'axios'
import { toast } from 'sonner'
import type { User, Project, PaginatedResponse, AppNotification } from './types'

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errors: unknown[] = []
  ) {
    super(message)
  }
}

// Exported at the bottom; lib/api.ts uses it too, so both share one refresh-aware client.
const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
})

// ---- Request interceptor: handle FormData ----
api.interceptors.request.use((config) => {
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type']
  }
  return config
})

/** The backend's `{ message, errors }` body, as an ApiError the UI can read. */
function toApiError(error: { response?: { status?: number; data?: { message?: string; errors?: unknown[] } }; message?: string }) {
  const data = error.response?.data
  const message = data?.message || error.message || 'Network error'
  const status = error.response?.status || 500
  return new ApiError(status, message, data?.errors || [])
}

// ---- Response interceptor: unwrap data + auto refresh ----
let isRefreshing = false
let failedQueue: Array<{ resolve: (value: unknown) => void; reject: (reason?: unknown) => void }> = []

const processQueue = (error: unknown) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error)
    else resolve(undefined)
  })
  failedQueue = []
}

api.interceptors.response.use(
  (response) => response.config.responseType === 'blob' ? response.data : response.data.data,
  async (error) => {
    const originalRequest = error.config

    // Token expired — try to refresh once
    if (error.response?.status === 401 && !originalRequest._retry) {
      // Don't retry refresh/logout/login calls themselves. Rejected as an
      // ApiError like every other failure: rejecting with the raw response body
      // (a plain object) made the login page's `err instanceof Error` false, so
      // "Invalid email or password" was shown as a bare "Login failed".
      if (originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/login') || originalRequest.url?.includes('/auth/register')) {
        return Promise.reject(toApiError(error))
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then(() => api(originalRequest))
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        await api.post('/auth/refresh')
        processQueue(null)
        return api(originalRequest)
      } catch (refreshError) {
        processQueue(refreshError)
        if (typeof window !== 'undefined') {
          // Only force a redirect on protected pages — public pages (landing,
          // auth pages) must stay where they are for anonymous visitors
          const currentPath = window.location.pathname
          const isProtected = ['/workspace', '/profile', '/settings'].some((p) => currentPath.startsWith(p))
          if (isProtected) {
            window.location.href = '/login'
          }
        }
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    const failure = toApiError(error)
    if (failure.statusCode === 402 && typeof window !== 'undefined') {
      toast.error(failure.message, {
        id: failure.message,
        description: 'Add credits or use your own Groq key in Settings to continue.',
      })
    }
    return Promise.reject(failure)
  }
)

// ---- Auth API ----
export const authApi = {
  register: (name: string, email: string, password: string) =>
    api.post<unknown, { user: User; accessToken: string; refreshToken: string }>('/auth/register', {
      name,
      email,
      password,
    }),

  login: (email: string, password: string) =>
    api.post<unknown, { user: User; accessToken: string; refreshToken: string }>('/auth/login', {
      email,
      password,
    }),

  logout: () => api.post('/auth/logout'),

  refresh: () => api.post('/auth/refresh'),

  me: () => api.get<unknown, User>('/auth/me'),

  updateProfile: (data: { name?: string; avatar?: string }) =>
    api.put<unknown, User>('/auth/profile', data),

  forgotPassword: (email: string) => api.post('/auth/forgot-password', { email }),

  resetPassword: (token: string, password: string) =>
    api.post('/auth/reset-password', { token, password }),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),

  googleAuthUrl: () => '/api/v1/auth/google',
}

// ---- Projects API ----
export const projectApi = {
  list: (params: Record<string, string | number> = {}) =>
    api.get<unknown, PaginatedResponse<Project>>('/projects', { params }),

  get: (id: string) => api.get<unknown, Project>(`/projects/${id}`),

  create: (data: { title: string; description?: string; tags?: string[] }) =>
    api.post<unknown, Project>('/projects', data),

  update: (id: string, data: Partial<Project>) =>
    api.patch<unknown, Project>(`/projects/${id}`, data),

  delete: (id: string) => api.delete(`/projects/${id}`),

  archive: (id: string) => api.post<unknown, Project>(`/projects/${id}/archive`),

  duplicate: (id: string) => api.post<unknown, Project>(`/projects/${id}/duplicate`),

  toggleFavourite: (id: string) =>
    api.post<unknown, { isFavourite: boolean }>(`/projects/${id}/favourite`),

  search: (q: string) =>
    api.get<unknown, PaginatedResponse<Project>>('/projects/search', { params: { q } }),

  recent: (limit = 5) => api.get<unknown, Project[]>('/projects/recent', { params: { limit } }),

  favourites: () => api.get<unknown, Project[]>('/projects/favourites'),
}

// ---- Chat API ----
export const chatApi = {
  create: (projectId: string, title?: string) =>
    api.post('/chats', { project: projectId, title }),

  list: (projectId: string) => api.get(`/chats/project/${projectId}`),

  messages: (chatId: string, page = 1, limit = 50) =>
    api.get(`/chats/${chatId}/messages`, { params: { page, limit } }),

  sendMessage: (chatId: string, content: string, attachments: unknown[] = []) =>
    api.post(`/chats/${chatId}/messages`, { content, attachments }),

  rename: (chatId: string, title: string) => api.patch(`/chats/${chatId}`, { title }),

  delete: (chatId: string) => api.delete(`/chats/${chatId}`),
}

// ---- File API ----
export const fileApi = {
  upload: (file: File, projectId?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    if (projectId) formData.append('project', projectId)
    return api.post('/files', formData)
  },

  list: (projectId: string) => api.get(`/files/project/${projectId}`),

  delete: (fileId: string) => api.delete(`/files/${fileId}`),
}

// ---- Notification API ----
export const notificationApi = {
  list: (page = 1) => api.get<unknown, PaginatedResponse<AppNotification>>('/notifications', { params: { page } }),

  unreadCount: () => api.get<unknown, { count: number }>('/notifications/unread/count'),

  markAsRead: (id: string) => api.patch<unknown, AppNotification>(`/notifications/${id}/read`),

  markAllAsRead: () => api.patch('/notifications/read-all'),

  remove: (id: string) => api.delete(`/notifications/${id}`),
}

export { api }
