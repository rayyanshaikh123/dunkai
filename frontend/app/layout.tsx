import React from "react"
import type { Metadata, Viewport } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { Figtree, Google_Sans_Code } from "next/font/google"
import './globals.css'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthProvider } from '@/lib/auth-context'
import { QueryProvider } from '@/lib/query-provider'
import { PageTransition } from '@/components/page-transition'
import { Toaster } from '@/components/ui/sonner'

// Figtree stands in for Google Sans, which next/font cannot load: same open,
// geometric shapes. It sets both body text and headings (`font-display`).
const sans = Figtree({
  subsets: ["latin"],
  variable: "--font-sans-face",
  display: "swap",
})

const mono = Google_Sans_Code({
  subsets: ["latin"],
  variable: "--font-mono-face",
  display: "swap",
})

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'DunkAI — Describe a device. Get a board.',
    template: '%s · DunkAI',
  },
  description:
    'DunkAI is a hardware copilot: six AI agents turn a plain-language idea into requirements, architecture, a BOM, a PCB, validation and firmware.',
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
  openGraph: {
    title: 'DunkAI — Describe a device. Get a board.',
    description: 'Six AI agents turn a hardware idea into a complete engineering package.',
    type: 'website',
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1014' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`bg-background ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      {/* Browser extensions (Grammarly and others) add attributes to <body>
          before React hydrates, which it reports as a mismatch. This covers
          attributes on <body> itself only; its children are still checked. */}
      <body className="font-sans antialiased" suppressHydrationWarning>
        <noscript>
          <style>{'[aria-label^="Loading DunkAI"]{display:none!important}html{overflow:auto!important}'}</style>
        </noscript>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <QueryProvider>
            <AuthProvider>
              {children}
              <PageTransition />
            </AuthProvider>
          </QueryProvider>
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
        {/* Vercel Analytics only exists on Vercel; elsewhere its script 404s. */}
        {process.env.VERCEL ? <Analytics /> : null}
      </body>
    </html>
  )
}
