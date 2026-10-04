'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { authApi, ApiError } from './axios-client'
import type { User } from './types'

interface AuthContextValue {
  user: User | null
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  forgotPassword: (email: string) => Promise<void>
  loginWithGoogle: () => void
  clearError: () => void
  refreshUser: () => Promise<void>
  updateProfile: (data: { name?: string; avatar?: string }) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const userData = await authApi.me()
        setUser(userData)
      } catch {
        // Not authenticated
      } finally {
        setLoading(false)
      }
    }
    checkAuth()
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null)
      try {
        const result = await authApi.login(email, password)
        setUser(result.user)
        router.push((result.user as { isVerified?: boolean })?.isVerified
          ? '/workspace' : `/verify-email?email=${encodeURIComponent(email)}`)
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Login failed. Please try again.'
        setError(message)
        throw err
      }
    },
    [router]
  )

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      setError(null)
      try {
        const result = await authApi.register(name, email, password)
        setUser(result.user)
        router.push(`/verify-email?email=${encodeURIComponent(email)}`)
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Registration failed. Please try again.'
        setError(message)
        throw err
      }
    },
    [router]
  )

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // Ignore errors on logout
    } finally {
      setUser(null)
      router.push('/login')
    }
  }, [router])

  const forgotPassword = useCallback(async (email: string) => {
    setError(null)
    try {
      await authApi.forgotPassword(email)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Request failed. Please try again.'
      setError(message)
      throw err
    }
  }, [])

  const loginWithGoogle = useCallback(() => {
    window.location.href = authApi.googleAuthUrl()
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const userData = await authApi.me()
      setUser(userData)
    } catch {
      setUser(null)
    }
  }, [])

  const updateProfile = useCallback(async (data: { name?: string; avatar?: string }) => {
    setError(null)
    try {
      const updatedUser = await authApi.updateProfile(data)
      setUser(updatedUser)
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Profile update failed.'
      setError(message)
      throw err
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        login,
        register,
        logout,
        forgotPassword,
        loginWithGoogle,
        clearError,
        refreshUser,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
