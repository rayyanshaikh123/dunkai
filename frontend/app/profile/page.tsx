'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Lock, Save, User as UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ProtectedRoute } from '@/components/layouts/protected-route'
import { useAuth } from '@/lib/auth-context'
import { authApi, ApiError } from '@/lib/axios-client'
import { toast } from 'sonner'

function ProfileContent() {
  const { user, updateProfile, logout } = useAuth()
  const router = useRouter()

  const [name, setName] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    if (user) setName(user.name)
  }, [user])

  if (!user) return null

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || name.trim() === user.name) return
    setSavingProfile(true)
    try {
      await updateProfile({ name: name.trim() })
      toast.success('Profile updated')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update profile')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters')
      return
    }
    setChangingPassword(true)
    try {
      await authApi.changePassword(currentPassword, newPassword)
      toast.success('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to change password')
    } finally {
      setChangingPassword(false)
    }
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await logout()
    } catch {
      setLoggingOut(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <div className="absolute top-0 right-1/3 w-[800px] h-[800px] bg-foreground/2 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] bg-foreground/2 rounded-full blur-3xl animate-pulse" style={{ animationDuration: '12s' }} />
      </div>

      <div className="mx-auto max-w-2xl px-4 py-10">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Back to workspace"
            onClick={() => router.push('/workspace')}
            className="h-9 w-9 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Account settings</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Manage your profile and security preferences</p>
          </div>
          <Link href="/" className="ml-auto flex items-center gap-2 hover:opacity-80 transition-opacity">
            <Image src="/logo.png" alt="DunkAI" width={27} height={22} className="h-[22px] w-auto" />
            <span className="font-display text-lg tracking-tight">DunkAI</span>
          </Link>
        </div>

        {/* Identity Card */}
        <Card className="mb-6 bg-secondary/30 border-foreground/10">
          <CardContent className="flex items-center gap-4 p-6">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.avatar || ''} alt={user.name} />
              <AvatarFallback className="text-lg bg-foreground/10 text-foreground">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold truncate">{user.name}</p>
              <p className="text-sm text-muted-foreground truncate">{user.email}</p>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase tracking-wider border-foreground/20">
                  Prepaid credits
                </Badge>
                <Badge variant="outline" className="text-[10px] uppercase tracking-wider border-foreground/20">
                  {user.provider === 'google' ? 'Google account' : 'Email account'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Edit Profile */}
        <Card className="mb-6 bg-secondary/30 border-foreground/10">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserIcon className="h-4 w-4 text-muted-foreground" />
              Profile
            </CardTitle>
            <CardDescription className="text-xs">Update your display name.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div>
                <label htmlFor="name" className="mb-2 block text-xs font-medium">Full name</label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 rounded-xl bg-secondary/50"
                  disabled={savingProfile}
                />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium">Email</label>
                <Input value={user.email} disabled className="h-11 rounded-xl bg-secondary/30 text-muted-foreground" />
                <p className="mt-1.5 text-[11px] text-muted-foreground">Email cannot be changed.</p>
              </div>
              <Button
                type="submit"
                disabled={savingProfile || !name.trim() || name.trim() === user.name}
                className="h-10 rounded-xl bg-foreground text-background hover:bg-foreground/90"
              >
                {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save changes
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Change Password (local accounts only) */}
        {user.provider !== 'google' && (
          <Card className="mb-6 bg-secondary/30 border-foreground/10">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Lock className="h-4 w-4 text-muted-foreground" />
                Change password
              </CardTitle>
              <CardDescription className="text-xs">Use at least 8 characters.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div>
                  <label htmlFor="current" className="mb-2 block text-xs font-medium">Current password</label>
                  <Input
                    id="current"
                    type="password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="h-11 rounded-xl bg-secondary/50"
                    disabled={changingPassword}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="new" className="mb-2 block text-xs font-medium">New password</label>
                    <Input
                      id="new"
                      type="password"
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="h-11 rounded-xl bg-secondary/50"
                      disabled={changingPassword}
                    />
                  </div>
                  <div>
                    <label htmlFor="confirm" className="mb-2 block text-xs font-medium">Confirm new password</label>
                    <Input
                      id="confirm"
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="h-11 rounded-xl bg-secondary/50"
                      disabled={changingPassword}
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                  className="h-10 rounded-xl bg-foreground text-background hover:bg-foreground/90"
                >
                  {changingPassword ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
                  Update password
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Logout */}
        <Card className="bg-secondary/30 border-destructive/20">
          <CardContent className="flex items-center justify-between p-6">
            <div>
              <p className="text-sm font-medium">Log out</p>
              <p className="text-xs text-muted-foreground mt-0.5">End your session on this device.</p>
            </div>
            <Button
              variant="outline"
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
            >
              {loggingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Log out
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  return (
    <ProtectedRoute>
      <ProfileContent />
    </ProtectedRoute>
  )
}
