/** @type {import('next').NextConfig} */

// Where the Express backend lives, as seen from the Next.js server. Read when
// the config loads, which for a standalone build is at `next build` — so set
// BACKEND_URL in the build environment, not only at runtime.
const backendUrl = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/+$/, '')

const nextConfig = {
  // The repository carries its own project guidance; avoid generating extra
  // untracked agent files every time a developer starts Next locally.
  agentRules: false,
  // A self-contained server in .next/standalone, for the Docker image.
  // Vercel ignores this and builds its own output.
  output: 'standalone',
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        // API calls stay same-origin, so the auth cookies are first-party
        // and no CORS preflight is needed.
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        // Authenticated board and upload routes stay same-origin, so cookies
        // accompany artifact requests through the Vercel rewrite.
        source: '/uploads/:path*',
        destination: `${backendUrl}/uploads/:path*`,
      },
    ]
  },
}

export default nextConfig
